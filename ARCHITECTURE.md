# Architecture

This document covers the Assay plugin. The Librarian, the optional background scribe in `librarian/`, has its own design walkthrough in [librarian/ARCHITECTURE.md](librarian/ARCHITECTURE.md).

## The line

The query interface is a skill: an MCP tool call. The system behind it is state that ephemeral agent runs cannot rebuild: the accumulated decisions, their history, and the evaluation record. Assay holds that state for decisions, locally. claude-mem is the general session memory it can draw on. ECC is the hook lifecycle it runs inside.

## Three sibling plugins

```
ECC (Everything Claude Code — your hook orchestration)
   - hooks/hooks.json arrays, ECC_HOOK_PROFILE gating
   - SessionStart context injection (max 8KB)
   - 228 skills, run-with-flags.js wrapper
            ↓
claude-mem v13.x (memory primitive)
   - SQLite + Chroma hybrid retrieval
   - HTTP worker on port 37700+uid%100
   - MCP server: search / timeline / get_observations
   - ~/.claude-mem/...
            ↓
AssayLabs Decision Layer (this)
   - Independent <assay-decision> transcript parser
   - Typed decision graph at ~/.assay/decisions.db
   - MemoryProvider abstraction (claude-mem today, QMD-swappable in v3)
   - 3 MCP tools, 3 skills
   - Stop hook with three-tier rescue + profile gating
```

Each is a separate Claude Code plugin. None forks the others. The integration contract is HTTP API for memory access and lexicographic hook ordering for capture.

## Why typed decisions instead of flat memory

claude-mem stores compressed observations: facts derived from your session, embedded for similarity. That's the memory primitive. It's the right tool for "show me what was talked about regarding X."

But when you build with an agent, the question is often different: "what did we DECIDE about X." A decision is a typed thing with:
- Status lifecycle (candidate → tentative → confirmed → superseded → rejected)
- Supersession (this decision replaces that one because Z)
- Audit trail (every state transition logged, append-only)
- Confidence (how sure was the agent/operator at deposit time)
- Evidence link (what backed this decision)
- Conflict status (this decision conflicts with that one, unresolved)

None of that fits in a flat memory blob. The typed schema is the differentiation.

What alpha.3 uses of it today: every captured row is stored as `tentative`, and nothing moves it along the lifecycle yet. `supersedes` is stored as written (`supersedes_raw`) but not resolved, so `supersedes_resolved_id` stays empty and a supersession chain holds only the decision itself. Recall orders by recency. The Librarian's flag and ruling loop is where supersession is tracked today.

## MemoryProvider abstraction

```typescript
interface MemoryProvider {
  search(query, opts?): Promise<SearchResult[]>;
  getObservations(ids): Promise<{ found, missing }>;
  health(): Promise<{ status: 'full'|'degraded'|'offline', latency_ms, reason? }>;
}
```

`ClaudeMemHTTPProvider` is the v2 implementation. The interface exists so v3 can ship `QMDProvider` or `RolledMyOwnProvider` without rewriting the decision layer. A contract test that checks conformance across implementations is planned for when a second provider exists; it does not exist yet.

Concretely, this means: if QMD becomes the better substrate, the swap is about 250 LOC across 3 files, not a rewrite.

## "Not the agent" axiom drop

The April 29 strategy doc had a "not the agent" axiom — AssayLabs should never *be* the agent, only the stateful memory it talks to. In v2 plan review, Codex argued this is unenforceable: `assay_brief_render` and the SessionStart payload both steer the agent before the verdict moment. The axiom dropped.

**Replaced with:** "synthesis is permitted; opacity is not." AssayLabs can compose verdicts (`assay_brief_render` is a real composer). Every composed verdict carries citations. The trust contract is "cited synthesis you can inspect," not "we never speak the answer."

Refusal envelopes remain — when corpus is thin, evidence is ambiguous, or confidence is low, the system returns a refusal explanation and lets the human decide.

## Hook ordering — the cross-plugin contract

Stop hook ordering across plugins is lexicographic by `id` field. AssayLabs registers as `stop:zz-assay-decision-drain` so it fires AFTER ECC's `stop:session-end` and claude-mem's summarize hook.

**Why it matters:** claude-mem's summarize hook strips memory tags (including `<assay-decision>`) before persisting its observations. If AssayLabs ran before, its tags would not yet exist in claude-mem's view. If AssayLabs ran after but tried to read claude-mem's stored output, the tags would already be stripped.

**Solution:** AssayLabs parses the raw transcript directly (`transcriptPath` from hook input), independent of claude-mem's storage. Ordering still matters for observability (we want AssayLabs's analytics to land last) but does NOT affect tag extraction correctness.

## Three-tier rescue (no silent drops)

The Stop hook handles failures by class:

| Tier | Examples | Behavior |
|---|---|---|
| 1. Transient | `SQLITE_BUSY`, network timeout | Retry with backoff (6 attempts, with waits of 100/200/400/800/1600 ms between them: 3.1 s of backoff in total. Each attempt also waits up to 5 s inside SQLite for the lock before it fails) |
| 2. Recoverable | Malformed XML, missing attribute, `EACCES` on a single file | Log to `~/.assay/analytics/tool-usage.jsonl`, skip offending unit, continue |
| 3. Fatal | Disk full, schema version mismatch | Log to `~/.assay/errors.jsonl` AND write `[assay] hook degraded: <msg>` to stderr |

Silent drops are not permitted. Every dropped tag has a trace.

## ECC profile matrix

| Profile | AssayLabs behavior |
|---|---|
| `minimal` | Stop hook noops. User deposits via inline tags + `assay-decision-deposit` skill. |
| `standard` (default) | Capture + parse + persist. |
| `strict` | Capture + parse + persist + immediate stderr notification on `kind="conflict"` tags. |

## Storage schema (truncated)

```sql
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'conflict')),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'tentative',
  confidence REAL,
  layer TEXT,
  supersedes_raw TEXT,
  supersedes_resolved_id TEXT,
  supersedes_unresolved_reason TEXT,
  source_session_id TEXT,
  source_transcript_path TEXT,
  source_span_start INTEGER,
  source_span_end INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  embedding_model TEXT,
  embedded_at INTEGER
);

CREATE TABLE decision_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  transitioned_at INTEGER NOT NULL
);

CREATE TABLE decision_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('claude-mem','transcript','manual')),
  source_id TEXT NOT NULL,
  snippet TEXT,
  created_at INTEGER NOT NULL
);
```

`SCHEMA_VERSION = 1`. Migrations versioned in `schema_migrations`.

## What's NOT in v2

Per strategy doc + post-review:
- Not multi-user (single-user SQLite at `~/.assay/decisions.db`)
- Not a SaaS (no signup, no billing)
- Not Slack/Confluence-connected
- Not portable yet: the shipped plugin bundle vendors a better-sqlite3 binary built for macOS arm64 and Node 22.x (ABI 127), so the plugin loads only there. The TypeScript source builds and tests on Linux as well.
- Not exposing PM-shape decisions (problem/hypothesis/metric/outcome — deferred until a PM asks)
- No conflict resolution UI (conflicts surface; PM resolves manually)
- No vector similarity over the decisions table (recency-based for v2; v3 candidate)

## Distribution

- Claude Code plugin marketplace: this repo is the `assaylabs` marketplace. Install with `/plugin marketplace add levievanshantz/assay`, then `/plugin install assay@assaylabs`.
- npm: the package name `@assaylabs/assay` is reserved in `package.json` but not published.
- Developer CLI: `node bin/assay.mjs <command>` from a clone.
- Source and reference implementation: [github.com/levievanshantz/assay](https://github.com/levievanshantz/assay)

## Provenance

- Build start: 2026-05-17. The v2 plan and its CEO, Codex and engineering reviews were written outside this repo and are not included.
- Evidence record for 2.0.0-alpha.2: [PROOF.md](PROOF.md).
