-- Migration 005: Add source_date to evidence_records
-- source_date = when the evidence was originally created or published.
-- This is distinct from recorded_at (the system ingestion timestamp).
--
-- Rules enforced by this schema:
--   - source_date is nullable (not all evidence has a known creation date)
--   - recorded_at continues to be auto-set by the DB on insert (DEFAULT now())
--   - source_date should NEVER be defaulted to recorded_at — that would silently
--     make all ingested records appear current regardless of actual age.
--
-- Downstream earmarks (must be addressed before Spec 4 freshness/decay):
--   - CSV import (Spec 2): map source_date from the CSV date column.
--     The column name will vary; the import UI should require the user to
--     select which CSV column maps to source_date.
--   - Gutenberg import: pull publication_date from Gutenberg metadata once
--     the /api/evidence/import-gutenberg route fetches full book metadata.
--     See earmark comment in app/api/evidence/import-gutenberg/route.ts.
--   - Spec 4 (trust + freshness): time decay rules will use source_date as
--     the authoritative age signal, not recorded_at.

ALTER TABLE evidence_records
  ADD COLUMN IF NOT EXISTS source_date date DEFAULT NULL;

-- Optional: index for range queries in freshness scoring (Spec 4)
CREATE INDEX IF NOT EXISTS evidence_records_source_date_idx
  ON evidence_records (source_date)
  WHERE source_date IS NOT NULL;
