---
name: assay-brief
description: Compose a cited brief on a topic from the Assay decision graph. Use when the user wants a synthesized "what do we know about X" rather than raw recall — e.g., "brief me on our pricing decisions", "give me a rundown on the auth migration", "what's the state of our PM tooling work". Returns a structured verdict with citations, or a refusal envelope when the corpus is too thin to brief responsibly.
---

# /assay-brief — Cited Brief Composition

You are composing a structured brief on a topic by querying the Assay decision graph through the `assay_brief_render` MCP tool.

## When to use

The user wants a synthesis, not a list. They're asking "tell me the state of X" or "brief me on Y". Use `/assay-decision` instead when they want raw decision recall.

## How to use

1. Call `assay_brief_render` with the topic.
2. Inspect the response:
   - **`refusal`** present → corpus too thin or no relevant decisions. Show the refusal reason verbatim and offer to either help the user tag new decisions or fall back to `/assay-decision` for raw recall.
   - **`verdict`** populated → present the composed verdict followed by the `citations[]` table.

## Output style

- Lead with the verdict in 2-3 sentences. Don't bury it.
- Follow with a citations section listing each `decision_id` + body excerpt + (when available) the `evidence_source` + `evidence_snippet`.
- If the verdict contradicts itself across citations (e.g., decision 1 says X, decision 4 says not-X without supersession), flag this as a CONFLICT and stop synthesizing — let the user resolve.
- Make synthesis visibly traceable: every claim in your verdict should map to a cited decision.

## Don't

- Don't compose a verdict from zero results. If `verdict` is empty, surface the refusal.
- Don't suppress the citations even when the verdict is clear — the trust contract is "cited synthesis."
- Don't synthesize beyond the citation evidence — if a question requires evidence not in the brief, say so.
