-- Migration 006: Seed Spec 1.1 entry in spec_history
-- Run this in the Supabase SQL editor after deploying the fd3e932 commit.

-- First: mark Spec 1 v1.0 as complete (it shipped, evidence toggle + search was the exit)
UPDATE spec_history
SET
  status       = 'complete',
  completed_at = '2026-02-26'
WHERE spec_name = 'Spec 1 — Claims + Retrieval Core'
  AND version   = 'v1.0';

-- Insert Spec 1.1 — post-ship hardening + eval foundation
INSERT INTO spec_history (spec_name, version, description, status, started_at, notion_url)
VALUES (
  'Spec 1.1 — Evidence Hardening & Eval Foundation',
  'v1.1',
  E'Post-ship improvements to the Spec 1 retrieval core:\n\n'
  '• Evidence toggle (is_enabled): per-record enable/disable without deletion. '
  'Excluded records are filtered at both the hybrid search layer and the ILIKE fallback. '
  'Toggle visible in Evidence Library with Switch UI per card and per group.\n\n'
  '• source_date field: added to evidence_records to capture original creation/publication '
  'date distinct from recorded_at (ingestion timestamp). '
  'Earmarks planted for CSV import mapping and Gutenberg publication date. '
  'Required prereq for Spec 4 trust/freshness decay.\n\n'
  '• TypeScript hardening: EvidenceSearchResult type now includes is_enabled and source_date. '
  'Both fields propagated through hybridEvidenceSearch RRF merge. '
  'Fixed build errors in Gutenberg importer route.\n\n'
  '• Eval framework (Notion): Recall@K, verdict accuracy, and citation precision targets '
  'defined. Gold set spec: 20 entries, split across not_related / related / contradiction. '
  'Five philosophical test proposals written as gold set seed.\n\n'
  '• Onboarding modal: first-visit localStorage-gated modal with 3-step flow. '
  'Dark brand theme. Shows once per browser.\n\n'
  '• README rewrite: accurate architecture, hybrid search details, evidence toggle, '
  'build status table (Spec 1 complete, Specs 2–4 planned).',
  'complete',
  '2026-02-26',
  'https://www.notion.so/3130ef3739cb8185afc6e927e1fb21f3'
)
ON CONFLICT DO NOTHING;
