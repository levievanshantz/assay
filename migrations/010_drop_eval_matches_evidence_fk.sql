-- Migration 010: Drop FK constraint on evaluation_matches.evidence_id
-- PRD 6: Claims are now the primary search unit. Their IDs are stored in
-- evaluation_matches.evidence_id alongside traditional evidence_record IDs.
-- The FK constraint to evidence_records prevented claim-based matches from being saved.

ALTER TABLE evaluation_matches DROP CONSTRAINT IF EXISTS evaluation_matches_evidence_id_fk;
