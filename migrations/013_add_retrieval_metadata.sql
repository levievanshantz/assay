-- Migration 013: Add retrieval_metadata to evaluation_results (PRD 5.56 Patch 5)
-- Captures per-evaluation retrieval trace (layer scores, RRF contributions, config used)
-- for display in the Results page Retrieval Trace accordion.
-- Applied via Supabase MCP on 2026-03-08.

ALTER TABLE evaluation_results
  ADD COLUMN IF NOT EXISTS retrieval_metadata JSONB;
