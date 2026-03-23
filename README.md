# Assay

Give your product team a memory that doesn't forget.

Assay is an MCP server that gives AI coding agents persistent institutional knowledge. It extracts structured claims from your product docs, indexes them alongside raw evidence, and surfaces cited context when you need it.

**Built by [Assaylabs](https://assaylabs.com)**

---

## Prerequisites

- PostgreSQL 15+ with [pgvector](https://github.com/pgvector/pgvector) extension
- Node.js 20+
- OpenAI API key (for embeddings)
- Optional: [Ollama](https://ollama.com) (for free local extraction)
- Optional: Anthropic API key (for Sonnet-quality extraction + synthesis)
- Optional: Notion API key (for workspace ingestion)

> Setup requires admin permissions if PostgreSQL isn't already installed.

---

## Quick Start

```bash
git clone https://github.com/assaylabs/assay.git
cd assay
npm install
cp .env.local.example .env.local    # fill in your API keys
npm run setup-db                     # creates DB, extensions, migrations
npm run seed-demo                    # loads demo corpus (optional)
npm run build                        # builds MCP server
npm run verify                       # checks everything works
```

---

## Claude Code Setup

Add to `.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "assay": {
      "command": "node",
      "args": ["/absolute/path/to/assay/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://localhost:5432/assay",
        "OPENAI_API_KEY": "sk-...",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Replace `/absolute/path/to/assay` with your actual install path. `ANTHROPIC_API_KEY` is optional (needed only for Anthropic extraction mode and synthesis).

After configuring, restart Claude Code. Test with:

> "Use the health_check tool to verify Assay is working."

---

## Ingesting a Notion Workspace

Set `NOTION_API_KEY` in `.env.local`, then:

```bash
node scripts/notion-crawl.mjs                    # crawl workspace (~12 min for 130 pages)
node scripts/notion-ingest.mjs --latest           # insert + embed (~2 min)
```

Incremental updates (only fetches changed pages):

```bash
node scripts/notion-crawl.mjs --incremental
node scripts/notion-ingest.mjs --latest
```

---

## Extraction Modes

| Mode | Cost | Quality | Setup |
|------|------|---------|-------|
| `ollama` (default) | Free | 83.1% | Requires Ollama + `ollama pull phi4:14b` |
| `anthropic` | ~$0.003/section | 93.8% | Set `ANTHROPIC_API_KEY` in `.env.local` |
| `subagent` | Subscription | ~93.8% | Requires Claude Code |

Set via `.env.local`:

```
EXTRACTION_MODE=ollama
```

Or at runtime:

```bash
node scripts/assay-config.mjs extraction.mode anthropic
```

---

## MCP Tools Reference

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `brief` | Get a briefing on what the org knows about a topic | `topic`, `depth` (quick/standard/deep), `product_id` |
| `stress_test` | Test a proposal against organizational evidence | `proposal`, `product_id` |
| `retrieve_evidence` | Search the evidence corpus | `query_text`, `mode` (raw/guided/evaluate), `top_k` |
| `ingest_from_notion` | Ingest a Notion page by URL or ID | `page_url_or_id`, `extract_claims`, `product_id` |
| `sync_notion` | Sync all tracked Notion pages for changes | `extract_claims`, `max_pages`, `product_id` |
| `drift_report` | Read-only health check on Notion page drift | `max_pages`, `product_id` |
| `health_check` | Verify system connectivity and status | -- |
| `submit_extracted_claims` | Deposit extracted claims back into the corpus | `claims`, `evidence_record_id` |
| `check_proposal` | *(Deprecated)* Routes to `stress_test` | `proposal_text`, `title`, `product_id` |

---

## Feature Toggles

```bash
node scripts/assay-config.mjs                            # show current config
node scripts/assay-config.mjs sync.enabled false          # disable sync
node scripts/assay-config.mjs extraction.enabled true     # enable extraction
node scripts/assay-config.mjs hygiene.schedule "0 8 * * *"  # 8 AM daily
node scripts/assay-config.mjs hygiene.schedule off        # disable hygiene
```

Presets:

```bash
node scripts/assay-preset.mjs minimal     # evidence only, no extraction
node scripts/assay-preset.mjs standard    # recommended defaults
node scripts/assay-preset.mjs full        # everything on
```

---

## Logging

Assay logs all activity to `logs/`:

| File | Format |
|------|--------|
| `logs/assay-YYYY-MM-DD.log` | Human-readable |
| `logs/assay-YYYY-MM-DD.jsonl` | Structured JSON |
| `logs/latest.log` | Current session |

Check what happened:

```bash
cat logs/latest.log
```

Or ask Claude Code to read it directly.

---

## Database Schema

| Table | Purpose |
|-------|---------|
| `evidence_records` | Source documents chunked and embedded (pgvector) |
| `claims` | Atomic propositions extracted from evidence with type, stance, and provenance |
| `products` | Product scoping for multi-product workspaces |
| `operation_prompts` | Eval prompt versions |
| `provider_settings` | API key and provider configuration storage |

---

## Architecture

```
Notion --> crawl --> ingest --> PostgreSQL + pgvector
                                      |
Claude Code ----> MCP Server (stdio) ----> 4-layer RRF retrieval
                                                |
                                          LLM synthesis (Anthropic)
                                                |
                                          Structured JSON + citations
                                                |
                                          Accumulation loop (deposits back)
```

---

## Compute Requirements

| Corpus Size | Ollama (local) | API (Anthropic) | Subagent (Claude Code) |
|-------------|----------------|-----------------|------------------------|
| 50 pages | ~30 min | ~3 min | ~8 min |
| 130 pages | ~60-90 min | ~7 min | ~20 min |
| 500 pages | ~5-8 hours | ~25 min | ~60 min |

**Minimum:** M1 Mac, 8 GB RAM (slow with Ollama).
**Recommended:** M1 Pro, 16 GB+ RAM.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| PostgreSQL not running | `brew services start postgresql@15` |
| pgvector not installed | `brew install pgvector` or [install from source](https://github.com/pgvector/pgvector#installation) |
| Ollama not running | `ollama serve` |
| Model not pulled | `ollama pull phi4:14b` |
| Notion 401 | API key expired. Refresh at [notion.so/my-integrations](https://notion.so/my-integrations) |
| Empty brief results | Corpus is empty. Run `npm run seed-demo` or crawl+ingest a Notion workspace |
| health_check shows "broken" | Check `DATABASE_URL` and `OPENAI_API_KEY` in `.env.local` |

---

## Future Documentation

When the project grows, these should split out:

- `docs/tools-reference.md` -- detailed tool I/O specs with examples
- `docs/schema-reference.md` -- full table definitions + RPC functions
- `docs/architecture.md` -- data flow diagrams, retrieval pipeline detail

---

## License

MIT -- Assaylabs
