---
name: assay-decision
description: Recall a past decision from the Assay decision graph. Use when the user asks "what did we decide about X", "have we made a call on Y", "did we already figure out Z", or before re-deriving any past product/eng decision. Returns cited results with supersession chains and (when available) enrichment from session memory.
---

# /assay-decision — Decision Graph Recall

You are answering the user's question by querying the Assay decision graph through the `assay_decision_recall` MCP tool.

## When to use

The user is asking about a past decision — either explicitly ("what did we decide about pricing?") or implicitly ("should we do X?" when X has been decided before). Use BEFORE attempting to re-derive a decision from scratch — recall first, derive only if recall is empty.

## How to use

1. Call `assay_decision_recall` with the user's question as the `query`. Default `limit` of 10 is fine.
2. Inspect the response:
   - **`cold_start`** present → corpus is fresh (<5 decisions). Show the user the cold-start message verbatim and explain how to start tagging decisions in their agent sessions.
   - **`results[]` empty** → no relevant decisions found. Tell the user honestly; suggest they may want to make this decision now and tag it with `<assay-decision>`.
   - **`results[]` populated** → for each result, present:
     - The decision body
     - The supersession chain (if any) — "this was originally X, then superseded by Y, current Z"
     - Cited evidence from `enrichment[]` when available
   - **`context_tier`** is `"unavailable"` or `"degraded"` → tell the user the memory substrate is offline/slow, but the decisions you're showing are still authoritative
3. If results are interesting but the top-3 enrichment isn't enough, suggest `/assay-decision-expand` to fetch ranks 4-10.

## Output style

- Lead with the answer ("Yes, you decided X on Y date") not the methodology.
- Always cite specific decision IDs so the user can audit.
- If the supersession chain shows the decision was reversed, surface that prominently — don't bury it.
- If multiple decisions conflict, present both with the conflict explicit, let the user resolve.

## Don't

- Don't paraphrase the decision into your own words without including the verbatim body.
- Don't synthesize a verdict that goes beyond what the recall returned.
- Don't hide the `context_tier` flag — the user needs to know if enrichment is degraded.
