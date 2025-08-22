import { VertexAI } from "@google-cloud/vertexai";

const PROJECT_ID = process.env.GCLOUD_PROJECT;
const LOCATION   = process.env.GCLOUD_LOCATION || "us-central1";
const MODEL      = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

const vertexAI = new VertexAI({ project: PROJECT_ID, location: LOCATION });
const generativeModel = vertexAI.getGenerativeModel({ model: MODEL });

// --- General post extractor (works for ANY video, not just recipes) ---
export async function analyzeVideoGeneral({ gcsUri, meta }) {
  const system = `
You analyze short social videos (reels/shorts/tiktoks).
Return ONLY valid JSON with this schema:
{
  "content_type":"recipe|tutorial|travel|humor|product|news|music|other",
  "topics":["string"],                // short lowercase keywords
  "summary":"string",                 // 1-3 sentences
  "key_points":["string"],            // bulleted list of key things taught/shown
  "entities":["string"],              // products, places, people (as text)
  "screen_text":["string"],            // important on-screen text you read/OCR
  "links":["string"]                   // relevant links (e.g. recipes, products)
}
Rules:
- Read on-screen text AND reason about visuals & speech.
- Keep it concise and factual.
- Output JSON only.
`;

  const user = `
Platform: ${meta.platform}
URL: ${meta.url}
Post ID: ${meta.post_id}
Title: ${meta.title || ""}

Return JSON only.
`;

  const req = {
    systemInstruction: { role: "system", parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }, { fileData: { mimeType: "video/mp4", fileUri: gcsUri } }] }],
    generationConfig: { responseMimeType: "application/json" }
  };

  const r = await generativeModel.generateContent(req);
  const text = r.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error("Gemini general analysis empty");
  return JSON.parse(text);
}

// --- Recipe extractor (richer JSON for food) ---
export async function extractRecipeFromVideo({ gcsUri, meta, allowInference = true }) {
  const system = `
You extract recipes from social videos and return ONLY valid JSON:

{
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
}

Rules:
- Use spoken audio AND on-screen text.
- Steps are imperative. Only add timers if explicitly stated/visible.
- ${allowInference
  ? "You MAY infer missing values; set provenance.source='model' and confidence ≤ 0.7; flags.has_inferred_values=true."
  : "Do NOT guess; unknowns remain null; flags.has_inferred_values=false."}
- Output JSON only.
`;

  const user = `
Platform: ${meta.platform}
URL: ${meta.url}
Post ID: ${meta.post_id}
Title: ${meta.title || ""}

Return JSON only.
`;

  const req = {
    systemInstruction: { role: "system", parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }, { fileData: { mimeType: "video/mp4", fileUri: gcsUri } }] }],
    generationConfig: { responseMimeType: "application/json" }
  };

  const r = await generativeModel.generateContent(req);
  const text = r.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error("Gemini recipe response empty");
  return JSON.parse(text);
}