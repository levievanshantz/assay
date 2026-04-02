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
git clone https://github.com/levievanshantz/assay.git
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

> "Use the configure tool with subcommand health to verify Assay is working."

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

## MCP Tools Reference (4 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `retrieve` | Search the evidence corpus. Four modes: `raw` (default, no LLM), `guided` (returns eval instructions for calling LLM), `evaluate` (server-side OpenAI synthesis), `brief` (organizational knowledge synthesis) | `query_text`, `mode`, `top_k`, `full_content`, `depth`, `product_id` |
| `scan` | Fast pre-flight check against evidence. Returns 3-5 signals with clear/caution/blocker verdict. ~3-5s. | `intent`, `product_id` |
| `stress_test` | Stress-test a proposal against evidence. Returns overlap/conflict analysis, assumption weaknesses, gaps, verdict, confidence. | `proposal`, `product_id` |
| `configure` | Unified admin tool. Subcommands: `status` (sync health + optional drift), `sync` (trigger Notion sync), `sources` (connected sources + corpus stats), `search` (show/update retrieval settings), `extraction` (show/update model settings), `health` (system connectivity check) | `subcommand`, plus subcommand-specific params |

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
