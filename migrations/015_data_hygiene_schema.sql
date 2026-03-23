-- Migration 015: Data Hygiene & Ingestion Pipeline Foundation (PRD 9)
-- Date: March 18, 2026
-- Purpose: Add content hashing, source identification, tombstoning, and version-aware claims
-- Rollback: All columns are nullable/defaulted — safe to DROP IF EXISTS without data loss

-- ============================================================
-- 1. evidence_records — content hashing for dedup
-- ============================================================

ALTER TABLE evidence_records
  ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- ============================================================
-- 2. evidence_records — structured source identification
-- ============================================================

ALTER TABLE evidence_records
  ADD COLUMN IF NOT EXISTS source_type TEXT;
  -- Values: 'notion' | 'confluence' | 'csv' | 'gutenberg' | 'manual' | 'test' | 'slack' | 'jira' | 'linear'

ALTER TABLE evidence_records
  ADD COLUMN IF NOT EXISTS source_external_id TEXT;
  -- The external system's native ID (e.g., Notion page_id, Jira key PROJ-234)

-- ============================================================
-- 3. evidence_records — monotonic version tracking
-- ============================================================

ALTER TABLE evidence_records
  ADD COLUMN IF NOT EXISTS source_version INTEGER DEFAULT 1;

-- ============================================================
-- 4. evidence_records — tombstoning (soft delete)
-- ============================================================

ALTER TABLE evidence_records
  ADD COLUMN IF NOT EXISTS is_tombstoned BOOLEAN DEFAULT false;

ALTER TABLE evidence_records
  ADD COLUMN IF NOT EXISTS tombstone_reason TEXT;
  -- Values: 'source_deleted' | 'superseded' | 'manual'
  -- When source_deleted: UI shows "⚠️ Source page no longer exists in [source_type]"

-- ============================================================
-- 5. claims — extraction metadata for version tracking
-- ============================================================

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS source_version INTEGER DEFAULT 1;

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMPTZ;

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS extraction_model TEXT;

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS extraction_prompt_version TEXT;

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
  -- NULL = current claim. Non-NULL = replaced by newer extraction.
  -- Simpler than superseded_by_id FK chain. Musk filter: mark superseded, don't build chain traversal.

-- ============================================================
-- 6. claims — V3 prompt fields (nullable, future-ready)
-- ============================================================

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS stance_signal FLOAT;

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS claim_origin TEXT;

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS extraction_confidence TEXT;

-- ============================================================
-- 7. Indexes
-- ============================================================

-- Hash-based dedup check: "does a record with this hash already exist for this product?"
CREATE INDEX IF NOT EXISTS idx_evidence_content_hash
  ON evidence_records(product_id, content_hash)
  WHERE content_hash IS NOT NULL;

-- Source polling: "give me all Notion pages I need to check"
CREATE INDEX IF NOT EXISTS idx_evidence_source_type
  ON evidence_records(source_type, source_external_id)
  WHERE source_type IS NOT NULL;

-- Tombstone filtering: sparse index on tombstoned records
CREATE INDEX IF NOT EXISTS idx_evidence_tombstoned
  ON evidence_records(is_tombstoned)
  WHERE is_tombstoned = true;

-- Current-claims-only retrieval: exclude superseded claims
CREATE INDEX IF NOT EXISTS idx_claims_superseded_at
  ON claims(superseded_at)
  WHERE superseded_at IS NOT NULL;

-- ============================================================
-- 8. Update retrieval RPCs to filter tombstoned + superseded
-- ============================================================

-- match_evidence_by_embedding: add is_tombstoned = false filter
CREATE OR REPLACE FUNCTION match_evidence_by_embedding(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  filter_product_id text DEFAULT NULL
)
RETURNS TABLE (
  id varchar,
  type text,
  title text,
  summary text,
  source_ref text,
  state text,
  recorded_at timestamptz,
  is_enabled boolean,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    er.id,
    er.type,
    er.title,
    er.summary,
    er.source_ref,
    er.state,
    er.recorded_at,
    er.is_enabled,
    1 - (er.embedding <=> query_embedding) AS similarity
  FROM evidence_records er
  WHERE er.is_enabled = true
    AND er.is_tombstoned = false
    AND (filter_product_id IS NULL OR er.product_id = filter_product_id)
    AND 1 - (er.embedding <=> query_embedding) > match_threshold
  ORDER BY er.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- match_evidence_by_fts: add is_tombstoned = false filter
CREATE OR REPLACE FUNCTION match_evidence_by_fts(
  search_query text,
  match_count int,
  filter_product_id text DEFAULT NULL
)
RETURNS TABLE (
  id varchar,
  type text,
  title text,
  summary text,
  source_ref text,
  state text,
  recorded_at timestamptz,
  is_enabled boolean,
  rank float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    er.id,
    er.type,
    er.title,
    er.summary,
    er.source_ref,
    er.state,
    er.recorded_at,
    er.is_enabled,
    ts_rank(er.fts, to_tsquery('english', search_query)) AS rank
  FROM evidence_records er
  WHERE er.is_enabled = true
    AND er.is_tombstoned = false
    AND (filter_product_id IS NULL OR er.product_id = filter_product_id)
    AND er.fts @@ to_tsquery('english', search_query)
  ORDER BY rank DESC
  LIMIT match_count;
END;
$$;

-- match_claims_by_embedding: add superseded_at IS NULL filter
CREATE OR REPLACE FUNCTION match_claims_by_embedding(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  filter_product_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
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
  product_id varchar,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.source_type,
    c.source_id,
    c.claim_text,
    c.claim_type,
    c.stance,
    c.source_excerpt,
    c.claim_layer,
    c.confidence,
    c.modality,
    c.source_kind,
    c.product_id,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM claims c
  WHERE c.duplicate_of_claim_id IS NULL
    AND c.superseded_at IS NULL
    AND (filter_product_id IS NULL OR c.product_id = filter_product_id)
    AND 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- match_claims_by_fts: add superseded_at IS NULL filter
CREATE OR REPLACE FUNCTION match_claims_by_fts(
  search_query text,
  match_count int,
  filter_product_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
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
  product_id varchar,
  rank float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.source_type,
    c.source_id,
    c.claim_text,
    c.claim_type,
    c.stance,
    c.source_excerpt,
    c.claim_layer,
    c.confidence,
    c.modality,
    c.source_kind,
    c.product_id,
    ts_rank(c.fts, to_tsquery('english', search_query)) AS rank
  FROM claims c
  WHERE c.duplicate_of_claim_id IS NULL
    AND c.superseded_at IS NULL
    AND (filter_product_id IS NULL OR c.product_id = filter_product_id)
    AND c.fts @@ to_tsquery('english', search_query)
  ORDER BY rank DESC
  LIMIT match_count;
END;
$$;
