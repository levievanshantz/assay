-- Migration 002: RPC functions for hybrid search
-- Run this in Supabase SQL Editor
-- Date: 2025-02-25

-- 1. Vector similarity search
CREATE OR REPLACE FUNCTION match_claims_by_embedding(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.3,
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
    c.product_id, c.project_id, c.embedding_model,
    c.freshness_state, c.created_at,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM claims c
  WHERE c.embedding IS NOT NULL
    AND 1 - (c.embedding <=> query_embedding) > match_threshold
    AND (filter_product_id IS NULL OR c.product_id = filter_product_id)
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 2. Full-text search
CREATE OR REPLACE FUNCTION match_claims_by_fts(
  search_query text,
  match_count int DEFAULT 20,
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
    c.product_id, c.project_id, c.embedding_model,
    c.freshness_state, c.created_at,
    ts_rank(c.fts, plainto_tsquery('english', search_query)) AS rank
  FROM claims c
  WHERE c.fts @@ plainto_tsquery('english', search_query)
    AND (filter_product_id IS NULL OR c.product_id = filter_product_id)
  ORDER BY rank DESC
  LIMIT match_count;
END;
$$;
