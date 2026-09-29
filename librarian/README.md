# Librarian

In July this system silently dropped 74-86% of the observations it was supposed to file. It found the loss itself: it measured that only 6 of its own 23 diagnostic observations had survived a batch, a 73.9% loss, and reported the number. This directory is the fix and the proof that it holds. Two numbers carry the story. Coverage: 6,599 of 6,599 observations dispositioned, 100.00%, over 12 days, audited independently against the source database. Precision: 83.3% of filings land on the right authority (120-row reproducible sample, four judges). The honest claim is: nothing is lost, and about 88% of what is kept is filed defensibly.

## What it is

A person working with AI assistants makes decisions faster than memory keeps up. An ambient tool records every observation from every session. Recording is not the problem; knowing what is still true is. This system files those observations into an append-only SQLite journal (authorities, evidence, flags) and compiles a glossary of what is still true into the top of every new session. It runs unattended every ~20 minutes. There is exactly one writer to the journal, ever.

It is a scribe, not a judge. When it sees a contradiction or a possible supersession, it does not decide which claim wins — it files a flag for a human to rule on. That stance is deliberate: a wrongly asserted supersession is invisible data loss, so when unsure the system does less and leaves a flag. A deterministic prefilter files unambiguous run-log rows on its own, so some cycles make zero LLM calls; the rest go to a headless worker on your own Claude subscription.

## Requirements

- **macOS.** The sweep uses BSD `stat`, `shlock` and launchd. There is no Linux path.
- **Claude Code CLI** (`claude` on your PATH) with an active subscription. The judgment worker runs headless via `claude -p`.
- **claude-mem 13.x**, the capture substrate: `/plugin install claude-mem@thedotmack`, then run one session so `~/.claude-mem/claude-mem.db` exists. `install.sh` fails loudly if its schema has drifted.
- **The Assay plugin from this same repo**: `/plugin marketplace add levievanshantz/assay`, then `/plugin install assay@assaylabs`. It captures tagged decisions into `~/.assay/decisions.db`, the drain the Librarian files alongside claude-mem. Install it before or after the Librarian; the order does not matter.
- **Python 3.9 or newer** (the macOS system `python3` works; standard library only), the `sqlite3` CLI (ships with macOS), and **coreutils** for `timeout`/`gtimeout` (`brew install coreutils`).

## Install it

Three steps — see SETUP.md for the full walkthrough.

```bash
# 1. In Claude Code, install claude-mem and the Assay plugin, then run one session:
#    /plugin install claude-mem@thedotmack
#    /plugin marketplace add levievanshantz/assay
#    /plugin install assay@assaylabs
# 2. Clone this repo. The Librarian lives in its librarian/ directory:
git clone https://github.com/levievanshantz/assay && cd assay/librarian
# 3. Read "Security model" below, then install. It asks you to type bypassPermissions:
./install.sh
```

`install.sh` shows you what the scheduled worker will run and installs nothing unless you type the confirmation. Then it creates `~/.assay/librarian.db`, creates `~/.assay/decisions.db` with the Assay plugin's own schema if the plugin has not already made it, wires two hooks into `~/.claude/settings.json` (backup taken first, nothing removed), and loads a launchd sweep job. Then you work normally and your memory starts collecting. See OPERATING.md for the day-to-day loop.

## Security model

Read this before installing. The Librarian runs an AI agent on a timer, unattended, with every permission.

**What runs, and how often.** `install.sh` loads a launchd job, `com.librarian.sweep`, that starts `bin/sweep.sh` every 20 minutes and within seconds of each Claude Code turn ending (the Stop hook touches a tick file; launchd throttles this to once per 2 minutes). Most runs find nothing new and exit in under a second. When there is new work, the sweep exports a batch, lets the deterministic prefilter file what it can, and hands the rest to:

```
claude -p --model claude-sonnet-4-6 --permission-mode bypassPermissions \
  --settings '{"enabledPlugins":{},"hooks":{}}' "<prompts/librarian.md> BATCH FILE: … · RUNS LOG: …"
```

That runs as your macOS user, on your Claude subscription, under a 900-second hard timeout.

**With what permissions.** `bypassPermissions` means no permission prompts: the worker can run any shell command, read and write any file your user can, reach the network, and use any MCP connector that headless session can see. The `--settings` override only switches off plugins and hooks for the worker's own session (so claude-mem does not record the librarian at work); it does not restrict tools. There is no sandbox.

**What the worker actually needs.** Per `prompts/librarian.md`: read the batch file (in a private `~/.assay/librarian-run.*` directory), run `sqlite3` against `~/.assay/librarian.db`, append one line to `logs/librarian-runs.jsonl` with `printf … >>`, and, only if Notion is connected, `ToolSearch` plus three Notion tools (`notion-fetch`, `notion-update-page`, `notion-create-pages`). Everything beyond that is headroom the default grants and the procedure does not use.

**The prompt-injection risk.** The batch carries verbatim text: claude-mem observation titles, subtitles, facts and narratives, and decision bodies from the drain. That text comes from whatever your sessions touched: web pages, files, tool output, pasted content. Anything that reached a session can reach the worker's prompt. The prompt marks batch text as untrusted data and tells the worker never to follow instructions inside it, but that is an instruction to a model, not an enforcement boundary. A crafted observation the worker obeyed would run with the permissions above, every 20 minutes, with nobody watching.

**What limits the damage today.** The coverage gate checks that every batch item got a disposition, the journal is backed up to `~/.assay/librarian.db.pre-sweep` before each worker run, every file the sweep creates is owner-only, and each run is time-boxed. All of that protects the journal. None of it limits what an injected command could do outside the journal.

**Your options.**

- **Decline.** `install.sh` changes nothing unless you type `bypassPermissions` at its prompt.
- **Run it by hand.** Skip `install.sh`: create the journal with `python3 bin/init-journal.py` and run `touch ~/.assay/librarian.tick && bin/sweep.sh` yourself when you choose (without the tick the sweep treats the run as a no-op). It starts the same worker, but not while you are away. `LIBRARIAN_DRY_RUN=1 bin/sweep.sh` exports and verifies a batch (kept for you to read) without ever starting claude.
- **Narrow the worker.** `bin/sweep.sh` reads `LIBRARIAN_PERMISSION_MODE` (default `bypassPermissions`) and `LIBRARIAN_ALLOWED_TOOLS` (passed as `--allowedTools`). For the scheduled job, add them to the `EnvironmentVariables` dict in `~/Library/LaunchAgents/com.librarian.sweep.plist`, then `launchctl unload` and `launchctl load` that file. **No tighter setting has been verified against a real run.** If the worker is denied a tool it needs (most likely `sqlite3`), the watermarks never advance and the batch retries every cycle: nothing is lost, but nothing is filed either. Check `logs/sweep-YYYYMMDD.log` after any change.

## Try it without installing

```bash
cd demo && ./demo.sh
```

Synthetic data, no API key, nothing touched outside the repo. Then read `demo/FAILURE_DEMO.md` to watch the rollback fire on a deliberately broken run.

## The loop

```
  source DB ──▶ settle gate ──▶ export batch ──▶ prefilter ──▶ LLM worker
 (read-only)   (quiet 10min?)                  (obvious rows)  (judgment rows)
                                                                     │
                                                                     ▼
                          commit  ◀──── coverage audit ────▶  rollback + retry
                     (watermarks         every item has a       (bounded at 3;
                      advance)           durable disposition?    batch re-exports)
```

If any batch item ends a run with no disposition, the missing items are written verbatim to an append-only recovery ledger *before* anything else, the watermarks roll back atomically, and the batch retries. If preservation cannot be proven, the run is never accepted.

## Repo map

| Path | What it is |
|---|---|
| `README.md` | This file |
| `SETUP.md` | Install, verify, uninstall, troubleshooting |
| `OPERATING.md` | The day-to-day loop: glossary, flags, rulings |
| `install.sh` | One-shot installer: journal, hooks, scheduler |
| `com.librarian.sweep.plist.template` | launchd job (heartbeat + turn-end trigger) |
| `ARCHITECTURE.md` | Zero-to-deep design walkthrough |
| `POSTMORTEM.md` | The July data-loss incident and the fix |
| `PRECISION-AUDIT.md` | The 83.3% filing-precision measurement |
| `LIMITATIONS.md` | Every known weakness, stated plainly |
| `DECISIONS.md` | The design calls and their reasons |
| `bin/` | `sweep.sh` (the loop), `coverage-verify.py` (the gate), `prefilter.py`, `rule.sh` + `deposit.sh` (your inputs), `health-check.sh`, `init-journal.py` + `decisions-schema.sql` (the Assay plugin's drain schema, verbatim) |
| `prompts/` | The librarian worker prompt |
| `tests/` | Regression tests: the data-loss fix, install order with the Assay plugin, the install consent gate |
| `tools/` | `precision-sample.py`, the reproducible audit draw |
| `demo/` | Self-contained walkthrough on synthetic data |

## Read next

- `SETUP.md` — install it on your machine
- `OPERATING.md` — run it day to day
- `POSTMORTEM.md` — what broke and how it was fixed
- `PRECISION-AUDIT.md` — how good the filing actually is
- `LIMITATIONS.md` — what this still does not do

The Librarian lives in the `librarian/` directory of the [assay](https://github.com/levievanshantz/assay) repo. It was imported as a single snapshot of a private working repo, so its history here starts at that import. Logs and databases are excluded by design: they contain personal data.
