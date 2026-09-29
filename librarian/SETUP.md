# Setup

This installs the librarian on your own machine so it starts collecting decision memory from your Claude Code sessions. macOS only. Nothing leaves the machine.

## Prerequisites

- **macOS.** The sweep depends on BSD `stat` and `shlock`. There is no Linux path.
- **Python 3.9 or newer** and the `sqlite3` CLI. The macOS system `python3` and `sqlite3` both work; nothing outside the standard library is needed.
- **Claude Code, with an active subscription.** The librarian's judgment worker runs headless via `claude -p` on your own subscription. Expect roughly one short Sonnet run per active work session; many cycles run the deterministic prefilter only and cost zero LLM calls.
- **The claude-mem plugin.** This is the capture substrate — a third-party plugin that records observations ambiently from every session at near-zero attention cost. Install it inside Claude Code:

  ```
  /plugin install claude-mem@thedotmack
  ```

  Then run one session so it creates `~/.claude-mem/claude-mem.db`. This system was validated against claude-mem 13.x, and `install.sh` preflights the schema — if claude-mem has drifted past the columns the sweep reads, the install fails loudly instead of exporting empty batches days later.
- **The Assay plugin, from this same repo.** It captures tagged decisions into `~/.assay/decisions.db`, the decision drain the librarian files alongside claude-mem, and that `rule.sh` and `deposit.sh` write to. Install it inside Claude Code:

  ```
  /plugin marketplace add levievanshantz/assay
  /plugin install assay@assaylabs
  ```

  Before or after the librarian, either order works: the drain belongs to the plugin, and `install.sh` creates it with the plugin's own schema only if it is not there yet.
- **coreutils**, for `gtimeout` (the worker runs under a hard timeout):

  ```
  brew install coreutils
  ```

## Install

The librarian lives in the `librarian/` directory of the assay repo:

```bash
git clone https://github.com/levievanshantz/assay && cd assay/librarian
./install.sh
```

Read "Security model" in README.md first. `install.sh` stops before changing anything and asks you to type `bypassPermissions`; anything else aborts with nothing installed.

Pass `--backfill-days 7` to ingest the last week of existing observations instead of starting from now:

```bash
./install.sh --backfill-days 7
```

Here is everything `install.sh` touches, from its own code — nothing else:

1. **Preflight.** Checks for macOS, `sqlite3`, `python3`, `uuidgen`, `shlock`, the `claude` CLI, a `timeout`/`gtimeout`, and a claude-mem database with the schema the sweep reads.
2. **Confirm.** Prints what the scheduled worker will run (headless `claude -p --permission-mode bypassPermissions` over your observation text) and waits for you to type `bypassPermissions`. Nothing has been written at this point; any other answer exits and leaves the machine as it was.
3. **Journal.** Creates `~/.assay/librarian.db` (the journal — authorities, evidence, flags). It refuses to touch an existing journal rather than clobber it. It also makes sure `~/.assay/decisions.db` (the decision drain) exists: if the Assay plugin already created it, it is left untouched; if not, it is created with the plugin's schema, copied verbatim into `bin/decisions-schema.sql`.
4. **Hooks.** Merges two entries into `~/.claude/settings.json`: a `SessionStart` hook that injects the glossary and a `Stop` hook that ticks the sweep. Your existing settings are backed up first (to `settings.json.pre-librarian.<timestamp>`) and nothing is ever removed. If the entries are already present, this is a no-op, including when you re-run the installer through a different path to the same directory (a symlink, or `./install.sh` from inside it): hook paths are recorded and compared by their real path.
5. **Scheduler.** Renders `com.librarian.sweep.plist.template` with this directory's path and loads the launchd job `com.librarian.sweep` — a 20-minute heartbeat plus a trigger that fires within seconds of a session ending.

That is the whole footprint: two databases under `~/.assay` (the drain shared with the Assay plugin), two hook entries, one launchd job. Nothing is uploaded anywhere.

## First run

Work normally in Claude Code. Observations accumulate; ending a session ticks the sweep; sweeps file the observations; once at least three related observations exist, an authority forms; your next new session opens with the glossary block.

A healthy sweep writes these lines to `logs/sweep-YYYYMMDD.log`:

```
settle: OK (pending=0 newest_age=...s new_cm=N new_dr=0) — exporting batch
batch: observations=N drain=0 ...
prefilter: prefiled=X residual_obs=Y residual_drain=0
librarian: running (model=claude-sonnet-4-6 timeout=900s)
coverage: missing=0 ...
sweep: COMPLETE (filed run committed; marker advanced)
```

After a few sessions, `bin/health-check.sh` should show a claude-mem watermark that tracks close to the store max (small LAG), a rising authority count, and a present glossary.

## Verify

```bash
bin/health-check.sh
```

It is read-only and always exits 0. Green looks like: `SOURCES` LAG small and numeric; `LAUNCHD` line reads `loaded`; `JOURNAL` shows a nonzero `authorities` count once a few have formed; `GLOSSARY` reads `present`. Logs live in `logs/` — per-day `sweep-YYYYMMDD.log`, the append-only `librarian-runs.jsonl`, and `glossary.log`.

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.librarian.sweep.plist
rm ~/Library/LaunchAgents/com.librarian.sweep.plist
```

Then remove the two librarian hook entries from `~/.claude/settings.json` (the pre-install backup is at `~/.claude/settings.json.pre-librarian.*` if you would rather restore it). Optionally drop the librarian's data. Do not `rm -rf ~/.assay`: `decisions.db` in there is the Assay plugin's decision store.

```bash
rm -rf ~/.assay/librarian.db ~/.assay/librarian.db.pre-sweep ~/.assay/librarian.lock \
       ~/.assay/librarian.tick ~/.assay/librarian-run.* ~/.assay/glossary.md \
       ~/.assay/glossary.version ~/.assay/settle-telemetry.jsonl
```

Nothing else on your machine was touched.

## Troubleshooting

| Symptom | What it means / what to do |
|---|---|
| Sweep never fires | Check the job is loaded: `launchctl list \| grep librarian`. Check the trigger file exists: `ls ~/.assay/librarian.tick`. The sweep fires on a tick or on the 20-min heartbeat. |
| `settle: NOT settled` lines in the log | Normal during active work. The settle gate waits for claude-mem to go quiet before exporting a batch, so it holds off while you are still generating observations. |
| `sweep: INCOMPLETE ... ROLLED BACK` | The coverage gate caught a run that did not give every batch item a durable disposition. It wrote the missing items to a recovery ledger, rolled the watermarks back atomically, and will retry the batch next cycle. This is the safety net working. See POSTMORTEM.md. |
| claude-mem schema drift error at install | claude-mem has moved off the 13.x schema the sweep reads. Check your plugin version before proceeding; do not force past it. |
| `decisions.db has the narrower decisions table` at install | An older librarian install created the drain before the Assay plugin, with fewer columns than the plugin writes; plugin builds up to 2.0.0-alpha.2 then capture nothing. Run `python3 bin/init-journal.py --drain-only --repair-drain`: it adds the missing columns in place and keeps every row. |
| `install.sh: FAIL — not confirmed` | You did not type `bypassPermissions` at the confirmation prompt. Nothing was installed. See "Security model" in README.md. |
| Worker timeout | A single `claude -p` run exceeded its hard timeout. The batch is not committed and retries next cycle. Frequent timeouts usually mean an unusually large batch — the next few cycles drain it down. |
