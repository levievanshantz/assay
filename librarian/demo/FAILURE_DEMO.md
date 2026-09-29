# Breaking it on purpose

`./break-it.sh` reproduces the pre-2026-07-08 data-loss bug against synthetic data and
shows the coverage gate contain it. It reuses `demo.sh`'s setup — a synthetic `$HOME`, a
private copy of the tree, a fake `claude` on `PATH` — but installs the **broken worker**:
it advances both watermarks to the batch targets and files *nothing*. That is the exact
failure mode that, before the fix, produced `sweep: COMPLETE` and permanently deleted the
batch. On affected batches it silently destroyed 74–86% of the observations it was meant
to file.

## Watch for, line by line

The script runs the real `bin/sweep.sh` up to five times and greps each run's decision:

- **Runs 1–3** — `coverage: missing=10`, then `watermarks ROLLED BACK cm 20->0 (retry N/3)`,
  then `sweep: INCOMPLETE`. Each run re-preserves the 10 undispositioned residual items to
  the append-only recovery ledger *before* rolling back, so the batch is never the only copy.
- **Run 4** — the retry cap is hit: `STILL undispositioned after 3 retries — accepting run;
  items preserved in ... (HUMAN REVIEW NEEDED)`, then `sweep: COMPLETE`. It gives up **loudly**
  rather than livelock, but only because preservation is proven.

## Why it matters

The final section shows the ledger holds **10 distinct keys** — every residual item, verbatim,
recoverable — even though it accepted the run. The prior behavior would have shown `sweep:
COMPLETE` on run 1 and left nothing behind. The gate's rule is simple: a watermark may only
pass an item that has a durable disposition; anything else is preserved, rolled back, and
retried; and a run whose preservation cannot be proven is never accepted.

Both scripts require **macOS** (the sweep uses BSD `stat -f %m` and `shlock`) and use only
the Python standard library plus `sqlite3`.
