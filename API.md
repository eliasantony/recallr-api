# API Documentation

This document provides comprehensive documentation for all API endpoints in the Recipe Scraper service.

## Base URL

The API runs on `http://localhost:8080` by default (configurable via `PORT` environment variable).

## Authentication

Currently, no authentication is required for API endpoints.

## Rate Limiting

- `/extract` endpoint: 20 requests per minute per IP

## Content Types

- Request: `application/json`
- Response: `application/json`

---

## Health & Configuration

### GET /health

Health check endpoint.

**Response:**

```json
{
  "ok": true,
  "time": "2025-08-22T10:30:00.000Z"
}
```

### GET /config

Get service configuration.

**Response:**

```json
{
  "use_gemini": true,
  "max_video_seconds": 120,
  "allow_download": true
}
```

---

## Content Extraction

### POST /extract

Extract metadata from a URL without AI processing.

**Request Body:**

```json
{
  "url": "string (required)",
  "downloadVideo": "boolean (default: false)",
  "useCookies": "boolean (default: true)",
  "wantTranscript": "boolean (default: false)",
  "refresh": "boolean (default: false)"
}
```

**Response:**

```json
{
  "platform": "youtube|tiktok|instagram",
  "url": "string",
  "post_id": "string",
  "title": "string",
  "caption": "string",
  "transcript": "string|null",
  "author": { "name": "string", "url": "string" },
  "duration_sec": "number|null",
  "published_at": "string|null",
  "video": {
    "downloaded": "boolean",
    "downloaded_path": "string|null"
  },
  "mediaUrl": "string|null",
  "paths": {
    "dir": "string",
    "transcript_txt": "string|null"
  },
  "raw": {
    "...": "provider raw metadata including thumbnails[] if available"
  }
}
```

### POST /classify-and-extract

Extract and classify content with AI processing.

**Request Body:**

```json
{
  "url": "string (required)",
  "downloadVideo": "boolean (default: false)",
  "useCookies": "boolean (default: true)",
  "wantTranscript": "boolean (default: true)",
  "allow_inference": "boolean (default: true)",
  "classify_only": "boolean (default: false)",
  "refresh": "boolean (default: false)"
}
```

**Response:**

```json
{
  "ok": true,
  "classification": {
    "content_type": "recipe|tutorial|travel|humor|product|other",
    "topics": ["string"],
    "confidence": "number"
  },
  "recipe": {
    "recipe_id": "string",
    "source": {
      "platform": "string",
      "url": "string",
      "post_id": "string"
    },
    "title": "string",
    "author": "string|null",
    "servings": "number|null",
    "total_time_minutes": "number|null",
    "ingredients": [
      {
        "name": "string",
        "quantity": "number|null",
        "unit": "string|null",
        "notes": "string|null"
      }
    ],
    "steps": [
      {
        "index": "number",
        "instruction": "string",
        "timer_minutes": "number|null"
      }
    ],
    "tags": ["string"],
    "confidence": {
      "ingredients": "number",
      "steps": "number",
      "servings": "number",
      "time": "number"
    },
    "provenance": {
      "servings": {
        "source": "caption|transcript|ocr|model|null",
        "confidence": "number|null"
      },
      "total_time_minutes": {
        "source": "caption|transcript|ocr|model|null",
        "confidence": "number|null"
      }
    },
    "flags": {
      "has_inferred_values": "boolean"
    }
  },
  "meta": "object"
}
```

---

## Job Management

### POST /ingest

Queue a URL for background processing.

**Request Body:**

```json
{
  "url": "string (required)",
  "allow_inference": "boolean (default: true)",
  "refresh": "boolean (default: false)"
}
```

**Response:**

```json
{
  "job_id": "uuid",
  "status": "queued"
}
```

### POST /ingest/batch

Queue multiple URLs for background processing.

**Request Body:**

```json
{
  "urls": ["string"],
  "allow_inference": "boolean (default: true)",
  "refresh": "boolean (default: false)"
}
```

**Response:**

```json
{
  "jobs": [
    {
      "url": "string",
      "job_id": "uuid",
      "status": "queued"
    }
  ]
}
```

### GET /jobs/:id

Get job status and details.

**Response:**

```json
{
  "id": "uuid",
  "status": "queued|running|done|error.",
  "item_id": "uuid|null",
  "error": "string|null",
  "created_at": "timestamp",
  "updated_at": "timestamp"
}
```

### GET /jobs

List recent jobs with optional filtering.

**Query Parameters:**

- `status`: Filter by job status
- `limit`: Number of jobs to return (default: 50, max: 50)

**Response:**

```json
[
  {
    "id": "uuid",
    "url": "string",
    "status": "string",
    "item_id": "uuid|null",
    "error": "string|null",
    "created_at": "timestamp",
    "updated_at": "timestamp"
  }
]
```

---

## Items

### GET /items

List items with pagination and filtering.

**Query Parameters:**

- `is_recipe`: Filter by recipe status (true/false)
- `platform`: Filter by platform
- `topic`: Filter by topic
- `after`: Cursor for pagination (base64 encoded)
- `limit`: Number of items (default: 30, max: 100)

**Response:**

```json
{
  "items": [
    {
      "id": "string",
      "title": "string",
      "platform": "string",
      "url": "string",
      "topics": ["string"],
      "is_recipe": "boolean",
      "author_name": "string|null",
      "published_at": "timestamp|null",
      "created_at": "timestamp",
      "thumb_url": "string|null",
      "summary": "string|null"
    }
  ],
  "next_cursor": "string|null"
}
```

### GET /items/:id

Get a single item with all associated data.

**Response:**

```json
{
  "item": {
    "id": "string",
    "title": "string",
    "platform": "string",
    "url": "string",
    "topics": ["string"],
    "is_recipe": "boolean",
    "author_name": "string|null",
    "published_at": "timestamp|null",
    "created_at": "timestamp",
    "thumb_url": "string|null",
    "summary": "string|null"
  },
  "meta": "object|null",
  "recipe": "object|null",
  "analysis": "object|null"
}
```

### GET /items/:id/full

Same as `/items/:id` (alias for future expansion).

### GET /items/:id/analysis

Get only the analysis data for an item.

**Response:**

```json
{
  "content_type": "string",
  "topics": ["string"],
  "summary": "string",
  "key_points": ["string"],
  "entities": ["string"],
  "screen_text": ["string"],
  "links": ["string"]
}
```

### POST /items/:id/rebuild

Queue a refresh job for an existing item.

**Response:**

```json
{
  "job_id": "uuid",
  "status": "queued"
}
```

---

## Search

### POST /search

Semantic search using embeddings.

**Request Body:**

```json
{
  "q": "string (required)",
  "k": "number (default: 10)",
  "is_recipe": "boolean (optional)",
  "platform": "string (optional)",
  "topic": "string (optional)"
}
```

**Response:**

```json
{
  "q": "string",
  "k": "number",
  "results": [
    {
      "id": "string",
      "title": "string",
      "platform": "string",
      "url": "string",
      "topics": ["string"],
      "is_recipe": "boolean",
      "author_name": "string|null",
      "published_at": "timestamp|null",
      "created_at": "timestamp",
      "distance": "number",
      "snippet": "string"
    }
  ]
}
```

---

## Collections

### POST /collections

Create a new collection.

**Request Body:**

```json
{
  "name": "string (required)",
  "description": "string (optional)",
  "color": "string (optional)"
}
```

**Response:**

```json
{
  "id": "uuid"
}
```

### GET /collections

List collections with pagination.

**Query Parameters:**

- `page`: Page number (default: 1)
- `page_size`: Items per page (default: 20, max: 100)

**Response:**

```json
{
  "items": [
    {
      "id": "uuid",
      "name": "string",
      "description": "string|null",
      "color": "string|null",
      "created_at": "timestamp",
      "updated_at": "timestamp"
    }
  ],
  "page": "number",
  "page_size": "number"
}
```

### GET /collections/:id

Get a single collection.

**Response:**

```json
{
  "id": "uuid",
  "name": "string",
  "description": "string|null",
  "color": "string|null",
  "created_at": "timestamp",
  "updated_at": "timestamp"
}
```

### PATCH /collections/:id

Update a collection.

**Request Body:**

```json
{
  "name": "string (optional)",
  "description": "string (optional)",
  "color": "string (optional)"
}
```

**Response:**

```json
{
  "ok": true
}
```

### DELETE /collections/:id

Delete a collection.

**Response:**

```json
{
  "ok": true
}
```

### GET /collections/:id/items

Get items in a collection.

**Query Parameters:**

- `page`: Page number (default: 1)
- `page_size`: Items per page (default: 24, max: 100)

**Response:**

```json
{
  "items": [
    {
      "id": "string",
      "title": "string",
      "platform": "string",
      "url": "string",
      "topics": ["string"],
      "is_recipe": "boolean",
      "author_name": "string|null",
      "published_at": "timestamp|null",
      "created_at": "timestamp",
      "thumb_url": "string|null",
      "summary": "string|null"
    }
  ],
  "page": "number",
  "page_size": "number"
}
```

### POST /collections/:id/items

Add an item to a collection.

**Request Body:**

```json
{
  "item_id": "string (required)"
}
```

**Response:**

```json
{
  "ok": true
}
```

### DELETE /collections/:id/items/:item_id

Remove an item from a collection.

**Response:**

```json
{
  "ok": true
}
```

---

## Analytics & Facets

### GET /topics

Get all topics with usage counts.

**Response:**

```json
[
  {
    "topic": "string",
    "count": "number"
  }
]
```

### GET /platforms

Get all platforms with usage counts.

**Response:**

```json
[
  {
    "platform": "string",
    "count": "number"
  }
]
```

### GET /stats

Get service statistics.

**Response:**

```json
{
  "items": "number",
  "recipes": "number",
  "embeddings": "number",
  "jobs": [
    {
      "status": "string",
      "n": "number"
    }
  ]
}
```

---

## Media

### GET /media/:filename

Serve static media files from local storage.

### GET /media/sign

Generate signed URLs for GCS objects (if configured).

**Query Parameters:**

- `gcsUri`: GCS URI (gs://bucket/path)
- `expires`: Expiration time in seconds (default: 900)

**Response:**

```json
{
  "url": "string",
  "expires_in": "number"
}
```

---

## Error Responses

All endpoints may return error responses in the following format:

```json
{
  "error": "string"
}
```

### Common HTTP Status Codes

- `200`: Success
- `400`: Bad Request (invalid parameters)
- `403`: Forbidden (feature disabled)
- `404`: Not Found
- `429`: Rate Limited
- `500`: Internal Server Error

---

## Environment Variables

Key environment variables that affect API behavior:

- `PORT`: Server port (default: 8080)
- `ALLOW_DOWNLOAD`: Enable video downloads (default: true)
- `ALLOWED_HOSTS`: Comma-separated list of allowed hostnames
- `USE_GEMINI`: Use Gemini for video analysis (default: true)
- `MAX_VIDEO_SECONDS`: Maximum video length (default: 120)
- `AI_BASE_URL`: OpenAI-compatible API base URL
- `AI_MODEL`: AI model for classification/extraction
- `AI_EMBED_MODEL`: Embedding model for search

---

## Usage Examples

### Extract a Recipe

```bash
curl -X POST http://localhost:8080/classify-and-extract \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=example",
    "wantTranscript": true,
    "allow_inference": true
  }'
```

### Search for Recipes

```bash
curl -X POST http://localhost:8080/search \
  -H "Content-Type: application/json" \
  -d '{
    "q": "chocolate cake recipe",
    "k": 5,
    "is_recipe": true
  }'
```

### Queue Background Processing

```bash
curl -X POST http://localhost:8080/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.tiktok.com/@user/video/123456789",
    "allow_inference": true
```
