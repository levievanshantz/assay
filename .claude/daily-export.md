# Daily Export — assay-mcp-server
_Last updated: 2026-04-05_

## What Shipped
- Rewritten to 4-tool MCP surface (retrieve, scan, stress_test, configure) — commit 8723f40
- Multi-block MCP responses to avoid token limit errors — commit 3074a6a
- Migration 020 fields ported to briefingCore and briefingPrompts — commit fb08182
- K values: scan=40, stress_test=80, brief=depth-dependent (quick=5, standard=15, deep=30)
- CLAUDE.md updated with multi-block docs, K values, stoic records note — commit 3812dde

## Current State
- 4-tool surface: retrieve (4 modes), scan, stress_test, configure
- Multi-block responses: header → per-record blocks → footer
- Migration 020 fields in all layers (RPC → briefingCore → briefingPrompts)
- Builds clean, typechecks clean

## Open Items
- depositEvaluation accumulation loop removed from handlers, needs re-wiring decision
- formatOutput.ts renderers available but not called from MCP handlers (calling LLM does synthesis)
