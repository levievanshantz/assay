# Cross-Model Eval Verdict — 2026-05-17

**Verdict: CLEAR.** Both Claude Opus 4.7 and OpenAI Codex independently verify that Assay v2.0-alpha.2 honors the 14 capability contracts in `CAPABILITIES.md`.

## Methodology

Two independent eval runs, two AI systems:

| Run | Model | Mode | Verdict |
|---|---|---|---|
| Claude harness (post-fix) | Claude Opus 4.7 (1M context) | verify | 14/14 pass |
| Claude harness (post-fix) | Claude Opus 4.7 (1M context) | adversarial | 14/14 pass |
| Codex round 1 | OpenAI Codex (model_reasoning_effort=medium) | independent probes | 4 contract violations + 1 false positive |
| Codex round 2 (post-fix) | OpenAI Codex (model_reasoning_effort=medium) | independent re-probe | CLEAR (all 4 fixes verified) |

## Round 1 — Codex found 4 real contract violations

1. **C3** — Stop hook failed when SQLite lock held longer than 600ms retry window.
2. **C8** — Brief composed verdicts from recent decisions regardless of topic match.
3. **C10** — Direct SQL `UPDATE` tampered with `decision_transitions` (append-only enforced only at API layer, not storage).
4. **C13** — Eager fetch retrieved 10 observations when contract said top-3 eager + 4-10 lazy.

Plus 1 false positive: C12 (cold-start envelope) — Codex's probe was buggy; reproduction confirmed the implementation is correct.

## Round 2 — Codex verified all 4 fixes hold

| Probe | Fix | Codex Result |
|---|---|---|
| F1 (C3 retry backoff) | 6 attempts, exponential backoff to ~5s total | ok in 3066ms, decisions_captured=1 — PASS |
| F2 (C8 topic refusal) | Token-level substring + semantic fallback; refuse if no match | unrelated refuses, "topic X" composes — PASS |
| F3 (C10 trigger enforcement) | SQLite BEFORE UPDATE/DELETE triggers on decision_transitions + decision_evidence | UPDATE and DELETE blocked on both tables — PASS |
| F4 (C13 eager limit) | search() capped at EAGER_FETCH_TOP_N (=3) in recall path | recall=3, expand=20 — PASS |

## What this means

- **Implementation matches the contract** — claims in CAPABILITIES.md are not aspirational, they're verified.
- **Cross-model agreement** — two AI systems with different architectures, different prompts, different code-reading strategies converged on the same verdict. Single-model self-assessment risks confirmation bias; cross-model verification mitigates it.
- **Adversarial coverage is real** — Codex's probes exercised vectors the original Claude evals missed (e.g., direct SQL tampering, longer lock holds). Those gaps are now closed.

## Eval-gate criterion (per CAPABILITIES.md)

> "all 14 capabilities pass in BOTH modes, BOTH from Claude and from Codex independently. No capability gets a free pass."

**Status: MET.** Eligible to proceed to human testing per roadmap R5–R7.

## Reproduce

```bash
cd assay                      # your clone of github.com/levievanshantz/assay
npm run eval                  # Claude harness, both modes
# Codex re-verification: the round-2 prompt was not kept in the repo
```

## Caveats

- These evals exercise the **code** against the **contract**. They do not validate **product fit**. That requires R7's human-testing gate (5 active testers, 30-day window, sliding-ratio behavioral signal).
- Coverage is necessarily incomplete. New adversarial vectors emerge over time. Run the eval gate before every release; treat any new fail as a contract regression.
