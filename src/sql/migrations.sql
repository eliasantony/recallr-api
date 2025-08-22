-- ensure extension exists in the recipes DB
CREATE EXTENSION IF NOT EXISTS vector;

-- items table (unchanged)
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  author_name TEXT,
  published_at TIMESTAMPTZ,
  topics TEXT[] DEFAULT '{}',
  is_recipe BOOLEAN DEFAULT FALSE,
  dir TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- embedding column with correct dim; recreate safely
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='items' AND column_name='embedding'
  ) THEN
    -- drop and recreate to correct dimensions
    EXECUTE 'ALTER TABLE items DROP COLUMN embedding';
  END IF;
  EXECUTE 'ALTER TABLE items ADD COLUMN embedding vector(1536)';
END$$;

-- ANN index (L2)
CREATE INDEX IF NOT EXISTS items_embedding_hnsw
  ON items USING hnsw (embedding vector_l2_ops);

-- JSON blobs
CREATE TABLE IF NOT EXISTS item_json (
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT CHECK (kind IN ('meta','recipe')) NOT NULL,
  body JSONB NOT NULL,
  PRIMARY KEY (item_id, kind)
);

-- jobs table
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','error')),
  item_id TEXT REFERENCES items(id),
  error TEXT,
  allow_inference BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_url_unique ON jobs(url);

ALTER TABLE item_json
  DROP CONSTRAINT IF EXISTS item_json_kind_check;

ALTER TABLE item_json
  ADD CONSTRAINT item_json_kind_check
  CHECK (kind IN ('meta','recipe','analysis'));

  -- allow 'analysis' rows in item_json.kind
DO $$
DECLARE
  has_analysis boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.check_constraints c
    JOIN information_schema.constraint_column_usage u
      ON c.constraint_name = u.constraint_name
    WHERE u.table_name='item_json'
      AND c.check_clause LIKE '%(meta%'  -- heuristic to find our check
  ) INTO has_analysis;

  -- If the current check clause does NOT already include 'analysis', replace it.
  IF has_analysis THEN
    BEGIN
      ALTER TABLE item_json DROP CONSTRAINT IF EXISTS item_json_kind_check;
    EXCEPTION WHEN undefined_object THEN
      -- sometimes the auto-generated name is different; try to drop any check constraints on item_json
      RAISE NOTICE 'Dropping generic check constraints for item_json failed or not needed';
    END;
    ALTER TABLE item_json
      ADD CONSTRAINT item_json_kind_check
      CHECK (kind IN ('meta','recipe','analysis'));
  END IF;
END $$;

-- lightweight preview fields
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='items' AND column_name='thumb_url'
  ) THEN
    ALTER TABLE items ADD COLUMN thumb_url TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='items' AND column_name='summary'
  ) THEN
    ALTER TABLE items ADD COLUMN summary TEXT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS collections (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id UUID REFERENCES collections(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (collection_id, item_id)
);