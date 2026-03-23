-- Migration 007: PRD 6 — Claims as Memory schema upgrade
-- Run this in Supabase SQL Editor
-- Date: 2026-03-05
--
-- Adds 6 new columns to claims table:
--   claim_layer, confidence, modality, durability_class, source_kind, duplicate_of_claim_id
-- Updates RPC functions to return new columns and remove hard similarity threshold.

-- ─── 1. New columns on claims table ─────────────────────────────

ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_layer TEXT
  CHECK (claim_layer IN ('observation', 'interpretation', 'intention'));

ALTER TABLE claims ADD COLUMN IF NOT EXISTS confidence TEXT
  CHECK (confidence IN ('high', 'medium', 'low'));

ALTER TABLE claims ADD COLUMN IF NOT EXISTS modality TEXT
  DEFAULT 'asserted'
  CHECK (modality IN ('asserted', 'suspected', 'hypothesized'));

ALTER TABLE claims ADD COLUMN IF NOT EXISTS durability_class TEXT
  DEFAULT 'working'
  CHECK (durability_class IN ('ephemeral', 'working', 'canonical'));

ALTER TABLE claims ADD COLUMN IF NOT EXISTS source_kind TEXT
  CHECK (source_kind IN ('experiment', 'analytics', 'interview',
    'document', 'meeting_notes', 'slack', 'csv'));

ALTER TABLE claims ADD COLUMN IF NOT EXISTS duplicate_of_claim_id UUID
  REFERENCES claims(id);

-- Index for dedup lookups (find canonical claim for a duplicate)
CREATE INDEX IF NOT EXISTS idx_claims_duplicate_of
  ON claims(duplicate_of_claim_id)
  WHERE duplicate_of_claim_id IS NOT NULL;

-- Index for layer-aware queries
CREATE INDEX IF NOT EXISTS idx_claims_layer
  ON claims(claim_layer);

-- ─── 2. Updated RPC: Vector similarity search (claims) ──────────
-- Removes hard similarity threshold, returns new columns.
-- Now returns ALL top_k results, no floor — threshold tuning deferred to PRD 6.1.

CREATE OR REPLACE FUNCTION match_claims_by_embedding(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.0,
  match_count int DEFAULT 50,
  filter_product_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  workspace_id uuid,
  source_type text,
  source_id uuid,
  claim_text text,
  claim_type text,
  stance text,
  source_excerpt text,
  claim_layer text,
  confidence text,
  modality text,
  source_kind text,
  duplicate_of_claim_id uuid,
  product_id character varying,
  project_id uuid,
  embedding_model text,
  freshness_state text,
  created_at timestamptz,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id, c.workspace_id, c.source_type, c.source_id,
    c.claim_text, c.claim_type, c.stance, c.source_excerpt,
    c.claim_layer, c.confidence, c.modality, c.source_kind,
    c.duplicate_of_claim_id,
    c.product_id, c.project_id, c.embedding_model,
    c.freshness_state, c.created_at,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM claims c
  WHERE c.embedding IS NOT NULL
    AND 1 - (c.embedding <=> query_embedding) > match_threshold
    AND (filter_product_id IS NULL OR c.product_id = filter_product_id)
    AND c.duplicate_of_claim_id IS NULL  -- exclude duplicates, use canonical only
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ─── 3. Updated RPC: Full-text search (claims) ──────────────────
-- Returns new columns, excludes duplicate-linked claims.

CREATE OR REPLACE FUNCTION match_claims_by_fts(
  search_query text,
  match_count int DEFAULT 30,
  filter_product_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  workspace_id uuid,
  source_type text,
  source_id uuid,
  claim_text text,
  claim_type text,
  stance text,
  source_excerpt text,
  claim_layer text,
  confidence text,
  modality text,
  source_kind text,
  duplicate_of_claim_id uuid,
  product_id character varying,
  project_id uuid,
  embedding_model text,
  freshness_state text,
  created_at timestamptz,
  rank float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id, c.workspace_id, c.source_type, c.source_id,
    c.claim_text, c.claim_type, c.stance, c.source_excerpt,
    c.claim_layer, c.confidence, c.modality, c.source_kind,
    c.duplicate_of_claim_id,
    c.product_id, c.project_id, c.embedding_model,
    c.freshness_state, c.created_at,
    ts_rank(c.fts, plainto_tsquery('english', search_query)) AS rank
  FROM claims c
  WHERE c.fts @@ plainto_tsquery('english', search_query)
    AND (filter_product_id IS NULL OR c.product_id = filter_product_id)
    AND c.duplicate_of_claim_id IS NULL  -- exclude duplicates
  ORDER BY rank DESC
  LIMIT match_count;
END;
$$;

-- ─── 4. New RPC: Find near-duplicate claims for dedup linking ────
-- Used during ingestion to check if a new claim is a near-duplicate
-- of an existing one (same product). Returns top candidates above threshold.

CREATE OR REPLACE FUNCTION find_duplicate_claims(
  query_embedding vector(1536),
  filter_product_id text,
  similarity_threshold float DEFAULT 0.92,
  max_candidates int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  claim_text text,
  claim_layer text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.claim_text,
    c.claim_layer,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM claims c
  WHERE c.embedding IS NOT NULL
    AND c.product_id = filter_product_id
    AND c.duplicate_of_claim_id IS NULL  -- only check canonical claims
    AND 1 - (c.embedding <=> query_embedding) > similarity_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT max_candidates;
END;
$$;
