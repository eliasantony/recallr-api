import "dotenv/config";
import { withTx, pool } from "./db.mjs";
import { runPipeline, toPgVectorLiteral, EMBED_DIM } from "./pipeline.mjs";
// import extract if it lives elsewhere
import { extract } from './scraper.mjs'

const WORKER_ID = process.env.WORKER_ID || `${process.pid}`;
const LEASE_SECONDS = Number(process.env.LEASE_SECONDS || 120);  // lease window
const HEARTBEAT_EVERY_MS = Number(process.env.HEARTBEAT_EVERY_MS || 15000);

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

/**
 * Atomically claim one queued (or stale-running) job.
 * Uses a CTE + SKIP LOCKED and sets a lease/heartbeat.
 */
async function fetchNextJob() {
  const { rows } = await pool.query(`
    WITH picked AS (
      SELECT id
      FROM jobs
      WHERE
        status = 'queued'
        OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < NOW()))
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE jobs j
    SET status = 'running',
        lease_owner = $1,
        lease_expires_at = NOW() + ($2 || ' seconds')::interval,
        last_heartbeat_at = NOW(),
        updated_at = NOW()
    FROM picked
    WHERE j.id = picked.id
    RETURNING j.*;
  `, [WORKER_ID, String(LEASE_SECONDS)]);
  return rows[0] || null;
}

/** Heartbeat: extend lease & mark activity while working */
async function sendHeartbeat(jobId) {
  await pool.query(`
    UPDATE jobs
    SET last_heartbeat_at = NOW(),
        lease_expires_at = NOW() + ($2 || ' seconds')::interval,
        updated_at = NOW()
    WHERE id = $1 AND status = 'running' AND lease_owner = $3
  `, [jobId, String(LEASE_SECONDS), WORKER_ID]);
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
    // BUGFIX: include thumb_url and summary in the INSERT column list
    await client.query(`
      INSERT INTO items (id, platform, url, title, author_name, published_at, topics, is_recipe, dir, thumb_url, summary)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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

  // start heartbeat pinger
  let hb;
  const startHeartbeat = () => {
    hb = setInterval(() => {
      sendHeartbeat(job.id).catch(() => {});
    }, HEARTBEAT_EVERY_MS);
  };
  const stopHeartbeat = () => hb && clearInterval(hb);

  try {
    startHeartbeat();

    // quick pre-probe for duration limits
    const metaProbe = await extract(job.url, { downloadVideo: false, wantTranscript: false, refresh: false });
    const maxSec = Number(process.env.MAX_VIDEO_SECONDS || 120);
    if (metaProbe?.duration_sec && metaProbe.duration_sec > maxSec) {
      await pool.query(`
        UPDATE jobs
        SET status='error',
            error=$2,
            updated_at=now(),
            lease_owner=NULL,
            lease_expires_at=NULL
        WHERE id=$1 AND lease_owner=$3 AND status='running'
      `, [job.id, `Video too long (${metaProbe.duration_sec}s > ${maxSec}s)`, WORKER_ID]);
      return;
    }

    const USE_GEMINI = String(process.env.USE_GEMINI || "true").toLowerCase() === "true";
    const result = await runPipeline({
      url: job.url,
      downloadVideo: USE_GEMINI,
      wantTranscript: !USE_GEMINI,
      allow_inference: job.allow_inference,
      refresh: false
    });

    await upsertItem(result);

    await pool.query(`
      UPDATE jobs
      SET status='done',
          item_id=$2,
          updated_at=now(),
          lease_owner=NULL,
          lease_expires_at=NULL
      WHERE id=$1 AND lease_owner=$3 AND status='running'
    `, [job.id, result.meta.post_id, WORKER_ID]);

  } catch (e) {
    // retry with attempts, otherwise error
    await pool.query(`
      UPDATE jobs
      SET
        attempts = attempts + 1,
        status = CASE WHEN attempts + 1 >= max_attempts THEN 'error' ELSE 'queued' END,
        error = LEFT($2, 1000),
        updated_at = NOW(),
        lease_owner = CASE WHEN attempts + 1 >= max_attempts THEN NULL ELSE NULL END,
        lease_expires_at = CASE WHEN attempts + 1 >= max_attempts THEN NULL ELSE NULL END
      WHERE id = $1 AND lease_owner = $3
    `, [job.id, (e?.message || String(e)).slice(0, 1000), WORKER_ID]);
  } finally {
    stopHeartbeat();
  }
}

setInterval(() => { workOnce().catch(() => {}); }, 1500);
console.log(`✓ Worker started (id=${WORKER_ID}, lease=${LEASE_SECONDS}s, hb=${HEARTBEAT_EVERY_MS}ms)`);