#!/usr/bin/env python3
"""test_coverage_gate.py — regression tests for the data-loss fix.

These are the cases that matter. Before 2026-07-08 the sweep accepted a run when
both watermarks equalled the batch targets, then deleted the batch file — so a
librarian that advanced the watermarks WITHOUT filing produced a full commit and
permanent, silent loss (measured at 74-86% on affected batches).

Each test drives the real bin/sweep.sh against a synthetic $HOME and a fake
`claude` binary whose behaviour we control:

    good    files every batch item, then advances the watermarks   -> accept
    partial advances the watermarks and files NOTHING              -> roll back
    holder  records every item as a deliberate 'unfiled' hold      -> accept

Run:  python3 -m unittest discover tests -v
"""

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LIB_HOME = os.path.dirname(HERE)
SWEEP = os.path.join(LIB_HOME, "bin", "sweep.sh")
SEED = os.path.join(HERE, "fixtures", "seed.py")

# A librarian that files every observation as evidence, then commits atomically.
SHIM_GOOD = """
import json, sqlite3, sys
b = json.load(open(sys.argv[1])); db = sqlite3.connect(sys.argv[2])
db.execute("BEGIN IMMEDIATE")
for o in b.get("observations") or []:
    db.execute("INSERT OR IGNORE INTO evidence(obs_key,authority_id,obs_date,obs_type)"
               " VALUES(?,1,?,?)", (str(o["id"]), str(o.get("date") or "")[:10], o.get("type")))
db.execute("UPDATE watermarks SET last_key=? WHERE source='claude-mem'", (str(b["cm_watermark_target"]),))
db.execute("UPDATE watermarks SET last_key=? WHERE source='assay-drain'", (str(b["drain_watermark_target"]),))
db.commit()
"""

# THE BUG, reproduced: commit the watermarks having filed nothing.
SHIM_PARTIAL = """
import json, sqlite3, sys
b = json.load(open(sys.argv[1])); db = sqlite3.connect(sys.argv[2])
db.execute("UPDATE watermarks SET last_key=? WHERE source='claude-mem'", (str(b["cm_watermark_target"]),))
db.execute("UPDATE watermarks SET last_key=? WHERE source='assay-drain'", (str(b["drain_watermark_target"]),))
db.commit()
"""

# A librarian that deliberately HOLDS everything. A hold is a valid disposition,
# so this must be accepted — the gate checks coverage, not filing volume.
SHIM_HOLDER = """
import json, sqlite3, sys
b = json.load(open(sys.argv[1])); db = sqlite3.connect(sys.argv[2])
db.execute("BEGIN IMMEDIATE")
for o in b.get("observations") or []:
    db.execute("INSERT OR IGNORE INTO unfiled(obs_key,reason) VALUES(?,'below new-authority threshold')",
               (str(o["id"]),))
db.execute("UPDATE watermarks SET last_key=? WHERE source='claude-mem'", (str(b["cm_watermark_target"]),))
db.execute("UPDATE watermarks SET last_key=? WHERE source='assay-drain'", (str(b["drain_watermark_target"]),))
db.commit()
"""


class SweepHarness(unittest.TestCase):
    """Drives the real sweep against a disposable synthetic environment."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="librarian-test-")
        self.home = os.path.join(self.root, "home")
        self.bindir = os.path.join(self.root, "bin")
        os.makedirs(self.bindir)
        subprocess.run([sys.executable, SEED, self.home, "--observations", "20",
                        "--age-seconds", "3600"], check=True, capture_output=True)
        # A private copy of the librarian tree so tests never write the real logs/.
        self.lib = os.path.join(self.root, "librarian")
        shutil.copytree(LIB_HOME, self.lib, ignore=shutil.ignore_patterns(
            "logs", "__pycache__", ".git", "tests"))
        os.makedirs(os.path.join(self.lib, "logs"))
        # `timeout` is not present on stock macOS; the sweep requires it. Provide a
        # pass-through so these tests exercise the gate, not the coreutils install.
        self._write_exec(os.path.join(self.bindir, "timeout"),
                         '#!/bin/sh\nshift\nexec "$@"\n')

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    # ---- helpers ---------------------------------------------------------

    def _write_exec(self, path, body):
        with open(path, "w") as f:
            f.write(body)
        os.chmod(path, 0o755)

    def install_librarian(self, pybody):
        """Install a fake `claude` that runs pybody against the batch + journal."""
        script = os.path.join(self.root, "librarian_impl.py")
        with open(script, "w") as f:
            f.write(textwrap.dedent(pybody))
        self._write_exec(os.path.join(self.bindir, "claude"), textwrap.dedent(f"""\
            #!/bin/bash
            # Extract the batch path the sweep appended to the prompt.
            BATCH="$(printf '%s' "${{@: -1}}" | grep -o 'BATCH FILE: [^ ]*' | tail -1 | sed 's/BATCH FILE: //')"
            {sys.executable} {script} "$BATCH" "$HOME/.assay/librarian.db"
            echo '{{"ts":"test","filed":0,"unfiled":0,"rendered":0,"notion_available":false}}'
            """))

    def run_sweep(self):
        env = dict(os.environ)
        env.update(HOME=self.home, SETTLE_BUFFER="0",
                   PATH=self.bindir + os.pathsep + env["PATH"],
                   # Pin the fake: sweep.sh puts /opt/homebrew/bin etc. ahead of PATH, so a
                   # real claude installed there would otherwise win over the shim.
                   LIBRARIAN_CLAUDE_BIN=os.path.join(self.bindir, "claude"))
        # The tick must out-age the marker for the sweep's fast path to proceed.
        os.utime(os.path.join(self.home, ".assay", "librarian.tick"), None)
        return subprocess.run(["bash", os.path.join(self.lib, "bin", "sweep.sh")],
                              env=env, capture_output=True, text=True)

    def journal(self, sql):
        db = sqlite3.connect(os.path.join(self.home, ".assay", "librarian.db"))
        try:
            return db.execute(sql).fetchall()
        finally:
            db.close()

    def watermark(self):
        return int(self.journal("SELECT last_key FROM watermarks WHERE source='claude-mem'")[0][0])

    def log(self):
        logs = os.path.join(self.lib, "logs")
        out = []
        for name in sorted(os.listdir(logs)):
            if name.startswith("sweep-"):
                with open(os.path.join(logs, name)) as f:
                    out.append(f.read())
        return "\n".join(out)

    def ledger(self):
        path = os.path.join(self.lib, "logs", "unfiled-ledger.jsonl")
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return [json.loads(line) for line in f if line.strip()]

    # ---- the cases -------------------------------------------------------

    def test_clean_run_is_accepted(self):
        """A librarian that files everything commits, and leaves no ledger behind."""
        self.install_librarian(SHIM_GOOD)
        self.run_sweep()
        self.assertIn("coverage: missing=0", self.log())
        self.assertIn("sweep: COMPLETE", self.log())
        self.assertEqual(self.watermark(), 20, "watermark should reach the batch target")
        self.assertEqual(self.ledger(), [], "a clean run must not write the loss ledger")

    def test_partial_run_rolls_watermarks_back(self):
        """THE REGRESSION. Watermarks advanced without filing must not stand."""
        self.install_librarian(SHIM_PARTIAL)
        before = self.watermark()
        self.run_sweep()
        log = self.log()
        self.assertIn("ROLLED BACK", log)
        self.assertIn("sweep: INCOMPLETE", log)
        self.assertEqual(self.watermark(), before,
                         "watermark must return to its pre-run value so the batch retries")
        self.assertNotIn("sweep: COMPLETE", log)

    def test_missing_items_are_preserved_verbatim(self):
        """Loss must be recoverable: the raw item lands in the append-only ledger."""
        self.install_librarian(SHIM_PARTIAL)
        self.run_sweep()
        entries = self.ledger()
        self.assertTrue(entries, "missing items must be written to the ledger")
        keys = {e["key"] for e in entries}
        # Only the RESIDUAL reaches the librarian: the deterministic prefilter already
        # filed the 10 run-log rows, so 10 of the 20 are the LLM's responsibility and
        # exactly those show up as missing. See test_prefilter_tier_splits_the_batch.
        self.assertEqual(len(keys), 10, "every undispositioned residual item should be captured")
        sample = entries[0]
        self.assertEqual(sample["reason"], "no-disposition-post-run")
        self.assertIn("title", sample["item"], "the full item must be recoverable, not just its id")

    def test_retry_is_bounded_then_escalates(self):
        """Three rollbacks, then accept loudly rather than livelock forever."""
        self.install_librarian(SHIM_PARTIAL)
        for _ in range(4):
            self.run_sweep()
        log = self.log()
        self.assertEqual(log.count("ROLLED BACK"), 3, "retry must be capped at 3")
        self.assertIn("HUMAN REVIEW NEEDED", log)
        self.assertIn("sweep: COMPLETE", log, "the 4th run accepts so the pipeline can move on")
        self.assertEqual(self.watermark(), 20)

    def test_deliberate_hold_counts_as_disposition(self):
        """'Held as noise' is a valid outcome — the gate checks coverage, not volume."""
        self.install_librarian(SHIM_HOLDER)
        self.run_sweep()
        self.assertIn("coverage: missing=0", self.log())
        self.assertIn("sweep: COMPLETE", self.log())
        # 10 residual rows reach the librarian; it holds all of them, and a hold is a
        # durable disposition, so coverage passes with zero evidence rows written.
        self.assertEqual(len(self.journal("SELECT obs_key FROM unfiled")), 10)
        self.assertEqual(self.ledger(), [], "deliberate holds are not losses")

    def test_unprovable_preservation_never_gives_up(self):
        """If the ledger cannot be written, the run must NEVER be accepted.

        Found by codex review 2026-07-24. The give-up path logs "items preserved in the
        ledger" and deletes the batch. If the ledger write itself failed, that claim is
        false and the batch is the only remaining copy — so an errored audit must refuse
        the give-up path and keep retrying instead. A stuck batch is recoverable; a
        deleted one is not.
        """
        # A directory where the ledger file belongs makes every append fail.
        os.makedirs(os.path.join(self.lib, "logs", "unfiled-ledger.jsonl"))
        self.install_librarian(SHIM_PARTIAL)
        for _ in range(5):          # well past the 3-retry cap
            self.run_sweep()
        log = self.log()
        self.assertIn("preservation UNPROVEN", log)
        self.assertNotIn("HUMAN REVIEW NEEDED", log, "must not take the give-up path")
        self.assertNotIn("sweep: COMPLETE", log, "must never accept an unprovable run")
        self.assertEqual(self.watermark(), 0, "watermark stays rolled back")
        self.assertTrue(os.path.exists(os.path.join(self.lib, "logs", "last-failed-batch.json")),
                        "the batch is the only surviving copy and must be retained")

    def test_retry_counter_is_keyed_on_both_watermarks(self):
        """A stale counter from a different drain batch must not cause early give-up.

        Found by codex review 2026-07-24. Keyed on the claude-mem watermark alone, a run
        where cm had nothing new but the drain did would inherit the previous batch's
        count and give up on its first attempt.
        """
        self.install_librarian(SHIM_PARTIAL)
        self.run_sweep()
        with open(os.path.join(self.lib, "logs", ".coverage-retries")) as f:
            fields = f.read().split()
        self.assertEqual(len(fields), 3, "state must record cm, drain, and count")
        self.assertEqual(fields[2], "1")
        # A counter written against a different drain watermark must not be honoured.
        with open(os.path.join(self.lib, "logs", ".coverage-retries"), "w") as f:
            f.write(f"{fields[0]} 999999999 3\n")
        self.run_sweep()
        self.assertNotIn("HUMAN REVIEW NEEDED", self.log(),
                         "a counter from a different drain batch must not trigger give-up")

    def test_prefilter_tier_splits_the_batch(self):
        """The deterministic tier files unambiguous run-log rows; the rest go to the LLM.

        Pins the tiering contract the other tests' arithmetic depends on: of 20 seeded
        observations, the 10 'change' rows resolve to a single system authority and are
        auto-filed; the 10 'discovery' rows carry judgment and must not be.
        """
        self.install_librarian(SHIM_GOOD)
        self.run_sweep()
        self.assertIn("prefiled=10 residual_obs=10", self.log())
        filed = {r[0] for r in self.journal("SELECT obs_key FROM evidence")}
        self.assertEqual(len(filed), 20, "prefiled + librarian-filed should cover the batch")


if __name__ == "__main__":
    unittest.main(verbosity=2)
