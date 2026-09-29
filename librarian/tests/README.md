# Tests

Regression tests for the 2026-07-08 data-loss fix (see `POSTMORTEM.md` in
`librarian/` for the full story), for install order against the Assay plugin, and
for the installer's consent gate.

```bash
python3 -m unittest discover tests -v
```

No dependencies beyond the stdlib and `sqlite3`. Each test builds a synthetic
`$HOME` (`fixtures/seed.py`) with its own journal, memory substrate, and drain
database, then drives the real `bin/sweep.sh` against a fake `claude` binary
whose filing behaviour the test controls. Nothing touches `~/.assay`.

`test_install_order.py` also runs the real Assay plugin Stop hook from this repo
(`../plugin/scripts/stop-hook.cjs`) when `node` can load the vendored
`better-sqlite3` (Node 22 on arm64 macOS); otherwise those two tests skip and the
emulated-plugin variants still run. `test_unattended_gate.py` runs `install.sh`
against fake `launchctl` and `claude` binaries and asserts they are the ones on
PATH before it starts; the real ones never run.

## What is pinned

| Test | Contract |
|---|---|
| `test_clean_run_is_accepted` | full coverage commits and writes no loss ledger |
| `test_partial_run_rolls_watermarks_back` | **the regression** — watermarks advanced without filing are reverted |
| `test_missing_items_are_preserved_verbatim` | undispositioned items land in the append-only ledger, recoverable in full |
| `test_retry_is_bounded_then_escalates` | 3 rollbacks, then accept loudly instead of livelocking |
| `test_deliberate_hold_counts_as_disposition` | a recorded hold is a valid outcome; the gate checks coverage, not volume |
| `test_unprovable_preservation_never_gives_up` | a failed ledger write refuses the give-up path forever — the batch is the only surviving copy |
| `test_retry_counter_is_keyed_on_both_watermarks` | a stale counter from a different drain batch must not cause early give-up |
| `test_prefilter_tier_splits_the_batch` | deterministic tier files run-log rows; judgment rows go to the LLM |
| `test_schema_file_matches_plugin_source` / `..._shipped_plugin_bundle` | `bin/decisions-schema.sql` builds exactly the plugin's drain schema (src/ and the built bundle) |
| `test_librarian_first_then_{real,emulated}_plugin` | **the regression** — a librarian-created drain is the plugin's schema, and the plugin captures into it |
| `test_plugin_first_then_librarian_{real,emulated}` | install leaves a plugin-created drain untouched; plugin, `deposit.sh`, `rule.sh` and the sweep all keep working |
| `test_legacy_drain_is_refused_then_repaired_in_place` | the narrow drain older installs made is refused before anything is written, and `--repair-drain` fixes it without losing rows |
| `test_wrong_or_missing_confirmation_installs_nothing` | `install.sh` writes nothing (no journal, hooks, plist or launchctl call) without the typed `bypassPermissions` |
| `test_confirmed_install_from_the_monorepo_subdirectory` | installing from `assay/librarian/`, from any cwd, renders every path correctly; re-running is idempotent |
| `test_reinstall_through_a_different_path_to_the_same_directory_adds_no_hooks` | **the regression** — installing via a symlinked path and again via the real path (either way round) leaves exactly one `SessionStart` and one `Stop` hook |
| `test_reinstall_recognizes_hooks_an_earlier_install_wrote_with_an_unresolved_path` | hooks an older install recorded under a symlinked path count as already wired |
| `test_default_is_unchanged_bypass_permissions` / `test_mode_and_allowlist_are_overridable` | what `sweep.sh` passes the worker, by default and with `LIBRARIAN_PERMISSION_MODE` / `LIBRARIAN_ALLOWED_TOOLS` |
| `test_pinned_worker_beats_a_claude_earlier_on_the_sweep_path` | `LIBRARIAN_CLAUDE_BIN` wins over a `claude` on the PATH the sweep builds, so fakes stay fakes |

## Verifying the tests actually bite

A regression test that never fails proves nothing. These were each verified to
FAIL against the code that predates the fix they pin:

- The first five were run against the pre-fix sweep (watermark-equality check
  only, no coverage audit): **5 of 6 then-existing tests failed.** The survivor
  (`test_prefilter_tier_splits_the_batch`) pins the tiering contract, which the
  fix did not touch.
- The two review-derived tests (`test_unprovable_preservation_never_gives_up`,
  `test_retry_counter_is_keyed_on_both_watermarks`) were run against the fix
  as it stood before the 2026-07-24 external review: **both failed.**
- `test_install_order.py` was run against the `init-journal.py` imported with
  the librarian (before the drain fix): **5 of 7 failed.** The two survivors are
  the schema-parity checks, which do not run `init-journal.py`. The two
  plugin-first tests fail there only on the new "left untouched" report: the
  old code did not break that order, only librarian-first.
- The two re-install tests were run against the `install.sh` that recorded
  `pwd` rather than `pwd -P` and compared hook commands as raw strings: **both
  failed**, each with duplicated `SessionStart` and `Stop` hooks (or no
  "already wired" report), on a temp dir with no symlink of its own. Before
  the fix, `test_confirmed_install_from_the_monorepo_subdirectory` also failed
  (`2 != 1` hooks) whenever `$TMPDIR` sat under a symlink, as macOS's
  `/var/folders` does.

The librarian was imported into this repo as a single snapshot of a private
working repo, so the coverage-gate bite-check is recorded here rather than
reproducible from this history. To reproduce the spirit of it: revert the
`(f2) COVERAGE AUDIT` block in `bin/sweep.sh` to a plain watermark-equality
check and watch the suite light up. The install-order one is reproducible from
history: restore `bin/init-journal.py` from the commit that added it, keep the
current tests, and run `python3 -m unittest tests.test_install_order`. That
commit is the one this prints:

```bash
git log --first-parent --diff-filter=A --format=%h -- bin/init-journal.py
```

## Known limitation

macOS only. `sweep.sh` depends on BSD `stat -f %m` and `shlock`; the harness
supplies a `timeout` shim because stock macOS has none.
