-- Migration 012: Add retrieval_config to provider_settings (PRD 5.56 Patch 1)
-- Adds configurable layer weights for hybrid retrieval (vector/FTS, claims/evidence).
-- Stored as JSONB under key: { layer_weights: { test_eval: {...}, strategic_query: {...} } }
-- Applied via Supabase MCP on 2026-03-08.

ALTER TABLE provider_settings
  ADD COLUMN IF NOT EXISTS retrieval_config JSONB DEFAULT '{}'::jsonb;
