-- Migration 000: Base schema — tables assumed by migrations 001–016
-- These tables are referenced via ALTER TABLE, INSERT, or FK in later migrations
-- but were never formally created in the migration chain.
-- Date: 2026-03-25
-- Uses CREATE TABLE IF NOT EXISTS for idempotent re-runs.

-- ============================================================
-- 1. products — referenced by claims.product_id FK in 001
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id CHARACTER VARYING PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE products ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "products_allow_all" ON products FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 2. projects — referenced by claims.project_id FK in 001,
--    formally created in 004 (which uses IF NOT EXISTS, so safe)
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  product_id CHARACTER VARYING REFERENCES products(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "projects_allow_all" ON projects FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 3. evidence_records — altered in 003, 005, 011, 014, 015
-- ============================================================
CREATE TABLE IF NOT EXISTS evidence_records (
  id CHARACTER VARYING PRIMARY KEY DEFAULT gen_random_uuid()::text,
  type TEXT NOT NULL,
  product_id CHARACTER VARYING REFERENCES products(id),
  project_id TEXT,
  title TEXT,
  summary TEXT,
  source_ref TEXT,
  state TEXT DEFAULT 'current',
  is_enabled BOOLEAN DEFAULT true,
  recorded_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE evidence_records ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "evidence_records_allow_all" ON evidence_records FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS evidence_records_product_idx ON evidence_records (product_id);
CREATE INDEX IF NOT EXISTS evidence_records_type_idx ON evidence_records (type);

-- ============================================================
-- 4. claims — created in 001, but pre-created here with is_enabled
--    so that 001's CREATE TABLE IF NOT EXISTS is a no-op.
--    001's subsequent ALTER TABLE and CREATE INDEX still apply.
-- ============================================================
CREATE TABLE IF NOT EXISTS claims (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID,
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  claim_text TEXT NOT NULL,
  claim_type TEXT NOT NULL DEFAULT 'finding',
  stance TEXT NOT NULL DEFAULT 'neutral',
  source_excerpt TEXT,
  product_id CHARACTER VARYING REFERENCES products(id),
  project_id UUID REFERENCES projects(id),
  embedding vector(1536),
  embedding_model TEXT DEFAULT 'text-embedding-3-small',
  embedded_at TIMESTAMPTZ,
  freshness_state TEXT NOT NULL DEFAULT 'current',
  freshness_updated_at TIMESTAMPTZ DEFAULT now(),
  is_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "claims_allow_all" ON claims FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 5. test_proposals — referenced by evaluation_results.test_id
-- ============================================================
CREATE TABLE IF NOT EXISTS test_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT 'system',
  product_id CHARACTER VARYING REFERENCES products(id),
  project_id UUID,
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  prd_body TEXT NOT NULL DEFAULT '',
  additional_notes TEXT,
  hypothesis TEXT,
  test_type TEXT,
  method TEXT,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE test_proposals ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "test_proposals_allow_all" ON test_proposals FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS test_proposals_product_idx ON test_proposals (product_id);
CREATE INDEX IF NOT EXISTS test_proposals_status_idx ON test_proposals (status);

-- ============================================================
-- 6. evaluation_results — referenced by evaluation_matches.evaluation_id
-- ============================================================
CREATE TABLE IF NOT EXISTS evaluation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT,
  test_id UUID REFERENCES test_proposals(id),
  evaluated_at TIMESTAMPTZ DEFAULT now(),
  provider TEXT,
  model TEXT,
  prompt_version INTEGER DEFAULT 1,
  verdict TEXT,
  similarity_percentage NUMERIC DEFAULT 0,
  reason TEXT,
  statement TEXT,
  recommended_action TEXT,
  prompt_sent TEXT,
  retrieval_metadata JSONB,
  raw_response JSONB
);

DO $$ BEGIN
  ALTER TABLE evaluation_results ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "evaluation_results_allow_all" ON evaluation_results FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS evaluation_results_test_idx ON evaluation_results (test_id);

-- ============================================================
-- 7. evaluation_matches — referenced in 010 (drop FK)
-- ============================================================
CREATE TABLE IF NOT EXISTS evaluation_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id UUID REFERENCES evaluation_results(id),
  evidence_id TEXT,
  relationship TEXT,
  similarity_percentage NUMERIC DEFAULT 0,
  explanation TEXT
);

DO $$ BEGIN
  ALTER TABLE evaluation_matches ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "evaluation_matches_allow_all" ON evaluation_matches FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS evaluation_matches_eval_idx ON evaluation_matches (evaluation_id);

-- ============================================================
-- 8. operation_prompts — referenced in 016 (INSERT/UPDATE)
-- ============================================================
CREATE TABLE IF NOT EXISTS operation_prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  text TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE operation_prompts ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "operation_prompts_allow_all" ON operation_prompts FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 9. provider_settings — referenced in 012 (ALTER TABLE ADD COLUMN)
-- ============================================================
CREATE TABLE IF NOT EXISTS provider_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'anthropic',
  model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  api_key_hash TEXT,
  api_key_last4 TEXT,
  last_validated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE provider_settings ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "provider_settings_allow_all" ON provider_settings FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 10. data_sources — used by storage.ts getSources/createSource
-- ============================================================
CREATE TABLE IF NOT EXISTS data_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'manual',
  is_active BOOLEAN DEFAULT true,
  include_in_evaluation BOOLEAN DEFAULT true,
  last_synced_at TIMESTAMPTZ,
  record_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE data_sources ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "data_sources_allow_all" ON data_sources FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 11. page_views — used by storage.ts trackPageView
-- ============================================================
CREATE TABLE IF NOT EXISTS page_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  path TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  session_id TEXT,
  event_type TEXT,
  meta TEXT,
  ip_address TEXT,
  user_agent TEXT,
  referrer TEXT,
  visited_at TIMESTAMPTZ DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE page_views ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "page_views_allow_all" ON page_views FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS page_views_path_idx ON page_views (path);
CREATE INDEX IF NOT EXISTS page_views_visitor_idx ON page_views (visitor_id);
