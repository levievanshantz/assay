# Limitations

Every known weakness, stated plainly.

## Security model: an unattended agent with every permission

This is the largest risk in the repo, so it comes first. Every 20 minutes, and within seconds of each Claude Code turn ending, launchd runs `bin/sweep.sh`. When a batch needs judgment, the sweep starts `claude -p --permission-mode bypassPermissions` as your user, on your subscription, for up to 900 seconds. No permission prompts, no sandbox: the worker can run any command, read and write any file you can, and reach the network. The `--settings` override that keeps claude-mem from recording the librarian switches off plugins and hooks; it does not restrict tools.

The worker's input is verbatim observation and decision text, which carries whatever your sessions touched: web pages, files, tool output. The prompt tells the worker that batch text is untrusted data and never instructions, but that is a request to a model, not a boundary. A crafted observation it obeyed would act with full permissions, on a timer, while nobody watches. The coverage gate, the pre-sweep journal backup, owner-only files and the timeout all protect the journal; none of them limits what an injected command could do outside it.

The procedure needs far less than it gets: read the batch file, run `sqlite3` on the journal, append one line to the runs log, and, only if Notion is connected, `ToolSearch` plus three Notion tools. I have not made a tighter default because I have not proven one lets a real run finish; an allowlist the worker cannot complete under stalls the pipeline (safely, since the watermarks never advance, but it stalls). What exists instead: `install.sh` installs nothing until you type `bypassPermissions`, and `bin/sweep.sh` reads `LIBRARIAN_PERMISSION_MODE` and `LIBRARIAN_ALLOWED_TOOLS` for anyone who wants to try a narrower worker. The better design is the one named under "The LLM worker writes SQL directly": structured output checked by a deterministic writer, so the model needs no shell at all. See "Security model" in README.md for the options.

## The pre-fix loss window is unquantified

The coverage guarantee starts on 2026-07-08, the day the fix landed. Before that, observations came through the lossy path for months. I know that path dropped 74-86% on the affected batches I measured, but I do not know how many batches were affected or how much was lost overall. That data is gone and the size of the hole is unknown. Every number in this repo describes the post-fix era only.

## Filing precision is 83.3%, not higher

About one filing in nine lands on the wrong authority (11.7% wrong, 5.0% defensible-but-not-ideal, from a 120-row sample graded by four judges). Two "magnet" authorities — the one describing the system itself and the one about the Notion integration — absorb a disproportionate share of anything mentioning an evidence count or a Notion page. The suspected cause is in `bin/prefilter.py`: it auto-files when two or more distinctive name tokens match, and two tokens is a loose bar when 85 authorities share words like "Notion," "page," and "pipeline." The strict "exactly one candidate" guard blocks ambiguous filings but does nothing when the loose matcher produces exactly one *wrong* candidate.

## The human ruling loop is under-exercised

The system flags contradictions and possible supersessions for a human to rule on. That mechanism is built and works, but flags accumulate faster than I rule on them. So the flag-to-ruling path is proven to *raise* correctly; it has not been exercised at steady state with a human keeping the queue empty. The backpressure behavior when the queue is deep is untested in practice.

## Heavy self-documentation

During the crisis weeks, roughly 45% of filings were the system documenting itself — its own incident, its own diagnostics, its own architecture. That inflates the corpus with a topic that will not recur at that rate. The steady-state mix of real project decisions versus system-about-itself noise is not yet what the numbers reflect.

## The LLM worker writes SQL directly

The worker composes and runs SQL against the journal. The better design is known and named: the worker proposes structured output, and a deterministic layer validates it and does the writing. That layer is not built. The coverage gate is a compensating control — it catches a batch that lost items — but it is not the end-state architecture. It verifies the outcome; it does not constrain what the worker can do.

## Single-user, single-machine, bash orchestration

The loop is about 500 lines of bash (`bin/sweep.sh`), tuned to one macOS host, one user, one journal. It leans on `shlock` and an EXIT trap for the single-writer contract. For a team product this would need a rewrite in a real language with a real job runner. The current form is right for one person; it does not survive contact with concurrency or a second machine.

## Supersession and contradiction recall is unmeasured

The audits measure two things: whether anything was lost (coverage) and whether kept items were filed correctly (precision). Neither measures what the system *failed to notice* — a real supersession it never flagged. That recall number is unknown and is probably the more valuable next audit.

## Precision cannot be attributed to a tier

The `evidence` table does not record which tier — the deterministic prefilter or the LLM worker — filed each row. Retrospectively they are indistinguishable. So I cannot say whether the 11.7% wrong rate comes mostly from the loose prefilter matcher or from the LLM. Fixing the right layer requires a schema change that has not happened.

## macOS only

`sweep.sh` depends on BSD `stat -f %m` and `shlock`. It will not run as-is on Linux. The test harness ships a `timeout` shim because stock macOS has none.

## The demo uses synthetic data

The real corpus contains personal information, so it is not in this repo. The demo (`demo/demo.sh`) runs the actual pipeline against generated data. It exercises the real code paths, including the rollback, but it is not the real content.

## Why this list exists

This system's whole job is to hold honest state — to know what is true and to admit what it does not know. A system with that job has to be honest about itself, or the whole premise is a lie. Publishing the failures, the unmeasured gaps, and the design I know is better but have not built is not a disclaimer bolted on at the end. It is the same discipline the system applies to its own corpus, turned on the system. If I hid these, you should not trust anything else in the repo either.
