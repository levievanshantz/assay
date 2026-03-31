# Assay MCP Server

Public MCP server for the Assay intelligence platform (distributed via npm/GitHub).

## Stack
- TypeScript, Node.js
- MCP SDK (@modelcontextprotocol/sdk)
- PostgreSQL (via intelligence-ledger-prototype's local DB)
- Ollama (Phi-4 14B for claim extraction)

## Relationship to ILP
This is the public distribution package of the Intelligence Ledger's MCP tools.
- `retrieve` — raw evidence retrieval from corpus
- `scan` — fast pre-flight check
- `stress_test` — stress test proposals against corpus
- `configure` — view/update config

## Key Files
- `src/index.ts` — MCP server entry point
- `lib/db.ts` — PostgreSQL connection and queries
- `prompts/` — Extraction prompt templates
- `scripts/setup-db.mjs` — Database setup

## Constraints
- ANTHROPIC_API_KEY is off-limits in scripts
- This repo shares the Supabase DB with intelligence-ledger-prototype
- Changes here affect all users of the MCP server — test locally first
