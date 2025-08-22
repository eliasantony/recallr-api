import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import { v4 as uuidv4 } from "uuid";

import { extract, hostnameAllowed, transcribeWithASRLocalOrAPI } from "./scraper.mjs";
import { pool } from "./db.mjs";

import {
  callChatJSON,
  buildClassifierPrompt,
  buildRecipePrompt,
  cleanCaption,
  cleanTranscript,
  embedText,
  toPgVectorLiteral
} from "./pipeline.mjs";

// --- Optional GCS signer (only used by /media/sign) ---
let signGcsReadUrl = null;
try {
  // If your gcs.mjs exports `signGcsReadUrl(gsUri, { expiresSec })`, we’ll use it.
  const gcs = await import("./gcs.mjs");
  if (typeof gcs.signGcsReadUrl === "function") {
    signGcsReadUrl = gcs.signGcsReadUrl;
  }
} catch (_) { /* not fatal */ }

// --- AI config (OpenAI-compatible, used for search embeddings & legacy classify) ---
const AI_BASE_URL = process.env.AI_BASE_URL || "https://api.openai.com/v1";
const AI_MODEL = process.env.AI_MODEL || "gpt-5-mini";
const AI_EMBED_MODEL = process.env.AI_EMBED_MODEL || "text-embedding-3-small";
const AI_API_KEY = process.env.AI_API_KEY || "";
const ALLOW_INFERENCE_DEFAULT = String(process.env.ALLOW_INFERENCE_DEFAULT || "true").toLowerCase() === "true";

// --- App setup ---
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());
app.use(helmet());
app.use(morgan("dev"));

const PORT = process.env.PORT || 8080;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "downloads";
const COOKIES_FILE = process.env.COOKIES_FILE;
const ALLOW_DOWNLOAD = String(process.env.ALLOW_DOWNLOAD || "true").toLowerCase() === "true";
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const MAX_VIDEO_SECONDS = Number(process.env.MAX_VIDEO_SECONDS || 120);

// static serving for local testing
app.use("/media", express.static(path.resolve(DOWNLOAD_DIR)));

// basic rate limit on the heaviest unauthed route
app.use("/extract", rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false }));

app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ────────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────────
function b64(obj) { return Buffer.from(JSON.stringify(obj)).toString("base64url"); }
function unb64(s) { try { return JSON.parse(Buffer.from(String(s), "base64url").toString("utf8")); } catch { return null; } }

function buildSnippet(row, meta, analysis, recipe) {
  if (analysis?.summary) return analysis.summary;
  if (recipe?.title) return `Recipe: ${recipe.title}`;
  if (meta?.caption) return meta.caption.slice(0, 200);
  return row.title || row.url;
}

// ────────────────────────────────────────────────────────────────────────────────
// Core extract + classify (unchanged behavior, kept for completeness)
// ────────────────────────────────────────────────────────────────────────────────
app.post("/extract", async (req, res) => {
  try {
    const { url, downloadVideo = false, useCookies = true, wantTranscript = false, refresh = false } = req.body || {};
    if (!url || typeof url !== "string") return res.status(400).json({ error: "Missing 'url'." });
    if (ALLOWED_HOSTS.length && !hostnameAllowed(url, ALLOWED_HOSTS))
      return res.status(400).json({ error: "Host not allowed.", allowed: ALLOWED_HOSTS });
    if (downloadVideo && !ALLOW_DOWNLOAD) return res.status(403).json({ error: "Video downloading disabled." });

    const result = await extract(url, {
      downloadVideo,
      cookiesFile: useCookies ? COOKIES_FILE : undefined,
      downloadDir: DOWNLOAD_DIR,
      wantTranscript,
      refresh
    });

    const mediaUrl = result.video.downloaded_path ? `/media/${path.basename(result.video.downloaded_path)}` : null;
    const { raw, ...rest } = result;
    const { thumbnails: _dropThumbs, ...rawSansThumbs } = raw || {};
    const metaForWire = { ...rest, raw: rawSansThumbs, mediaUrl, paths: result.paths };

    res.json(metaForWire);
  } catch (err) {
    res.status(500).json({ error: err?.stderr?.toString?.() || err?.message || "Unknown error" });
  }
});

app.post("/classify-and-extract", async (req, res) => {
  try {
    const {
      url,
      downloadVideo = false,
      useCookies = true,
      wantTranscript = true,
      allow_inference = ALLOW_INFERENCE_DEFAULT,
      classify_only = false,
      refresh = false
    } = req.body || {};

    if (!url || typeof url !== "string") return res.status(400).json({ error: "Missing 'url'." });
    if (ALLOWED_HOSTS.length && !hostnameAllowed(url, ALLOWED_HOSTS))
      return res.status(400).json({ error: "Host not allowed.", allowed: ALLOWED_HOSTS });
    if (downloadVideo && !ALLOW_DOWNLOAD) return res.status(403).json({ error: "Video downloading disabled." });

    const meta = await extract(url, {
      downloadVideo,
      cookiesFile: useCookies ? COOKIES_FILE : undefined,
      downloadDir: DOWNLOAD_DIR,
      wantTranscript,
      refresh
    });

    if (wantTranscript && !meta.transcript && meta.video?.downloaded_path) {
      try {
        const asrText = await transcribeWithASRLocalOrAPI({ videoPath: meta.video.downloaded_path });
        if (asrText) meta.transcript = asrText;
      } catch (_) {}
    }

    const classification = await callChatJSON({
      system: "You are a content classifier. Output ONLY valid JSON per instructions.",
      user: buildClassifierPrompt({
        title: meta.title,
        caption: cleanCaption(meta.caption),
        transcript: cleanTranscript(meta.transcript)
      })
    });

    let recipe = null;
    if (!classify_only && classification?.content_type === "recipe") {
      recipe = await callChatJSON({
        system: "You extract recipes. Output ONLY valid JSON per schema.",
        user: buildRecipePrompt({ allowInference: !!allow_inference, meta })
      });
      recipe.recipe_id = recipe.recipe_id || `rec_${meta.post_id}`;
      recipe.source = { platform: meta.platform, url: meta.url, post_id: meta.post_id, ...(recipe.source || {}) };
    }

    if (recipe && meta.paths?.dir) {
      const recipePath = path.join(meta.paths.dir, "recipe.json");
      fs.writeFileSync(recipePath, JSON.stringify(recipe, null, 2), "utf8");
      recipe.__saved_path = recipePath;
    }

    const mediaUrl = meta.video.downloaded_path ? `/media/${path.basename(meta.video.downloaded_path)}` : null;
    const { raw, ...rest } = meta;
    const { thumbnails: _dropThumbs, ...rawSansThumbs } = raw || {};
    res.json({ ok: true, classification, recipe, meta: { ...rest, raw: rawSansThumbs, mediaUrl, paths: meta.paths } });
  } catch (err) {
    res.status(500).json({ error: err?.message || "AI classify/extract failed" });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// Jobs & ingest
// ────────────────────────────────────────────────────────────────────────────────
app.post("/ingest", async (req, res) => {
  try {
    const { url, allow_inference = true, refresh = false } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing url" });

    try {
      const meta = await extract(url, { downloadVideo: true, wantTranscript: false, refresh: false });
      if (meta?.duration_sec && meta.duration_sec > MAX_VIDEO_SECONDS) {
        return res.status(400).json({
          error: `Video too long (${meta.duration_sec}s > ${MAX_VIDEO_SECONDS}s).`
        });
      }
    } catch { /* ignore extract errors here */}

    // idempotent by URL unless refresh=true
    if (!refresh) {
      const existing = await pool.query(
        "SELECT id, status FROM jobs WHERE url=$1 ORDER BY created_at DESC LIMIT 1",
        [url]
      );
      if (existing.rows[0]) return res.json({ job_id: existing.rows[0].id, status: existing.rows[0].status });
    }

    const id = uuidv4();
    await pool.query(
      "INSERT INTO jobs (id, url, status, allow_inference) VALUES ($1,$2,'queued',$3)",
      [id, url, !!allow_inference]
    );
    res.json({ job_id: id, status: "queued" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/ingest/batch", async (req, res) => {
  try {
    const { urls = [], allow_inference = true, refresh = false } = req.body || {};
    if (!Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: "Provide urls[]" });

    const out = [];
    for (const url of urls) {
      if (!url) continue;
      if (!refresh) {
        const existing = await pool.query(
          "SELECT id, status FROM jobs WHERE url=$1 ORDER BY created_at DESC LIMIT 1",
          [url]
        );
        if (existing.rows[0]) { out.push({ url, job_id: existing.rows[0].id, status: existing.rows[0].status }); continue; }
      }
      const id = uuidv4();
      await pool.query(
        "INSERT INTO jobs (id, url, status, allow_inference) VALUES ($1,$2,'queued',$3)",
        [id, url, !!allow_inference]
      );
      out.push({ url, job_id: id, status: "queued" });
    }
    res.json({ jobs: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/jobs/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id,status,item_id,error,created_at,updated_at FROM jobs WHERE id=$1",
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Job not found" });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// recent jobs (for a small dashboard)
app.get("/jobs", async (req, res) => {
  try {
    const { status, limit = 50 } = req.query;
    const clauses = [];
    const params = [];
    if (status) { params.push(status); clauses.push(`status=$${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `SELECT id, url, status, item_id, error, created_at, updated_at
       FROM jobs ${where}
       ORDER BY created_at DESC
       LIMIT ${Number(limit) || 50}`,
      params
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rebuild a specific item (enqueue a refresh job)
app.post("/items/:id/rebuild", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT url FROM jobs WHERE item_id=$1 ORDER BY created_at DESC LIMIT 1", [req.params.id]);
    const url = rows[0]?.url;
    if (!url) return res.status(404).json({ error: "No original job for this item" });

    const id = uuidv4();
    await pool.query("INSERT INTO jobs (id, url, status, allow_inference) VALUES ($1,$2,'queued',TRUE)", [id, url]);
    res.json({ job_id: id, status: "queued" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────────────────
/** GET /items/:id -> one row + meta/recipe/analysis (compact) */
app.get("/items/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM items WHERE id=$1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Item not found" });

    const meta = await pool.query("SELECT body FROM item_json WHERE item_id=$1 AND kind='meta'", [req.params.id]);
    const recipe = await pool.query("SELECT body FROM item_json WHERE item_id=$1 AND kind='recipe'", [req.params.id]);
    const analysis = await pool.query("SELECT body FROM item_json WHERE item_id=$1 AND kind='analysis'", [req.params.id]);

    res.json({ item: rows[0], meta: meta.rows[0]?.body || null, recipe: recipe.rows[0]?.body || null, analysis: analysis.rows[0]?.body || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /items/:id/full -> same as /items/:id (kept for explicitness / future expansion) */
app.get("/items/:id/full", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM items WHERE id=$1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Item not found" });

    const meta = await pool.query("SELECT body FROM item_json WHERE item_id=$1 AND kind='meta'", [req.params.id]);
    const recipe = await pool.query("SELECT body FROM item_json WHERE item_id=$1 AND kind='recipe'", [req.params.id]);
    const analysis = await pool.query("SELECT body FROM item_json WHERE item_id=$1 AND kind='analysis'", [req.params.id]);

    res.json({ item: rows[0], meta: meta.rows[0]?.body || null, analysis: analysis.rows[0]?.body || null, recipe: recipe.rows[0]?.body || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /items/:id/analysis */
app.get("/items/:id/analysis", async (req, res) => {
  try {
    const r = await pool.query("SELECT body FROM item_json WHERE item_id=$1 AND kind='analysis'", [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: "No analysis for this item" });
    res.json(r.rows[0].body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /items  -> keyset pagination + filters
 *  query: is_recipe?, platform?, topic?, after? (cursor), limit?
 */
app.get("/items", async (req, res) => {
  try {
    const { is_recipe, platform, topic, after, limit = 30 } = req.query;
    const clauses = [];
    const params = [];
    let cursorClause = "";
    let cursor;

    if (is_recipe !== undefined) { params.push(is_recipe === "true"); clauses.push(`is_recipe = $${params.length}`); }
    if (platform) { params.push(platform); clauses.push(`platform = $${params.length}`); }
    if (topic) { params.push(topic); clauses.push(`$${params.length} = ANY(topics)`); }

    if (after) {
      cursor = unb64(after);
      if (cursor?.created_at && cursor?.id) {
        params.push(cursor.created_at, cursor.id);
        cursorClause = ` AND (created_at, id) < ($${params.length-1}, $${params.length})`;
      }
    }

    const where = `WHERE 1=1 ${clauses.length ? " AND " + clauses.join(" AND ") : ""} ${cursorClause}`;
    const lim = Math.min(Math.max(Number(limit) || 30, 1), 100);

    const { rows } = await pool.query(
      `SELECT * FROM items
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ${lim + 1}`,
      params
    );

    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    const nextCursor = hasMore ? b64({ created_at: page[page.length - 1].created_at, id: page[page.length - 1].id }) : null;

    res.json({ items: page, next_cursor: nextCursor });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// facets
// GET /topics  -> [{topic, count}]
app.get("/topics", async (_req,res) => {
  const { rows } = await pool.query(`
    SELECT LOWER(UNNEST(topics)) AS topic, COUNT(*)::int
    FROM items
    GROUP BY 1
    HAVING LOWER(UNNEST(topics)) IS NOT NULL
    ORDER BY COUNT(*) DESC, topic ASC
    LIMIT 200
  `);
  res.json(rows);
});

// GET /platforms -> [{platform, count}]
app.get("/platforms", async (_req,res) => {
  const { rows } = await pool.query(`
    SELECT platform, COUNT(*)::int
    FROM items
    GROUP BY platform
    ORDER BY COUNT(*) DESC
  `);
  res.json(rows);
});

// GET /stats
app.get("/stats", async (_req,res) => {
  const [[items], [recipes], [withVec]] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS n FROM items"),
    pool.query("SELECT COUNT(*)::int AS n FROM items WHERE is_recipe"),
    pool.query("SELECT COUNT(*)::int AS n FROM items WHERE embedding IS NOT NULL")
  ]);
  const jobs = await pool.query(`
    SELECT status, COUNT(*)::int AS n
    FROM jobs
    GROUP BY status
  `);
  res.json({
    items: items.rows[0].n,
    recipes: recipes.rows[0].n,
    embeddings: withVec.rows[0].n,
    jobs: jobs.rows
  });
});

// GET /config
app.get("/config", (_req,res) => {
  res.json({
    use_gemini: String(process.env.USE_GEMINI||"true").toLowerCase()==="true",
    max_video_seconds: Number(process.env.MAX_VIDEO_SECONDS||120),
    allow_download: String(process.env.ALLOW_DOWNLOAD||"true").toLowerCase()==="true"
  });
});

// ────────────────────────────────────────────────────────────────────────────────
/** POST /search  { q, k?, is_recipe?, platform?, topic? } */
app.post("/search", async (req, res) => {
  try {
    const { q, k = 10, is_recipe, platform, topic } = req.body || {};
    if (!q) return res.status(400).json({ error: "Missing q" });

    const vec = await embedText(q);
    if (!Array.isArray(vec) || !vec.length) return res.status(500).json({ error: "Embedding failed" });
    const vecLiteral = toPgVectorLiteral(vec);

    const clauses = ["embedding IS NOT NULL"];
    const params = [vecLiteral];
    let idx = 2;

    if (is_recipe !== undefined) { clauses.push(`is_recipe = $${idx++}`); params.push(!!is_recipe); }
    if (platform) { clauses.push(`platform = $${idx++}`); params.push(platform); }
    if (topic) { clauses.push(`$${idx++} = ANY(topics)`); params.push(topic); }

    const where = `WHERE ${clauses.join(" AND ")}`;

    const { rows } = await pool.query(
      `
      SELECT id, title, platform, url, topics, is_recipe, author_name,
             published_at, created_at,
             (embedding <-> $1::vector) AS distance
      FROM items
      ${where}
      ORDER BY embedding <-> $1::vector
      LIMIT ${Number(k) || 10}
      `,
      params
    );

    // attach a small snippet from stored JSON
    const withSnippets = await Promise.all(rows.map(async r => {
      const meta = await pool.query("SELECT body FROM item_json WHERE item_id=$1 AND kind='meta'", [r.id]);
      const analysis = await pool.query("SELECT body FROM item_json WHERE item_id=$1 AND kind='analysis'", [r.id]);
      const recipe = await pool.query("SELECT body FROM item_json WHERE item_id=$1 AND kind='recipe'", [r.id]);
      const snippet = buildSnippet(r, meta.rows[0]?.body, analysis.rows[0]?.body, recipe.rows[0]?.body);
      return { ...r, distance: Number(r.distance), snippet };
    }));

    res.json({ q, k: Number(k) || 10, results: withSnippets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /collections {name,description?,color?} -> {id} */
app.post("/collections", async (req, res) => {
  try {
    const { name, description = null, color = null } = req.body || {};
    if (!name) return res.status(400).json({ error: "Missing name" });
    const id = uuidv4();
    await pool.query(
      "INSERT INTO collections (id,name,description,color) VALUES ($1,$2,$3,$4)",
      [id, name, description, color]
    );
    res.json({ id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /collections?page?&page_size? */
app.get("/collections", async (req, res) => {
  try {
    const pageSize = Math.min(Math.max(Number(req.query.page_size) || 20, 1), 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const offset = (page - 1) * pageSize;
    const { rows } = await pool.query(
      `SELECT id,name,description,color,created_at,updated_at
       FROM collections
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );
    res.json({ items: rows, page, page_size: pageSize });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /collections/:id */
app.get("/collections/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id,name,description,color,created_at,updated_at FROM collections WHERE id=$1",
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** PATCH /collections/:id {name?,description?,color?} */
app.patch("/collections/:id", async (req, res) => {
  try {
    const { name, description, color } = req.body || {};
    await pool.query(
      `UPDATE collections
       SET name=COALESCE($2,name),
           description=COALESCE($3,description),
           color=COALESCE($4,color),
           updated_at=now()
       WHERE id=$1`,
      [req.params.id, name ?? null, description ?? null, color ?? null]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** DELETE /collections/:id */
app.delete("/collections/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM collections WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /collections/:id/items?page?&page_size? */
app.get("/collections/:id/items", async (req, res) => {
  try {
    const pageSize = Math.min(Math.max(Number(req.query.page_size) || 24, 1), 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const offset = (page - 1) * pageSize;

    const { rows } = await pool.query(
      `SELECT i.id, i.title, i.platform, i.url, i.topics, i.is_recipe,
              i.author_name, i.published_at, i.created_at, i.thumb_url, i.summary
       FROM collection_items ci
       JOIN items i ON i.id = ci.item_id
       WHERE ci.collection_id=$1
       ORDER BY ci.added_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.id, pageSize, offset]
    );
    res.json({ items: rows, page, page_size: pageSize });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /collections/:id/items { item_id } */
app.post("/collections/:id/items", async (req, res) => {
  try {
    const { item_id } = req.body || {};
    if (!item_id) return res.status(400).json({ error: "Missing item_id" });
    await pool.query(
      "INSERT INTO collection_items (collection_id,item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [req.params.id, item_id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** DELETE /collections/:id/items/:item_id */
app.delete("/collections/:id/items/:item_id", async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM collection_items WHERE collection_id=$1 AND item_id=$2",
      [req.params.id, req.params.item_id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────────────────
// Optional: sign a GCS object for temporary read access.
// GET /media/sign?gcsUri=gs://bucket/path/to/file.mp4&expires=900
// ────────────────────────────────────────────────────────────────────────────────
app.get("/media/sign", async (req, res) => {
  try {
    const { gcsUri, expires = 900 } = req.query;
    if (!gcsUri || !String(gcsUri).startsWith("gs://"))
      return res.status(400).json({ error: "Provide gcsUri=gs://bucket/object" });

    if (!signGcsReadUrl)
      return res.status(400).json({ error: "Signer not configured. Implement signGcsReadUrl in gcs.mjs." });

    const url = await signGcsReadUrl(String(gcsUri), { expiresSec: Number(expires) || 900 });
    res.json({ url, expires_in: Number(expires) || 900 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✓ API http://localhost:${PORT}`);
  console.log(`✓ Media served from /media → ${DOWNLOAD_DIR}`);
});