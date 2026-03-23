-- Migration 014: Add claims_extraction_status to evidence_records (PRD 5.56 Patch 6)
-- Tracks async claim extraction state for each evidence record.
-- Values: 'pending' | 'processing' | 'complete' | 'failed' | 'not_applicable'
-- Extraction is triggered post-upsert in evaluationCore and Quick Add flows.
-- Applied via Supabase MCP on 2026-03-08.

ALTER TABLE evidence_records
  ADD COLUMN IF NOT EXISTS claims_extraction_status VARCHAR DEFAULT 'pending';
