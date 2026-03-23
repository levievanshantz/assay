-- Migration 003: Direct evidence embeddings (replacing claims-based search)
-- Run this in Supabase SQL Editor
-- Date: 2026-02-25

-- 1. Add embedding column to evidence_records
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS embedding_model TEXT DEFAULT 'text-embedding-3-small';
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

-- 2. Add FTS column for full-text search on evidence
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, ''))) STORED;

-- 3. HNSW index for vector search on evidence embeddings
CREATE INDEX IF NOT EXISTS evidence_embedding_hnsw_idx
  ON evidence_records USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 4. GIN index for FTS on evidence
CREATE INDEX IF NOT EXISTS evidence_fts_gin_idx ON evidence_records USING gin (fts);

-- 5. RPC: Vector similarity search on evidence
CREATE OR REPLACE FUNCTION match_evidence_by_embedding(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.3,
  match_count int DEFAULT 30,
  filter_product_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  type text,
  product_id character varying,
  project_id text,
  title text,
  summary text,
  source_ref text,
  state text,
  recorded_at timestamptz,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id, e.type, e.product_id, e.project_id,
    e.title, e.summary, e.source_ref, e.state, e.recorded_at,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM evidence_records e
  WHERE e.embedding IS NOT NULL
    AND 1 - (e.embedding <=> query_embedding) > match_threshold
    AND (filter_product_id IS NULL OR e.product_id = filter_product_id)
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 6. RPC: Full-text search on evidence
CREATE OR REPLACE FUNCTION match_evidence_by_fts(
  search_query text,
  match_count int DEFAULT 20,
  filter_product_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  type text,
  product_id character varying,
  project_id text,
  title text,
  summary text,
  source_ref text,
  state text,
  recorded_at timestamptz,
  rank float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id, e.type, e.product_id, e.project_id,
    e.title, e.summary, e.source_ref, e.state, e.recorded_at,
    ts_rank(e.fts, plainto_tsquery('english', search_query)) AS rank
  FROM evidence_records e
  WHERE e.fts @@ plainto_tsquery('english', search_query)
    AND (filter_product_id IS NULL OR e.product_id = filter_product_id)
  ORDER BY rank DESC
  LIMIT match_count;
END;
$$;

-- 7. Clean up: delete all claims (we're moving away from claims-based search)
DELETE FROM claims;

-- 8. Delete old sample data with non-UUID IDs
DELETE FROM evidence_records WHERE id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
