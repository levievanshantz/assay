// SQLite schema for ~/.assay/decisions.db
// Carries forward the typed decision-graph primitive from current Assay
// (migrations 026, 029, 030) but cleaned up — no claim/decision discriminator
// overloading. This table IS decisions, full stop.

export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'conflict')),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'tentative'
    CHECK (status IN ('candidate', 'tentative', 'confirmed', 'superseded', 'rejected')),
  confidence REAL,
  layer TEXT,
  supersedes_raw TEXT,
  supersedes_resolved_id TEXT,
  supersedes_unresolved_reason TEXT
    CHECK (supersedes_unresolved_reason IS NULL
       OR supersedes_unresolved_reason IN ('none-specified', 'prefix-not-found',
                                            'prefix-ambiguous', 'malformed')),
  source_session_id TEXT,
  source_transcript_path TEXT,
  source_span_start INTEGER,
  source_span_end INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  embedding_model TEXT,
  embedded_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_decisions_kind ON decisions(kind);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
CREATE INDEX IF NOT EXISTS idx_decisions_supersedes ON decisions(supersedes_resolved_id)
  WHERE supersedes_resolved_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at DESC);

-- Append-only audit trail: every state transition logged
CREATE TABLE IF NOT EXISTS decision_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  transitioned_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transitions_decision
  ON decision_transitions(decision_id, transitioned_at);

-- Evidence rows linking decisions to claude-mem observations (or other sources)
CREATE TABLE IF NOT EXISTS decision_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('claude-mem', 'transcript', 'manual')),
  source_id TEXT NOT NULL,
  snippet TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_decision ON decision_evidence(decision_id);

-- Append-only enforcement at the storage layer: decision_transitions and
-- decision_evidence rows are immutable. Honors C10 contract beyond the API
-- boundary — direct SQL UPDATE/DELETE is blocked even by tooling.
CREATE TRIGGER IF NOT EXISTS decision_transitions_no_update
  BEFORE UPDATE ON decision_transitions
  BEGIN
    SELECT RAISE(FAIL, 'decision_transitions is append-only; UPDATE not permitted');
  END;

CREATE TRIGGER IF NOT EXISTS decision_transitions_no_delete
  BEFORE DELETE ON decision_transitions
  BEGIN
    SELECT RAISE(FAIL, 'decision_transitions is append-only; DELETE not permitted');
  END;

CREATE TRIGGER IF NOT EXISTS decision_evidence_no_update
  BEFORE UPDATE ON decision_evidence
  BEGIN
    SELECT RAISE(FAIL, 'decision_evidence is append-only; UPDATE not permitted');
  END;

CREATE TRIGGER IF NOT EXISTS decision_evidence_no_delete
  BEFORE DELETE ON decision_evidence
  BEGIN
    SELECT RAISE(FAIL, 'decision_evidence is append-only; DELETE not permitted');
  END;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES (${SCHEMA_VERSION}, unixepoch() * 1000);
`;
