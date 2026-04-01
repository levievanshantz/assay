# Assay MCP Server

Public MCP server for the Assay intelligence platform — the standalone distribution of the Intelligence Ledger's retrieval and analysis tools. External users install this to get Assay capabilities in their Claude setup. No UI, just tools.

## Relationship to ILP

This repo is the **MCP-only extraction** of `intelligence-ledger-prototype` (ILP). ILP is the development monorepo with Next.js frontend, API routes, and the full application. This repo shares the same PostgreSQL/pgvector database and core retrieval logic, packaged for MCP distribution.

- **ILP** (`/Users/levishantz/intelligence-ledger-prototype`): Parent monorepo. Schema changes happen there first, then propagate here.
- **ilp-prompts**: System prompts for brief/scan/stress_test live in ILP but are used by both.
- **assaylabs-site** (`/Users/levishantz/assaylabs-docs-site`): Docs/marketing site — separate repo, no code dependency.

## Stack

- **Language:** TypeScript (ESM)
- **Build:** tsup (`tsup src/index.ts --out-dir dist --format esm --platform node`)
- **Runtime:** Node.js
- **Database:** PostgreSQL + pgvector (uses `pg` directly — NOT Supabase JS client)
- **Embeddings:** OpenAI `text-embedding-3-small` (1536 dimensions)
- **MCP protocol:** `@modelcontextprotocol/sdk`
- **Claim extraction:** Ollama (Phi-4 14B) locally, or subagent mode
- **Optional synthesis:** `@anthropic-ai/sdk` still present for evaluate mode (may be removed later)
- **Validation:** Zod

## MCP Tools (11 registered)

| Tool | Description |
|------|-------------|
| `retrieve_evidence` | Hybrid search (embedding + RRF). Three modes: `raw` (no LLM), `guided` (returns eval instructions for calling LLM), `evaluate` (server-side synthesis). |
| `brief` | Briefing-first synthesis — surfaces what the org already knows about a topic. Context summary, prior work, constraints, debates, dependencies. No judgment. |
| `stress_test` | Deliberate judgment mode — stress-tests a proposal against evidence. Returns overlap/conflict analysis, assumption weaknesses, gaps, verdict, confidence. |
| `check_proposal` | **DEPRECATED** — alias that routes to `stress_test`. |
| `ingest_from_notion` | Fetches a Notion page, chunks at heading boundaries, embeds, and extracts claims. Content-hash dedup skips unchanged sections. |
| `ingest_from_confluence` | Same as Notion ingestion but for Confluence (Cloud v2 ADF + Server/DC v1 storage format). |
| `sync_notion` | Syncs all tracked Notion pages. Re-embeds + re-extracts changed sections. Circuit breaker halts if >20% of pages changed. |
| `drift_report` | Read-only diagnostic — compares current Notion content against stored evidence using content hash + cosine similarity. No mutations. |
| `health_check` | System health: DB connectivity, pgvector, embedding config, extraction mode, Notion integration, synthesis availability. |
| `submit_extracted_claims` | Accepts externally extracted claims for an evidence record (subagent extraction mode). Validates, embeds, and saves. |

## Database

- **Shared with ILP monorepo** — same PostgreSQL instance and schema
- **Product ID:** `eef5d84d-856d-41e7-a52b-0e2019c195e2`
- **Local connection:** `postgresql://localhost:5432/intelligence_ledger_local`
- **Migrations:** `migrations/` directory (18 SQL files)
- **Key tables:** `evidence_records`, `claims`, `embeddings`, `products`, `evaluation_runs`
- **Extensions:** pgvector (for cosine similarity search)

## Key Files

```
src/index.ts              — MCP server entry point, tool registrations + handlers
lib/db.ts                 — PostgreSQL connection (pg Pool)
lib/embeddings.ts         — OpenAI text-embedding-3-small wrapper
lib/briefingCore.ts       — Evidence retrieval + prompt assembly for brief/stress_test
lib/claims.ts             — Claim extraction, embedding, hybrid search
lib/storage.ts            — Evidence record creation + embedding
lib/ingestionPipeline.ts  — Content hashing, dedup, ingestion orchestration
lib/notionClient.ts       — Notion API: fetch blocks, parse, chunk at headings
lib/notionSync.ts         — Sync pipeline for tracked Notion pages
lib/confluenceClient.ts   — Confluence API: fetch + parse ADF/HTML
lib/config.ts             — Runtime config loader
lib/logger.ts             — Structured logging with session tracking
lib/sanitize.ts           — Input sanitization
lib/extractionRouter.ts   — Routes claim extraction (Ollama vs subagent)
lib/ollamaClient.ts       — Local Ollama (Phi-4) for claim extraction
lib/llmClient.ts          — LLM client abstraction
lib/accumulationLoop.ts   — Evaluation deposit pipeline
lib/evaluationCore.ts     — Evaluation logic
scripts/setup-db.mjs      — Database + extension setup
scripts/verify-setup.mjs  — Setup verification
scripts/seed-demo.mjs     — Demo data seeder
```

## Development

```bash
# Install dependencies
npm install

# Set up database (first time)
npm run setup-db

# Development (tsx — no build step)
npm run dev

# Production build + run
npm run build && npm start

# Type checking
npm run typecheck

# Verify setup
npm run verify
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `OPENAI_API_KEY` | Yes | For text-embedding-3-small embeddings |
| `NOTION_API_KEY` | For Notion tools | Required for ingest_from_notion, sync_notion, drift_report |
| `CONFLUENCE_BASE_URL` | For Confluence | Confluence instance URL |
| `CONFLUENCE_EMAIL` | For Confluence | Confluence account email |
| `CONFLUENCE_API_TOKEN` | For Confluence | Confluence API token |
| `PRODUCT_ID` | No | Default product scope UUID |
| `ANTHROPIC_API_KEY` | No | For evaluate mode synthesis (off-limits in scripts) |

Env files are loaded from `.env.local` then `.env` (relative to project root).

## Constraints

- **ANTHROPIC_API_KEY is off-limits in scripts** — no direct SDK calls in automation
- Changes here affect all users of the MCP server — test locally first
- Schema changes originate in ILP, not here

## Daily Export Protocol
<!-- ORCHESTRATOR-MANAGED — Do not remove this section. Injected by the global orchestrator instance. -->
<!-- If this section is missing after a CLAUDE.md rewrite, the orchestrator will re-inject it. -->

After completing any significant task (finishing a draft, pushing emails, completing an audit section,
shipping a feature, updating trackers), APPEND to the file at:

    .claude/daily-export.md

(relative to your project root). Create the `.claude/` directory if it doesn't exist.

**Multiple instances may share this folder.** Pick a short unique name for yourself on first write
(e.g. `assay-tools`, `assay-sync`, `assay-dev`). Use that name consistently for the rest of your session.

Append this exact block (with a `---` separator before it):

```
---
# <your-instance-name> | <YYYY-MM-DD> | <HH:MM update time>

## Active Work
- [what you worked on this session — be specific]

## Blockers
- [anything stalled or waiting on Levi's input — or "None"]

## Deadlines (next 7 days)
- [YYYY-MM-DD]: [item] — or "None upcoming"

## Files Changed (this session)
- [paths of modified files]

## Handoff Notes
- [anything Levi or another instance should know — decisions made, things to follow up on]
```

**Rules:**
1. Always APPEND with `---` separator — never overwrite. Multiple instances share this file.
2. Keep each entry under 40 lines. Be specific but not verbose.
3. Update after meaningful work, not after every keystroke.
4. If you compact or start a new session, re-read this section and continue the behavior.
5. The orchestrator instance pulls this file daily at 7am for Levi's morning brief. It handles dedup and cleanup.
6. After writing the export, resume your previous task. This should take under 30 seconds and not interrupt your work.
