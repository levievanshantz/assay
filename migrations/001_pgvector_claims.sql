-- Migration 001: pgvector extension + claims table + spec_history table
-- Run this in Supabase SQL Editor
-- Date: 2025-02-25

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Claims table — atomic propositions extracted from proposals and evidence
CREATE TABLE IF NOT EXISTS claims (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID,                          -- nullable, future multi-tenant
  source_type TEXT NOT NULL,                   -- 'proposal' | 'evidence'
  source_id UUID NOT NULL,                     -- FK to test_proposals.id or evidence_records.id
  claim_text TEXT NOT NULL,                    -- single-sentence testable proposition
  claim_type TEXT NOT NULL DEFAULT 'finding',  -- 'finding' | 'recommendation' | 'assumption' | 'metric'
  stance TEXT NOT NULL DEFAULT 'neutral',      -- 'support' | 'oppose' | 'neutral' | 'unknown'
  source_excerpt TEXT,                         -- original text span for audit trail
  product_id CHARACTER VARYING REFERENCES products(id),
  project_id UUID REFERENCES projects(id),
  embedding vector(1536),                      -- OpenAI text-embedding-3-small
  embedding_model TEXT DEFAULT 'text-embedding-3-small',
  embedded_at TIMESTAMPTZ,
  freshness_state TEXT NOT NULL DEFAULT 'current',  -- 'current' | 'aging' | 'superseded'
  freshness_updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. HNSW index for fast approximate nearest neighbor on embeddings
CREATE INDEX IF NOT EXISTS claims_embedding_hnsw_idx
  ON claims USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 4. Generated tsvector column for full-text search
ALTER TABLE claims ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', claim_text)) STORED;

-- 5. GIN index on tsvector for fast FTS
CREATE INDEX IF NOT EXISTS claims_fts_gin_idx ON claims USING gin (fts);

-- 6. Indexes for common lookups
CREATE INDEX IF NOT EXISTS claims_source_idx ON claims (source_type, source_id);
CREATE INDEX IF NOT EXISTS claims_product_idx ON claims (product_id);
CREATE INDEX IF NOT EXISTS claims_freshness_idx ON claims (freshness_state);

-- 7. Spec history table — tracks build specs / changes over time
CREATE TABLE IF NOT EXISTS spec_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  spec_name TEXT NOT NULL,           -- e.g. 'Spec 1 — Claims + Retrieval Core'
  version TEXT NOT NULL,             -- e.g. 'v1.0'
  description TEXT,                  -- what changed in this version
  status TEXT DEFAULT 'in_progress', -- 'planned' | 'in_progress' | 'complete'
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  notion_url TEXT,                   -- link to Notion PRD
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 8. Enable RLS but allow service role full access
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE spec_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON claims
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for service role" ON spec_history
  FOR ALL USING (true) WITH CHECK (true);

-- 9. Insert initial spec history record
INSERT INTO spec_history (spec_name, version, description, status, notion_url)
VALUES (
  'Spec 1 — Claims + Retrieval Core',
  'v1.0',
  'pgvector extension, claims table, HNSW index, FTS index, hybrid search foundation',
  'in_progress',
  'https://www.notion.so/3120ef37-39cb-8198-959c-ddb5f9e8031f'
);
