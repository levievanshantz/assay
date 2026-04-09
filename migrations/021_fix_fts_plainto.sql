-- Migration 021: Fix FTS functions to use plainto_tsquery instead of to_tsquery
-- Date: 2026-04-09
-- Problem: to_tsquery requires pre-formatted query syntax (e.g. 'foo & bar').
--   Raw user input (e.g. "performance issues") causes syntax errors.
--   plainto_tsquery handles plain text by automatically ANDing all terms.
-- Fix: Recreate match_evidence_by_fts and match_claims_by_fts using plainto_tsquery.

-- ============================================================
-- 1. match_evidence_by_fts
--    Source: 019_fix_rpc_returns.sql — only to_tsquery changed
-- ============================================================

DROP FUNCTION IF EXISTS match_evidence_by_fts(text, int, text);

CREATE OR REPLACE FUNCTION match_evidence_by_fts(
  search_query text,
  match_count int,
  filter_product_id text DEFAULT NULL
)
RETURNS TABLE (
  id varchar,
  type text,
  product_id character varying,
  project_id text,
  title text,
  summary text,
  source_ref text,
  state text,
  recorded_at timestamptz,
  source_date date,
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
    er.product_id,
    er.project_id,
    er.title,
    er.summary,
    er.source_ref,
    er.state,
    er.recorded_at,
    er.source_date,
    er.is_enabled,
    ts_rank(er.fts, plainto_tsquery('english', search_query)) AS rank
  FROM evidence_records er
  WHERE er.is_enabled = true
    AND er.is_tombstoned = false
    AND (filter_product_id IS NULL OR er.product_id = filter_product_id)
    AND er.fts @@ plainto_tsquery('english', search_query)
  ORDER BY rank DESC
  LIMIT match_count;
END;
$$;

-- ============================================================
-- 2. match_claims_by_fts
--    Source: 020_source_date_fields.sql — only to_tsquery changed
-- ============================================================

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
    ts_rank(c.fts, plainto_tsquery('english', search_query)) AS rank
  FROM claims c
  WHERE c.duplicate_of_claim_id IS NULL
    AND c.superseded_at IS NULL
    AND (filter_product_id IS NULL OR c.product_id = filter_product_id)
    AND c.fts @@ plainto_tsquery('english', search_query)
  ORDER BY rank DESC
  LIMIT match_count;
END;
$$;
