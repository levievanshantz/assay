-- Migration 009: Fix claims RPC type mismatches
-- Applied: 2026-03-05
-- Fixes: ts_rank returns real (needed double precision cast),
--        product_id is varchar in table but was declared as text in RPCs

-- Drop existing functions first (cannot change return type with CREATE OR REPLACE)
DROP FUNCTION IF EXISTS match_claims_by_fts(text, integer, text);
DROP FUNCTION IF EXISTS match_claims_by_embedding(vector, double precision, integer, text);
DROP FUNCTION IF EXISTS find_duplicate_claims(double precision, integer);

-- Recreated match_claims_by_fts with correct types
CREATE OR REPLACE FUNCTION match_claims_by_fts(
  search_query text,
  match_count integer DEFAULT 30,
  filter_product_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid, workspace_id text, source_type text, source_id text,
  claim_text text, claim_type text, stance text, source_excerpt text,
  claim_layer text, confidence text, modality text, source_kind text,
  duplicate_of_claim_id uuid,
  product_id varchar, project_id text, embedding_model text,
  freshness_state text, created_at timestamptz,
  rank double precision
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT c.id, c.workspace_id, c.source_type, c.source_id,
    c.claim_text, c.claim_type, c.stance, c.source_excerpt,
    c.claim_layer, c.confidence, c.modality, c.source_kind,
    c.duplicate_of_claim_id,
    c.product_id, c.project_id, c.embedding_model,
    c.freshness_state, c.created_at,
    ts_rank(to_tsvector('english', c.claim_text), plainto_tsquery('english', search_query))::double precision AS rank
  FROM claims c
  WHERE to_tsvector('english', c.claim_text) @@ plainto_tsquery('english', search_query)
    AND (filter_product_id IS NULL OR c.product_id = filter_product_id)
    AND c.duplicate_of_claim_id IS NULL
  ORDER BY rank DESC
  LIMIT match_count;
END;
$$;

-- Recreated match_claims_by_embedding with correct types
CREATE OR REPLACE FUNCTION match_claims_by_embedding(
  query_embedding vector(1536),
  match_threshold double precision DEFAULT 0.0,
  match_count integer DEFAULT 50,
  filter_product_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid, workspace_id text, source_type text, source_id text,
  claim_text text, claim_type text, stance text, source_excerpt text,
  claim_layer text, confidence text, modality text, source_kind text,
  duplicate_of_claim_id uuid,
  product_id varchar, project_id text, embedding_model text,
  freshness_state text, created_at timestamptz,
  similarity double precision
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT c.id, c.workspace_id, c.source_type, c.source_id,
    c.claim_text, c.claim_type, c.stance, c.source_excerpt,
    c.claim_layer, c.confidence, c.modality, c.source_kind,
    c.duplicate_of_claim_id,
    c.product_id, c.project_id, c.embedding_model,
    c.freshness_state, c.created_at,
    (1 - (c.embedding <=> query_embedding))::double precision AS similarity
  FROM claims c
  WHERE (1 - (c.embedding <=> query_embedding)) > match_threshold
    AND (filter_product_id IS NULL OR c.product_id = filter_product_id)
    AND c.duplicate_of_claim_id IS NULL
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Recreated find_duplicate_claims with correct types
CREATE OR REPLACE FUNCTION find_duplicate_claims(
  similarity_threshold double precision DEFAULT 0.92,
  max_results integer DEFAULT 100
)
RETURNS TABLE (
  claim_a_id uuid, claim_b_id uuid,
  claim_a_text text, claim_b_text text,
  similarity double precision,
  claim_a_created timestamptz, claim_b_created timestamptz
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT a.id AS claim_a_id, b.id AS claim_b_id,
    a.claim_text AS claim_a_text, b.claim_text AS claim_b_text,
    (1 - (a.embedding <=> b.embedding))::double precision AS similarity,
    a.created_at AS claim_a_created, b.created_at AS claim_b_created
  FROM claims a
  JOIN claims b ON a.id < b.id
  WHERE (1 - (a.embedding <=> b.embedding)) > similarity_threshold
    AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
    AND a.duplicate_of_claim_id IS NULL AND b.duplicate_of_claim_id IS NULL
  ORDER BY similarity DESC
  LIMIT max_results;
END;
$$;
