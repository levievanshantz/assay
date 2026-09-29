# Design decisions and the alternatives I rejected

## 1. A deterministic prefilter in front of the LLM worker

**Decision.** Before the batch reaches the expensive LLM, a deterministic pass auto-files the unambiguous run-log observations onto a single system or project authority and hands the LLM only the residual. Every whole-batch cycle it can resolve without the LLM is a cycle that costs nothing and behaves identically every time.

**Rejected.** Sending the whole batch to the LLM every run. Cheaper to write, but it pays LLM cost on rows a regex resolves with certainty, and it makes the trivial cases non-deterministic.

**Why, and where it bit back.** The prefilter is deliberately timid: it only touches observation types `change` and `bugfix`, requires exactly one candidate authority, and files only onto `system`/`project` authorities — every guard biased toward "if unsure, hand it to the LLM." But its candidate matcher accepts an authority on as few as two distinctive name tokens, and that loose 2-token matcher is the suspected main source of the measured 11.7% misfiling rate. The determinism I wanted came with a recall-precision knob I set slightly too loose.

## 2. Explicit-only supersession — flag, don't decide

**Decision.** The system never promotes an *implied* supersession on its own. When new evidence reads like it might replace prior state, the worker raises a `possible-supersession` flag and stops. The single path from implied to asserted is a human ruling that explicitly confirms it; only then is the edge written and the old authority's status flipped.

**Rejected.** Auto-supersession by embedding similarity — detect that a new decision resembles and contradicts an old one, and retire the old one automatically. I built this and retired it.

**Why.** In a system of record, a wrong assertion is worse than a missing one. An auto-retired authority that shouldn't have been retired is a confident falsehood in the store people trust; a flag that sits open is merely an unanswered question. Accountability beats recall here — the system's job is to be right about what it asserts, not to assert as much as possible.

## 3. Rollback-and-bounded-retry for coverage failures

**Decision.** When the post-run audit finds an undispositioned item, roll both watermarks back atomically and retry the batch, bounded at three attempts, then accept loudly with a human-review flag.

**Rejected.** Two simpler options. Retry forever — which livelocks on a batch that can never complete. And accept-and-log — record the miss and move on — which is the original data-loss bug wearing a log line, because the batch still gets deleted.

**Why, and the refinement.** Bounded retry balances "don't livelock" against "don't lose data." But the external review found the bound itself could destroy data: when the recovery ledger write fails, preservation is unprovable, and giving up then deletes the only surviving copy. So the refinement removes the bound in exactly that case — unprovable preservation retries forever, because a stuck batch is recoverable and a deleted one is not. The bound applies only when the item is provably safe elsewhere.

## 4. External audit over worker self-report

**Decision.** The coverage gate treats the LLM worker as untrusted and verifies its output against the journal independently, rather than believing the worker's own claim that it filed everything.

**Rejected.** Trusting the worker's self-report — which is exactly what the original bug did, and exactly what it cost.

**Why, named honestly.** The end-state design is a structured-output worker with a deterministic writer, where the writing isn't a judgment call the LLM can get wrong. I haven't built that yet. Until I do, the gate is the compensating control that makes it safe to ship the LLM-writer version at all: the worker can be as unreliable as LLMs are, and the audit still catches it before anything irreversible happens.

## 5. Journal as sole truth, human surface as disposable projection

**Decision.** The SQLite journal is the single source of truth. The human-facing rendering is a projection derived from it — it can corrupt, lag, or fail to render without any data loss, because the truth still lives in the journal.

**Rejected.** Making the human-facing tool the primary store — writing decisions straight into the surface people read.

**Why.** The projection did corrupt and did lag, more than once. Every time, the fix was to re-render from the journal; no decision was ever lost to a rendering failure. Had the human surface been the store, each of those incidents would have been data loss instead of a cosmetic retry.

---

**The meta-decision.** I measured the system's own filing precision — 83.3% — and published that number in this repository rather than rounding it up or leaving it out. A tool whose entire pitch is honest state has no standing to be dishonest about itself. The number that most tempts you to hide it is the one you most have to show.
