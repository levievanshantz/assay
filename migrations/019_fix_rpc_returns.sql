-- Migration 019: Fix evidence RPC return types to include project_id and source_date
-- Date: 2026-03-25
-- Problem: match_evidence_by_embedding and match_evidence_by_fts (from 015)
--   don't return project_id or source_date, but lib/claims.ts VectorRow/FtsRow types expect them.
-- Fix: Recreate both RPCs with the missing columns in their return types.

-- Drop existing functions (return type changes require DROP first)
DROP FUNCTION IF EXISTS match_evidence_by_embedding(vector, float, int, text);
DROP FUNCTION IF EXISTS match_evidence_by_fts(text, int, text);

-- match_evidence_by_embedding: now returns project_id and source_date
CREATE OR REPLACE FUNCTION match_evidence_by_embedding(
  query_embedding vector(1536),
  match_threshold float,
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
  similarity float
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

-- match_evidence_by_fts: now returns project_id and source_date
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
