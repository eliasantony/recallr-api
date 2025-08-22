import fs from "node:fs";
import path from "node:path";
import { extract, transcribeWithASRLocalOrAPI } from "./scraper.mjs";
import { downscaleForGemini } from "./video.mjs";
import { uploadLocalFileToGCS } from "./gcs.mjs";
import { analyzeVideoGeneral, extractRecipeFromVideo } from "./gemini.mjs";



// --- tiny helpers (exported where useful) ---
export function clip(s, n = 4000) { if (!s) return ""; s = String(s); return s.length > n ? s.slice(0, n) : s; }

export function cleanCaption(raw, max = 1500) {
  if (!raw) return "";
  let c = String(raw);
  c = c.replace(/https?:\/\/\S+/g, ""); // strip URLs
  c = c.replace(/\s{2,}/g, " ").trim();
  return clip(c, max);
}

export function cleanTranscript(raw, max = 3500) {
  if (!raw) return "";
  let t = String(raw);
  t = t.replace(/^WEBVTT.*$/gmi, "")
       .replace(/^\d+\s*$/gm, "")
       .replace(/-->\s*\d{2}:\d{2}:\d{2}\.\d{3}.*/g, "")
       .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "")
       .replace(/<\/?c>/g, "")
       .replace(/<\/?[^>]+>/g, "")
       .replace(/[ \t]+\n/g, "\n")
       .replace(/\n{2,}/g, "\n");
  const lines = t.split("\n").map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const l of lines) if (!out.length || out[out.length - 1] !== l) out.push(l);
  t = out.join("\n");
  return clip(t, max).trim();
}

function buildAnalysisText(analysis) {
  if (!analysis) return "";
  const parts = [];
  if (analysis.summary) parts.push(analysis.summary);
  if (analysis.key_points?.length) parts.push("key points: " + analysis.key_points.join("; "));
  if (analysis.entities?.length) parts.push("entities: " + analysis.entities.join(", "));
  if (analysis.screen_text?.length) parts.push("screen: " + analysis.screen_text.join(" / "));
  if (analysis.topics?.length) parts.push("topics: " + analysis.topics.join(", "));
  if (analysis.links?.length) parts.push("links: " + analysis.links.join(", "));
  return parts.join("\n");
}

// server-side helper (e.g., in pipeline.mjs or a small util)
export function pickBestThumb(rawThumbs = []) {
  if (!Array.isArray(rawThumbs) || !rawThumbs.length) return null;
  // prefer explicit resolutions if present
  const scored = rawThumbs.map(t => {
    const u = t.url || "";
    let score = 0;
    // heuristics for YouTube:
    if (u.includes("maxresdefault")) score = 1000;
    else if (u.includes("hq720")) score = 900;
    else if (/\/hqdefault\./.test(u)) score = 800;
    else if (t.resolution) {
      const [w, h] = (t.resolution.split("x").map(Number));
      score = (w || 0) * (h || 0);
    }
    // webp is usually smaller; prefer jpg for broad compatibility
    if (u.endsWith(".webp")) score -= 5;
    return { ...t, score };
  });
  scored.sort((a,b) => b.score - a.score);
  return scored[0]?.url || null;
}

// --- AI config ---
const AI_BASE_URL   = process.env.AI_BASE_URL   || "https://api.openai.com/v1";
const AI_MODEL      = process.env.AI_MODEL      || "gpt-5-mini";
const AI_API_KEY    = process.env.AI_API_KEY    || "";
export const AI_EMBED_MODEL = process.env.AI_EMBED_MODEL || "text-embedding-3-small";
export const EMBED_DIM      = Number(process.env.EMBED_DIM || 1536);

// --- OpenAI-compatible JSON chat ---
export async function callChatJSON({ system, user }) {
  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(AI_API_KEY ? { Authorization: `Bearer ${AI_API_KEY}` } : {}) },
    body: JSON.stringify({
      model: AI_MODEL,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  });
  if (!res.ok) throw new Error(`AI HTTP ${res.status}: ${await res.text().catch(() => "...")}`);
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error("AI returned empty content");
  return JSON.parse(text);
}

// --- prompts (exported) ---
const CLASSIFIER_SCHEMA_TEXT = `{"content_type":"recipe|tutorial|travel|humor|product|other","topics":["string"],"confidence":0.0}`;
export function buildClassifierPrompt({ title, caption, transcript }) {
  return `Classify this social video post. Output ONLY this JSON:
${CLASSIFIER_SCHEMA_TEXT}

Title:
${clip(title,200)}

Caption:
${clip(caption,1200)}

Transcript (may be empty):
${clip(transcript,2000)}

Rules:
- recipe only if ingredients or clear cooking steps.
- topics: short lowercase keywords.
- confidence in [0,1].`;
}

const RECIPE_SCHEMA_TEXT = `{
  "recipe_id":"string",
  "source":{"platform":"string","url":"string","post_id":"string"},
  "title":"string",
  "author":"string|null",
  "servings":"number|null",
  "total_time_minutes":"number|null",
  "ingredients":[{"name":"string","quantity":"number|null","unit":"string|null","notes":"string|null"}],
  "steps":[{"index":"number","instruction":"string","timer_minutes":"number|null"}],
  "tags":["string"],
  "confidence":{"ingredients":"number","steps":"number","servings":"number","time":"number"},
  "provenance":{
    "servings":{"source":"caption|transcript|ocr|model|null","confidence":"number|null"},
    "total_time_minutes":{"source":"caption|transcript|ocr|model|null","confidence":"number|null"}
  },
  "flags":{"has_inferred_values":"boolean"}
}`;
export function buildRecipePrompt({ allowInference, meta }) {
  return `You extract recipes from social video posts. Output ONLY valid JSON matching this schema:
${RECIPE_SCHEMA_TEXT}

Inputs:
- Platform: ${meta.platform}
- URL: ${meta.url}
- Post ID: ${meta.post_id}
- Title: ${clip(meta.title,200)}
- Author: ${meta.author?.name || ""}

Caption:
${clip(cleanCaption(meta.caption),1500)}

Transcript (cleaned):
${clip(cleanTranscript(meta.transcript),3000)}

Requirements:
1) Normalize units (g, ml, tsp, tbsp, cup). Merge duplicates.
2) Number steps; infer timer_minutes only if explicit.
3) ${allowInference ? "MAY infer; mark provenance.source='model' and confidence ≤ 0.7; flags.has_inferred_values=true." : "Do NOT guess; unknowns stay null; flags.has_inferred_values=false."}
4) confidence.* in [0,1].`;
}

// --- embedding composition + API (exported) ---
export function buildItemEmbeddingText({ meta, recipe, classification }) {
  const parts = [];
  parts.push(meta?.title || "");
  parts.push(meta?.caption || "");
  if (classification?.topics?.length) parts.push("topics: " + classification.topics.join(", "));
  if (recipe) {
    parts.push("recipe title: " + (recipe.title || ""));
    if (recipe.ingredients?.length) {
      parts.push("ingredients: " + recipe.ingredients.map(i =>
        [i.quantity, i.unit, i.name, i.notes].filter(Boolean).join(" ")
      ).join("; "));
    }
    if (recipe.steps?.length) parts.push("steps: " + recipe.steps.map(s => s.instruction).join(" "));
    if (recipe.tags?.length) parts.push("tags: " + recipe.tags.join(", "));
  }
  return parts.join("\n").trim();
}

export async function embedText(text) {
  if (!text) return null;
  const r = await fetch(`${AI_BASE_URL}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(AI_API_KEY ? { Authorization: `Bearer ${AI_API_KEY}` } : {}) },
    body: JSON.stringify({ model: AI_EMBED_MODEL, input: text })
  });
  if (!r.ok) throw new Error(`embed HTTP ${r.status}: ` + await r.text());
  const j = await r.json();
  const vec = j?.data?.[0]?.embedding;
  if (!Array.isArray(vec) || !vec.length) return null;
  return vec;
}

// Convert JS number[] → pgvector text literal "[...]" (exported)
export function toPgVectorLiteral(vec) {
  if (!Array.isArray(vec) || !vec.length) return null;
  return `[${vec.join(",")}]`;
}

// --- main pipeline (exported) ---
export async function runPipeline({ url, downloadVideo=false, wantTranscript=true, allow_inference=true, refresh=false }) {
  const meta = await extract(url, { downloadVideo, wantTranscript, refresh });

  // ASR fallback if needed
  if (wantTranscript && !meta.transcript && meta.video?.downloaded_path) {
    try {
      const asr = await transcribeWithASRLocalOrAPI({ videoPath: meta.video.downloaded_path });
      if (asr) {
        const cleaned = cleanTranscript(asr);
        meta.transcript = cleaned;
        if (meta.paths?.dir) {
          fs.writeFileSync(path.join(meta.paths.dir, "transcript.txt"), cleaned, "utf8");
          meta.paths.transcript_txt = path.join(meta.paths.dir, "transcript.txt");
        }
      }
    } catch {}
  }

let analysis = null;
  let recipe = null;

  const USE_GEMINI = String(process.env.USE_GEMINI || "true").toLowerCase() === "true";
  if (USE_GEMINI && meta.video?.downloaded_path) {
    try {
      // 1) downscale & upload
      const downscaled = await downscaleForGemini(meta.video.downloaded_path); // returns local temp mp4
      const gsUri = await uploadLocalFileToGCS(downscaled, `videos/${meta.platform}-${meta.post_id}.mp4`);

      // 2) general understanding (for ANY content)
      analysis = await analyzeVideoGeneral({ gcsUri: gsUri, meta });

      // 3) if recipe, do a recipe pass
      if (analysis?.content_type === "recipe") {
        recipe = await extractRecipeFromVideo({ gcsUri: gsUri, meta, allowInference: allow_inference });
      }
    } catch (e) {
      console.warn("Gemini video path failed:", e.message);
    }
  }

  // Fallback: if no Gemini analysis, use your existing OpenAI classify/recipe
  if (!analysis) {
    const classification = await callChatJSON({
      system: "You are a content classifier. Output ONLY valid JSON per instructions.",
      user: buildClassifierPrompt({ title: meta.title, caption: cleanCaption(meta.caption), transcript: cleanTranscript(meta.transcript) })
    });
    analysis = {
      summary: null,
      topics: classification?.topics || [],
      entities: [],
      screen_text: [],
      key_points: [],
      links: [],
      content_type: classification?.content_type || "other",
      confidence: classification?.confidence ?? 0.5
    };
    if (analysis.content_type === "recipe") {
      recipe = await callChatJSON({
        system: "You extract recipes. Output ONLY valid JSON per schema.",
        user: buildRecipePrompt({ allowInference: !!allow_inference, meta })
      });
      recipe.recipe_id = recipe.recipe_id || `${meta.platform}:${meta.post_id}`;
      recipe.source = { platform: meta.platform, url: meta.url, post_id: meta.post_id, ...(recipe.source || {}) };
    }
  }

  // Save analysis.json if present
  if (analysis && meta.paths?.dir) {
    const ap = path.join(meta.paths.dir, "analysis.json");
    fs.writeFileSync(ap, JSON.stringify(analysis, null, 2), "utf8");
    analysis.__saved_path = ap; // convenience
    }

  // Save recipe.json if present
  if (recipe && meta.paths?.dir) {
    const p = path.join(meta.paths.dir, "recipe.json");
    fs.writeFileSync(p, JSON.stringify(recipe, null, 2), "utf8");
    recipe.__saved_path = p;
  }

  // Build embedding text (now includes analysis)
  let embedding = null;
  try {
    const analysisText = buildAnalysisText(analysis);
    const embedBlob = [
      meta.title || "",
      cleanCaption(meta.caption),
      cleanTranscript(meta.transcript),
      analysisText,
      recipe ? ("recipe title: " + (recipe.title || "")) : ""
    ].filter(Boolean).join("\n");
    embedding = await embedText(embedBlob);
    if (embedding && meta.paths?.dir) {
      fs.writeFileSync(path.join(meta.paths.dir, "embedding.json"), JSON.stringify({
        model: AI_EMBED_MODEL, dims: embedding.length,
        vector: embedding.map(x => Math.round(x * 1e6) / 1e6)
      }, null, 2), "utf8");
    }
  } catch (e) {
    console.warn("embed failed:", e.message);
  }

  return { meta, analysis, recipe, embedding };
}