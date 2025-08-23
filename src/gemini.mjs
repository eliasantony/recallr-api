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
  "screen_text":["string"],           // important on-screen text you read/OCR
  "links":["string"]                  // relevant links (e.g. recipes, products)
}

STRICT RULES
- Output JSON only (no prose, no code fences, no comments). Use double quotes and valid JSON.
- Choose ONE content_type from the list exactly as written.
- Write in the video’s language; if unclear, default to English.
- Use spoken audio, on-screen text (OCR), AND visuals; align key_points to evidence in the video.

CLASSIFICATION HINTS
- "recipe" (cooking/prep), "tutorial" (how-to/steps/tips), "travel" (lists of places, guides),
  "product" (features, specs, demos, comparisons), "news" (announcements/updates),
  "humor" (skits/jokes), "music" (performances), else "other".

TOPICS
- 3–8 concise, lowercase keywords (e.g., "vienna", "hidden-bars", "cheap-eats", "u-bahn").
- Prefer nouns over full phrases; no duplicates.

SUMMARY
- 1–3 sentences that capture goal + main takeaway (e.g., “Quick guide to 7 hidden bars in Vienna with price hints.”).

KEY_POINTS  (maximize usefulness for informational videos)
- Extract EVERY concrete item shown or stated (preserve order). One idea per item.
- For lists (e.g., “Top 7 …”), enumerate within the strings: "1) Place – why it matters / price / tip".
- Include numbers, times, prices, counts, model names, version numbers, or URLs when visible or spoken.
- For tutorials, capture steps/tips/requirements/pitfalls. For product videos, include features, specs, pros/cons, and claims.
- Avoid speculation. If you’re not sure, omit rather than guess.

ENTITIES
- Deduplicated, canonical names for products, brands, places, neighborhoods, people/handles.

SCREEN_TEXT
- Up to 10 of the most important overlays/callouts/prices/URLs, preferably verbatim, in chronological order.
- Skip trivial emojis/ornaments; keep meaning-changing text.

LINKS (broader extraction)
- Include explicit URLs visible in overlays/captions when present.
- ALSO add authoritative links for mentioned products, brands, places, apps, or tools even if no URL is shown:
  • Prefer the official website (https://brand.com or https://brand.com/product).
  • For open-source/tools, prefer the canonical GitHub repo or official docs.
  • For mobile apps, prefer the Apple App Store / Google Play listing.
  • For places, use an official site if clear; otherwise add a Google Maps search URL:
    https://www.google.com/maps/search/?api=1&query=<urlencoded name+city>
- If the exact target is ambiguous, add a generic web search URL instead of guessing a deep link:
  https://www.google.com/search?q=<urlencoded query>
- Use HTTPS, strip tracking params, avoid affiliate codes, deduplicate, and limit to ≤10 links.

VALIDATION
- Keep arrays when empty (["topics","key_points","entities","screen_text","links"] may be []).
- No trailing commas; ensure strings are not blank.
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

STRICT RULES
- Output JSON only (no prose, no code fences, no comments). Use double quotes and valid JSON.
- Use spoken audio AND on-screen text (OCR); avoid speculation.

INGREDIENTS (emoji requirement)
- Prefix the ingredient "name" with ONE most fitting food/kitchen emoji + a space, e.g., "🍅 tomato", "🧄 garlic", "🥛 milk".
- If no obvious emoji fits, use "🍽️" as a fallback.
- Put the emoji ONLY in the "name" field. Do NOT add emojis to "unit" or "notes".
- Keep "name" concise and canonical; move prep/brand details to "notes" (e.g., notes: "chopped", "unsalted").

UNITS & QUANTITIES
- Parse explicit numbers/units when stated (e.g., g, ml, tsp, tbsp, cup(s), piece(s)); otherwise leave quantity/unit as null.
- Do not merge quantity/unit into "name".

STEPS
- Imperative sentences (“Chop onions”, “Simmer 10 min”).
- Include "timer_minutes" ONLY when explicitly stated or shown on screen; else null.
- Keep order via "index" starting at 1.

TAGS
- Include cuisine, course, dietary constraints, key techniques, and main ingredients when stated or clear from visuals.

AUTHOR & IDs
- "author" is the creator/channel/handle if visible; else null.
- "recipe_id" should be a short slug from the title or post_id (no PII).

CONFIDENCE & PROVENANCE
- Confidence numbers between 0.0–1.0 reflecting extraction certainty.
- If you infer a value (only when allowed), set provenance.source="model" and confidence ≤ 0.7; flags.has_inferred_values=true.

INFERENCE POLICY
- Steps are imperative. Only add timers if explicitly stated/visible.
- ${allowInference
  ? "You MAY infer missing values; set provenance.source='model' and confidence ≤ 0.7; flags.has_inferred_values=true."
  : "Do NOT guess; unknowns remain null; flags.has_inferred_values=false."}

VALIDATION
- Keep all keys present. Arrays may be empty. No trailing commas. Strings are not blank.
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