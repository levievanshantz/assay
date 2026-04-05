-- Migration 020: Source Temporal Metadata
-- Date: April 5, 2026
-- Purpose: Add source_created_at / source_updated_at to evidence_records and claims
--          for temporal retrieval weighting. Values come from Notion API created_time
--          and last_edited_time respectively — these are document-author timestamps,
--          NOT our sync timestamps.
-- Propagated from ILP migration 020_source_dates.sql
-- Rollback: All columns are nullable — safe to DROP IF EXISTS without data loss

-- ============================================================
-- 1. evidence_records — source temporal metadata
-- ============================================================

ALTER TABLE evidence_records
  ADD COLUMN IF NOT EXISTS source_created_at TIMESTAMPTZ;
  -- Notion API: created_time — when the source document was first created

ALTER TABLE evidence_records
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;
  -- Notion API: last_edited_time — when the author last edited the document.
  -- NOT when we synced it (use last_synced_at for that).

-- ============================================================
-- 2. claims — inherit source temporal metadata from parent evidence record
-- ============================================================

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS source_created_at TIMESTAMPTZ;
  -- Inherited from parent evidence_record.source_created_at at extraction time

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;
  -- Inherited from parent evidence_record.source_updated_at at extraction time

-- ============================================================
-- 3. Indexes — source_updated_at used for temporal retrieval weighting
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_evidence_source_updated_at
  ON evidence_records(source_updated_at)
  WHERE source_updated_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claims_source_updated_at
  ON claims(source_updated_at)
  WHERE source_updated_at IS NOT NULL;

-- ============================================================
-- 4. Update claims RPCs to expose new fields + claim_origin + extraction_confidence
-- ============================================================

-- match_claims_by_embedding
-- Must DROP first because RETURNS TABLE signature is changing
DROP FUNCTION IF EXISTS match_claims_by_embedding(vector(1536), float, int, text);

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
  claim_origin text,
  extraction_confidence text,
  source_created_at timestamptz,
  source_updated_at timestamptz,
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
    c.claim_origin,
    c.extraction_confidence,
    c.source_created_at,
    c.source_updated_at,
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

-- match_claims_by_fts
-- Must DROP first because RETURNS TABLE signature is changing
DROP FUNCTION IF EXISTS match_claims_by_fts(text, int, text);

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
  claim_origin text,
  extraction_confidence text,
  source_created_at timestamptz,
  source_updated_at timestamptz,
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
    c.claim_origin,
    c.extraction_confidence,
    c.source_created_at,
    c.source_updated_at,
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
