# Postmortem: the non-atomic watermark bug (74–86% silent data loss)

## Summary

The sweep decided a run had succeeded by checking that both watermarks equalled the batch targets, then deleted the batch file — but the LLM worker advanced those watermarks itself and nothing forced it to have filed every item first, so a partial run produced a full commit and the unfiled items were stranded behind the watermark, permanently and silently. On 2026-07-08 the system's own diagnostic batch showed only 6 of 23 observations had persisted, and reconstruction put the loss at 74–86% across the affected batches. I found it because the system files observations about its own operation, so the missing filings were themselves measurable. Root cause was identified and the fix shipped the same day; twelve days later an independent audit of the source database showed 6,599 of 6,599 items dispositioned, and the gate had already caught and recovered two real production failures unattended.

## Timeline

- **2026-07-08** — A diagnostic batch surfaced the loss: 6 of 23 observations persisted, 73.9% measured loss on that one batch, 74–86% once I reconstructed the other affected batches. Root cause identified, fix designed and shipped the same day.
- **2026-07-12 02:41 and 10:31** — The new gate caught two real production failures, one missing item each. Both times it rolled the watermarks back (e.g. the claude-mem watermark 14571 → 14553), the batch re-exported and was retried on the next cycle, and both items were verified filed later that day. Fully unattended — no human touched either incident.
- **2026-07-20** — Cumulative independent audit against the source database: 6,599 of 6,599 items dispositioned, 100.00%, over 12 days.
- **2026-07-24** — An external cross-model review of the fix (a different vendor's frontier model, run with an adversarial prompt) found three further holes in my fix. All three fixed the same day.

## The bug, mechanically

The sweep exported a batch of new observations and decisions, recorded the current watermarks and the batch's target watermarks, and handed the batch to a headless LLM worker. The worker was supposed to file every item and then, as its final step, advance both watermarks to the targets. Back in the sweep, the success check was numeric equality: if both post-run watermarks equalled the batch targets, the run was accepted and the batch file deleted.

The problem is that the worker advances the watermarks itself, in its own commit step, and nothing in the contract forced it to have filed every item before doing so. A worker that filed six of twenty-three items and then advanced the watermarks anyway produced exactly the state the sweep treated as success: watermarks at target, equality satisfied. The sweep deleted the batch. The seventeen unfiled items were now behind the watermark — they would never be re-exported — and the only copy of them, the batch file, was gone. The loss was silent because nothing in the accept path ever looked at what was actually filed, and permanent because both the forward pointer and the source copy were destroyed in the same breath.

The load-bearing sentence: equality proved *a commit happened*; it did not prove *coverage happened*. Those are two different invariants, and only the second one is safe to build a delete on.

## Why I wrote the bug

I own this one. I borrowed watermark semantics from stream processing — advance a cursor past what you've consumed — without carrying over the atomicity discipline that makes them safe there, where the consume and the advance are one transaction. Here the "consume" was an LLM's filing work and the "advance" was that same LLM's self-report, and I trusted the self-report as proof of the work. Advancing a cursor past unacknowledged work is a textbook failure mode. I should have designed against it before shipping, not after measuring it in production.

## How the system caught it

The one thing that saved this was structural, not lucky: the design files observations about its own operation into the same store it manages. So when filings vanished, the vanishing was itself data the system recorded, and I could measure the loss rate directly instead of guessing at it. The instrumentation loop I'd built for the product's benefit paid for itself the first time the product broke.

## The fix, layer by layer

- **Disposition contract.** Every batch item must leave the run with a durable disposition in the journal: an evidence row (filed), an unfiled row (a deliberate, recorded hold), or — for rulings — a processed-ruling outcome. "Held as noise" is a valid disposition; "not looked at" is not.
- **Post-run audit.** `coverage-verify.py` runs after the worker and checks every batch item against those disposition types. It emits exactly one machine-parseable line and never crashes the sweep.
- **Append-only recovery ledger.** Any item with no disposition is written verbatim to an append-only ledger *before* any accept-or-retry decision is made, so nothing the audit finds missing is ever unrecoverable, regardless of what the sweep decides next.
- **Atomic rollback and bounded retry.** When coverage fails, the sweep rolls both watermarks back to their pre-run values in one transaction and retries the batch next cycle — bounded at three retries per starting watermark, then it accepts loudly ("HUMAN REVIEW NEEDED") rather than livelocking forever on a chronically incomplete batch.
- **Hardened worker prompt.** The worker's commit step is now explicitly gated on full coverage: advance the watermarks only if every item has a disposition, otherwise stop and touch nothing so the sweep retries.

## What external review then found in my fix

On 2026-07-24 a different vendor's frontier model reviewed the fix under an adversarial prompt and found three real holes:

1. **A failed ledger write produced a false preservation claim.** The give-up path logged "items preserved in the ledger" and deleted the batch — even when the ledger write had itself failed, which is precisely when the batch is the only surviving copy. Fixed: an errored audit means preservation is unprovable, so it now refuses the give-up path forever and retains the batch, retrying indefinitely. A stuck batch is recoverable; a deleted one is not.
2. **The retry counter was keyed on one watermark only.** A batch that differed only in its second source (drain) inherited a stale retry count from a previous batch and could give up early on its first real attempt. Fixed: the counter is now keyed on both watermarks.
3. **Drain-key disposition matching used an 8-hex-prefix LIKE.** A 32-bit prefix collision could mark a genuinely missing item as dispositioned. Fixed: exact match wins; a prefix match counts only when exactly one row matches; any ambiguity routes the item to the ledger — the safe direction.

The reviewer's fourth claim — SQL injection in the rollback — was wrong: those watermark values are validated as numeric before any SQL is built. But it pointed at a real unvalidated path elsewhere (the batch-export targets, parsed from the exporter's stdout and interpolated into SQL), which got the same strict-numeric guard. Accepting three findings, correcting one, and deferring one (idempotency of projection-layer timeline appends, tracked but not yet closed) is the review working exactly as intended, not a sign the fix was unsound.

## Verification

There are eight regression tests that drive the real sweep against a synthetic HOME with a controllable fake worker — one worker that files everything, one that reproduces the bug by advancing watermarks having filed nothing, one that holds every item as a deliberate disposition. Five of the original six tests verifiably fail against the pre-fix code, and both post-review tests fail against the pre-review code, so each test pins a real regression rather than restating current behavior. Separately, the twelve days of production coverage were audited at 100.00% against the source database directly — not against the system's own run logs, which are the thing that could be lying.

## Lessons

- A cursor past unacknowledged work is data loss waiting for a partial run; the acknowledgement and the advance have to be one atomic step, or the advance is a lie.
- "A commit happened" and "the work happened" are different invariants — never let equality on the first stand in for the second, especially before an irreversible delete.
- Trusting an LLM worker's self-report as proof of completion is trusting the least reliable component to certify itself; an independent audit is the compensating control.
- Instrumenting a system to record its own operation is worth the cost the first time it breaks, because the failure becomes measurable instead of anecdotal.
- An adversarial external review of your own fix finds the holes you're constitutionally unable to see, and a fix that survives one is worth more than a fix you only reasoned about alone.
