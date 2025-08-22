# Social Extractor

Save & search short-form videos (YouTube/TikTok/IG) with AI:
- Downloads & normalizes metadata
- Gemini video analysis (summary, entities, on-screen text)
- Optional recipe extraction JSON
- pgvector embeddings + semantic search
- REST API for mobile/Flutter client

## Quick Start

### 1) Requirements
- Node 18+
- PostgreSQL 15+ with `pgvector` extension
- `yt-dlp`, `ffmpeg`
- (Optional) Google Cloud project + GCS bucket for Gemini video input/output

### 2) Install
```bash
npm i
psql -d recipes -c 'CREATE EXTENSION IF NOT EXISTS vector;'
node src/migrate.mjs
```

### 3) Env

Create .env:
```bash
PORT=8080
DOWNLOAD_DIR=downloads
ALLOWED_HOSTS=youtube.com, youtu.be, tiktok.com, instagram.com

# OpenAI-compatible embeddings (for pgvector)
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=sk-...
AI_MODEL=gpt-5-mini
AI_EMBED_MODEL=text-embedding-3-small
EMBED_DIM=1536

# Gemini path (processing handled in worker/pipeline)
USE_GEMINI=true
GOOGLE_APPLICATION_CREDENTIALS=./secrets/your-service-account.json
GCS_BUCKET=socialextractor_bucket
GCP_PROJECT_ID=your-project-id
GCP_LOCATION=eu
```

### 4) Run

```bash
# API
node src/server.mjs

# Background worker
node src/worker.mjs
```

### 5) Try it

```bash
# Enqueue a video
curl -s -X POST http://localhost:8080/ingest \
  -H "Content-Type: application/json" \
  -d '{"url":"https://youtube.com/shorts/XXXXXXXXXXX"}'

# Poll job
curl -s http://localhost:8080/jobs/<job_id>

# Browse items
curl -s "http://localhost:8080/items?is_recipe=true"
```

### API

## API

See [API.md](API.md) for the full reference.

### Design Notes

*   Two-pass analysis: general understanding for all videos; if `content_type` is `recipe`, a second pass extracts detailed `recipe.json`.
*   Embeddings: title + caption + transcript(clean) + analysis.summary + recipe text → pgvector column for fast ANN search.
*   Keyset pagination: `GET /items` returns `next_cursor` for stable infinite scroll.
*   Storage: `item_json` (kind in `meta` | `analysis` | `recipe`) keeps raw JSON payloads.

### Reprocessing

If prompts or models change:

*   Rebuild a single item: `POST /items/:id/rebuild`
*   Or write a small script to enqueue refresh jobs across your dataset.

### Production Hardening (later)

*   Auth (API key or JWT)
*   Signed media URLs (GCS) instead of `/media` static
*   Observability (job durations, errors, queue depth)
*   Backups & lifecycle for GCS objects

---