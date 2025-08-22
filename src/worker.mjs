import "dotenv/config";
import { withTx, pool } from "./db.mjs";
import { runPipeline, toPgVectorLiteral, EMBED_DIM } from "./pipeline.mjs";

function pickThumb(meta) {
  const thumbs = meta?.raw?.thumbnails || [];
  if (!thumbs.length) return null;
  const best = thumbs
    .map(t => ({ ...t, w: t.width || 0 }))
    .sort((a,b) => b.w - a.w)[0];
  return best?.url || null;
}

function buildSummary({ meta, analysis, recipe }) {
  if (analysis?.summary) return analysis.summary;
  if (recipe?.title) return `Recipe: ${recipe.title}`;
  if (meta?.caption) return meta.caption.slice(0, 200);
  return meta?.title || meta?.url || "";
}

async function fetchNextJob() {
  const { rows } = await pool.query(`
    UPDATE jobs
    SET status='running', updated_at=now()
    WHERE id = (
      SELECT id FROM jobs WHERE status='queued'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *;
  `);
  return rows[0] || null;
}

async function upsertItem({ meta, analysis, classification, recipe, embedding }) {
  const topics = Array.isArray(analysis?.topics)
    ? analysis.topics
    : (Array.isArray(classification?.topics) ? classification.topics : []);
  const isRecipe = analysis?.content_type === "recipe"
    ? true
    : (classification?.content_type === "recipe");

  const thumb = pickThumb(meta);
  const summary = buildSummary({ meta, analysis, recipe });


  await withTx(async (client) => {
    await client.query(`
      INSERT INTO items (id, platform, url, title, author_name, published_at, topics, is_recipe, dir)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET
        platform=EXCLUDED.platform,
        url=EXCLUDED.url,
        title=EXCLUDED.title,
        author_name=EXCLUDED.author_name,
        published_at=EXCLUDED.published_at,
        topics=EXCLUDED.topics,
        is_recipe=EXCLUDED.is_recipe,
        dir=EXCLUDED.dir,
        thumb_url=EXCLUDED.thumb_url,
        summary=EXCLUDED.summary,
        updated_at=now()
    `, [
      meta.post_id,
      meta.platform,
      meta.url,
      meta.title,
      meta.author?.name || null,
      meta.published_at ? new Date(meta.published_at) : null,
      topics,
      !!isRecipe,
      meta.paths?.dir || "",
      thumb,
      summary
    ]);

    await client.query(`
      INSERT INTO item_json (item_id, kind, body)
      VALUES ($1,'meta',$2)
      ON CONFLICT (item_id,kind) DO UPDATE SET body=EXCLUDED.body
    `, [meta.post_id, meta]);

    if (analysis) {
      await client.query(`
        INSERT INTO item_json (item_id, kind, body)
        VALUES ($1,'analysis',$2)
        ON CONFLICT (item_id,kind) DO UPDATE SET body=EXCLUDED.body
      `, [meta.post_id, analysis]);
    }

    if (recipe) {
      await client.query(`
        INSERT INTO item_json (item_id, kind, body)
        VALUES ($1,'recipe',$2)
        ON CONFLICT (item_id,kind) DO UPDATE SET body=EXCLUDED.body
      `, [meta.post_id, recipe]);
    }
  });

  // vector update OUTSIDE the transaction
  if (embedding && embedding.length === EMBED_DIM) {
    try {
      const vecLiteral = toPgVectorLiteral(embedding); // "[...]" string
      await pool.query(
        "UPDATE items SET embedding = $1::vector, updated_at=now() WHERE id = $2",
        [vecLiteral, meta.post_id]
      );
    } catch (e) {
      console.warn("embedding update failed for", meta.post_id, e.message);
    }
  }
}

async function workOnce() {
  const job = await fetchNextJob();
  if (!job) return;

  const metaProbe = await extract(job.url, { downloadVideo: false, wantTranscript: false, refresh: false });
  const maxSec = Number(process.env.MAX_VIDEO_SECONDS || 120);
  if (metaProbe?.duration_sec && metaProbe.duration_sec > maxSec) {
    await pool.query("UPDATE jobs SET status='error', error=$2, updated_at=now() WHERE id=$1",
      [job.id, `Video too long (${metaProbe.duration_sec}s > ${maxSec}s)`]);
    return;
  }

  try {
    const USE_GEMINI = String(process.env.USE_GEMINI || "true").toLowerCase() === "true";
    const result = await runPipeline({
      url: job.url,
      downloadVideo: USE_GEMINI,     // need file for Gemini
      wantTranscript: !USE_GEMINI,   // Gemini reads audio; skip ASR when using Gemini
      allow_inference: job.allow_inference,
      refresh: false
    });

    await upsertItem(result);

    await pool.query("UPDATE jobs SET status='done', item_id=$2, updated_at=now() WHERE id=$1",
      [job.id, result.meta.post_id]);
  } catch (e) {
    await pool.query("UPDATE jobs SET status='error', error=$2, updated_at=now() WHERE id=$1",
      [job.id, e.message?.slice(0, 4000) || "failed"]);
  }
}

setInterval(() => { workOnce().catch(() => {}); }, 1500);
console.log("✓ Worker started");