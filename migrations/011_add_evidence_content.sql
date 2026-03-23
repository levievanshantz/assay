-- Migration 011: Add content column + rebuild FTS for PRD 6.5
-- Date: 2026-03-06

-- Add content column for full section text (no size limit)
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS content TEXT;

-- Add last_synced_at for provenance tracking
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

-- Update the FTS generated column to include content
-- (Postgres does not allow ALTER on generated columns — must DROP and re-ADD)
ALTER TABLE evidence_records DROP COLUMN IF EXISTS fts;

ALTER TABLE evidence_records
  ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(content, ''))
  ) STORED;

-- Recreate FTS GIN index (old index was dropped with the column)
CREATE INDEX IF NOT EXISTS idx_evidence_fts ON evidence_records USING GIN (fts);
