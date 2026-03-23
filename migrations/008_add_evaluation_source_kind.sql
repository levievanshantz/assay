-- PRD 5.2 absorbed: add 'evaluation' to source_kind constraint
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_source_kind_check;
ALTER TABLE claims ADD CONSTRAINT claims_source_kind_check
  CHECK (source_kind IN ('experiment', 'analytics', 'interview', 'document', 'meeting_notes', 'slack', 'csv', 'evaluation'));
