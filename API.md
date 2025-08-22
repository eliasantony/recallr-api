# Social Extractor API

Base URL: `http://localhost:8080`

Authentication: none (dev). Consider adding an `Authorization: Bearer <key>` header in production.

---

## Health

**GET** `/health` → `{ ok, time }`

---

## Ingest & Jobs

**POST** `/ingest`  
Body: `{ url: string, allow_inference?: boolean, refresh?: boolean }`  
Resp: `{ job_id, status }`

**POST** `/ingest/batch`  
Body: `{ urls: string[], allow_inference?: boolean, refresh?: boolean }`  
Resp: `{ jobs: [{ url, job_id, status }] }`

**GET** `/jobs/:id` → latest status for a job.

**GET** `/jobs?status=&limit=` → recent jobs list.

**POST** `/items/:id/rebuild` → enqueues a fresh job for that item.

---

## Items

**GET** `/items/:id`  
Resp: `{ item, meta, analysis, recipe }` (all nullable except `item`)

**GET** `/items/:id/full`  
Same as `/items/:id`. Reserved for future expansion.

**GET** `/items/:id/analysis`  
Resp: the `analysis.json` body or 404.

**GET** `/items`  
Query params:
- `is_recipe=true|false`
- `platform=...`
- `topic=...`
- `limit=30` (max 100)
- `after=<cursor>` (opaque; from previous response)

Resp:
```jsonc
{
  "items": [ /* rows from items */ ],
  "next_cursor": "eyJjcmVhdGVkX2F0Ijoi...\" // null if end
}