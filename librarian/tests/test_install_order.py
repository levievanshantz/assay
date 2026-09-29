#!/usr/bin/env python3
"""test_install_order.py — the librarian and the Assay plugin share ~/.assay/decisions.db.

The plugin owns that file: its Stop hook opens it with `CREATE TABLE IF NOT EXISTS
decisions (...)` and then indexes supersedes_resolved_id. Older librarian installs created
a narrower `decisions` table first. The plugin's IF NOT EXISTS then kept the narrow table,
the index failed with "no such column: supersedes_resolved_id", and every capture
degraded silently (the hook still exits 0). These tests pin the fix from both sides:

    librarian first, then plugin   the plugin must still capture
    plugin first, then librarian   the librarian must leave the plugin's drain alone
    legacy narrow drain            refused loudly, repairable in place without losing rows

Where the real plugin can run (node + the repo's plugin/ bundle with a loadable
better-sqlite3), the plugin side is the shipped plugin/scripts/stop-hook.cjs fed a
synthetic JSONL transcript. Otherwise those tests skip, and an emulation that executes the
plugin's own schema text and INSERT column list (read from src/) still runs. The emulation
deliberately skips any column self-repair newer plugin builds do on open, so it also proves
the librarian's drain never needs one.

Everything happens under a temporary $HOME. Nothing touches ~/.assay or ~/.claude-mem.

Run:  python3 -m unittest discover tests -v
"""

import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
LIB_HOME = os.path.dirname(HERE)
REPO_ROOT = os.path.dirname(LIB_HOME)
INIT = os.path.join(LIB_HOME, "bin", "init-journal.py")
SCHEMA_SQL = os.path.join(LIB_HOME, "bin", "decisions-schema.sql")
PLUGIN_SCHEMA_TS = os.path.join(REPO_ROOT, "src", "decisions", "schema.ts")
PLUGIN_STORE_TS = os.path.join(REPO_ROOT, "src", "decisions", "store.ts")
PLUGIN_HOOK = os.path.join(REPO_ROOT, "plugin", "scripts", "stop-hook.cjs")
PLUGIN_SQLITE = os.path.join(REPO_ROOT, "plugin", "node_modules", "better-sqlite3")

# The table older librarian installs created (librarian-handoff bb88a0c, init-journal.py).
LEGACY_DRAIN = """
CREATE TABLE IF NOT EXISTS decisions(
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'conflict')),
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'tentative',
    confidence REAL,
    layer TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
"""

_spec = importlib.util.spec_from_file_location("seed", os.path.join(HERE, "fixtures", "seed.py"))
seed = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(seed)


# ---- reading the plugin's schema from its own sources --------------------------------------

def _plugin_schema(path, version_re, schema_re):
    with open(path) as f:
        src = f.read()
    version = re.search(version_re, src).group(1)
    body = re.search(schema_re, src, re.S).group(1)
    body = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), body)
    return body.replace("${SCHEMA_VERSION}", version)


def plugin_schema_from_source():
    return _plugin_schema(PLUGIN_SCHEMA_TS, r"export const SCHEMA_VERSION\s*=\s*(\d+)\s*;",
                          r"export const SCHEMA\s*=\s*`(.*?)`;")


def plugin_schema_from_bundle():
    return _plugin_schema(PLUGIN_HOOK, r"var SCHEMA_VERSION\s*=\s*(\d+)\s*;",
                          r"var SCHEMA\s*=\s*`(.*?)`;")


def plugin_insert_columns():
    """The column list of the plugin's deposit INSERT, as src/decisions/store.ts writes it."""
    with open(PLUGIN_STORE_TS) as f:
        src = f.read()
    m = re.search(r"INSERT INTO decisions\s*\(([^)]*)\)", src)
    return [c.strip() for c in m.group(1).split(",")]


def read(path):
    with open(path) as f:
        return f.read()


def _connect(path):
    db = sqlite3.connect(path)
    if sqlite3.sqlite_version_info < (3, 38, 0):
        db.create_function("unixepoch", 0, lambda: int(time.time()))
    return db


def signature(db):
    """Everything schema-shaped about a database, whitespace-normalised."""
    rows = db.execute("SELECT type, name, tbl_name, sql FROM sqlite_master "
                      "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").fetchall()
    has_migrations = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' "
                                "AND name='schema_migrations'").fetchone()
    versions = ([r[0] for r in db.execute("SELECT version FROM schema_migrations ORDER BY version")]
                if has_migrations else None)
    return [(t, n, tb, " ".join((s or "").split())) for t, n, tb, s in rows], versions


def signature_of_sql(sql):
    db = _connect(":memory:")
    db.executescript(sql)
    try:
        return signature(db)
    finally:
        db.close()


_REAL_PLUGIN = None


def real_plugin_available():
    """(ok, reason). The shipped hook needs node and a better-sqlite3 built for that node."""
    global _REAL_PLUGIN
    if _REAL_PLUGIN is None:
        node = shutil.which("node")
        if not node:
            _REAL_PLUGIN = (False, "node not on PATH")
        elif not os.path.exists(PLUGIN_HOOK):
            _REAL_PLUGIN = (False, f"no plugin bundle at {PLUGIN_HOOK}")
        else:
            probe = subprocess.run(
                [node, "-e", "const D=require(process.argv[1]); new D(':memory:').close()",
                 PLUGIN_SQLITE], capture_output=True, text=True)
            _REAL_PLUGIN = (probe.returncode == 0,
                            "better-sqlite3 in plugin/node_modules does not load under this node: "
                            + probe.stderr.strip()[-200:])
    return _REAL_PLUGIN


class InstallOrder(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="librarian-order-")
        self.home = os.path.join(self.root, "home")
        os.makedirs(os.path.join(self.home, ".claude-mem"))
        # The claude-mem substrate init-journal.py preflights (same schema as the sweep fixture).
        cm = sqlite3.connect(os.path.join(self.home, ".claude-mem", "claude-mem.db"))
        cm.executescript(seed.CM_SCHEMA)
        cm.commit()
        cm.close()
        self.drain = os.path.join(self.home, ".assay", "decisions.db")
        self.n_transcripts = 0

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    # ---- helpers ---------------------------------------------------------

    def env(self):
        env = dict(os.environ)
        env["HOME"] = self.home
        # Never let the caller's environment redirect or silence the plugin under test.
        for k in ("ASSAY_DB_PATH", "ECC_HOOK_PROFILE", "ECC_DISABLED_HOOKS"):
            env.pop(k, None)
        return env

    def init(self, *args):
        return subprocess.run([sys.executable, INIT, *args], env=self.env(),
                              capture_output=True, text=True)

    def capture_real(self, body):
        """Run the shipped plugin Stop hook over a synthetic JSONL transcript."""
        ok, why = real_plugin_available()
        if not ok:
            self.skipTest(why)
        self.n_transcripts += 1
        transcript = os.path.join(self.root, f"transcript-{self.n_transcripts}.jsonl")
        with open(transcript, "w") as f:
            f.write(json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [
                {"type": "text", "text": f"Noted. <assay-decision>{body}</assay-decision>"}]}}) + "\n")
        p = subprocess.run(["node", PLUGIN_HOOK], env=self.env(), capture_output=True, text=True,
                           input=json.dumps({"transcript_path": transcript,
                                             "session_id": "synthetic-session"}))
        self.assertEqual(p.returncode, 0, p.stderr)
        result = json.loads(p.stdout.strip().splitlines()[-1]).get("assay", {})
        self.assertTrue(result.get("ok"), f"plugin hook degraded: {result} stderr={p.stderr!r}")
        self.assertEqual(result.get("decisions_captured"), 1, result)
        self.assertFalse(os.path.exists(os.path.join(self.home, ".assay", "errors.jsonl")),
                         "the plugin logged an error")

    def capture_emulated(self, body):
        """What the plugin's DecisionStore does: open, run its schema, insert its columns."""
        if not (os.path.exists(PLUGIN_SCHEMA_TS) and os.path.exists(PLUGIN_STORE_TS)):
            self.skipTest("plugin sources not present next to librarian/")
        os.makedirs(os.path.dirname(self.drain), exist_ok=True)
        db = _connect(self.drain)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA foreign_keys=ON")
            db.executescript(plugin_schema_from_source())
            now = int(time.time() * 1000)
            rid = str(uuid.uuid4())
            values = {"id": rid, "kind": "decision", "body": body, "status": "tentative",
                      "confidence": None, "layer": None, "supersedes_raw": None,
                      "source_session_id": "synthetic-session",
                      "source_transcript_path": "/synthetic/transcript.jsonl",
                      "source_span_start": 0, "source_span_end": len(body),
                      "created_at": now, "updated_at": now}
            cols = plugin_insert_columns()
            unknown = [c for c in cols if c not in values]
            self.assertEqual(unknown, [], "plugin INSERT gained columns this emulation does not know")
            db.execute(f"INSERT INTO decisions ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                       [values[c] for c in cols])
            db.execute("INSERT INTO decision_transitions (decision_id, from_status, to_status, reason, "
                       "transitioned_at) VALUES (?, NULL, 'tentative', 'initial deposit', ?)", (rid, now))
            db.commit()
        finally:
            db.close()

    def bodies(self):
        db = sqlite3.connect(self.drain)
        try:
            return sorted(r[0] for r in db.execute("SELECT body FROM decisions"))
        finally:
            db.close()

    def drain_signature(self):
        db = _connect(self.drain)
        try:
            return signature(db)
        finally:
            db.close()

    def deposit_and_rule(self):
        """rule.sh and deposit.sh are the librarian's own writers into the plugin's drain."""
        env = self.env()
        d = subprocess.run(["bash", os.path.join(LIB_HOME, "bin", "deposit.sh"),
                            "Synthetic: deposit a decision by hand."],
                           env=env, capture_output=True, text=True)
        self.assertEqual(d.returncode, 0, d.stderr)
        r = subprocess.run(["bash", os.path.join(LIB_HOME, "bin", "rule.sh"),
                            "flag #1: synthetic ruling, confirmed"],
                           env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def sweep_exports_drain(self, expected_rows):
        """A DRY_RUN sweep (never invokes claude) must read the drain and export new rows."""
        lib = os.path.join(self.root, "librarian")
        shutil.copytree(LIB_HOME, lib, ignore=shutil.ignore_patterns(
            "logs", "__pycache__", ".git", "tests"))
        os.makedirs(os.path.join(lib, "logs"))
        env = self.env()
        env.update(SETTLE_BUFFER="0", LIBRARIAN_DRY_RUN="1",
                   LIBRARIAN_CLAUDE_BIN="/usr/bin/false")   # belt and braces: never a real claude
        p = subprocess.run(["bash", os.path.join(lib, "bin", "sweep.sh")], env=env,
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        log = "".join(read(os.path.join(lib, "logs", n))
                      for n in sorted(os.listdir(os.path.join(lib, "logs"))) if n.startswith("sweep-"))
        self.assertNotIn("SOURCE READ ERROR", log)
        self.assertIn(f"batch: observations=0 drain={expected_rows} ", log)

    # ---- the schema file is the plugin's schema ---------------------------

    def test_schema_file_matches_plugin_source(self):
        """bin/decisions-schema.sql must build exactly what src/decisions/schema.ts builds."""
        if not os.path.exists(PLUGIN_SCHEMA_TS):
            self.skipTest("plugin source not present next to librarian/")
        with open(SCHEMA_SQL) as f:
            ours = signature_of_sql(f.read())
        self.assertEqual(ours, signature_of_sql(plugin_schema_from_source()),
                         "drain schema drifted from the plugin — copy src/decisions/schema.ts "
                         "into bin/decisions-schema.sql again (and see init-journal --repair-drain)")

    def test_schema_file_matches_shipped_plugin_bundle(self):
        """...and exactly what the shipped plugin/scripts/stop-hook.cjs builds."""
        if not os.path.exists(PLUGIN_HOOK):
            self.skipTest("plugin bundle not present next to librarian/")
        with open(SCHEMA_SQL) as f:
            ours = signature_of_sql(f.read())
        self.assertEqual(ours, signature_of_sql(plugin_schema_from_bundle()))

    # ---- librarian first, then plugin -------------------------------------

    def _librarian_first(self, capture):
        p = self.init()
        self.assertEqual(p.returncode, 0, p.stderr)
        # Before the plugin ever runs, the drain is exactly the plugin's schema, so it never
        # depends on the plugin repairing someone else's table.
        self.assertEqual(self.drain_signature(), signature_of_sql(plugin_schema_from_source()),
                         "librarian-created drain differs from the plugin's schema")
        # THE REGRESSION: on the old narrow table, plugin builds up to 2.0.0-alpha.2 degraded
        # right here ("no such column: supersedes_resolved_id") and captured nothing.
        capture("Synthetic: cache widget totals nightly.")
        self.assertEqual(self.bodies(), ["Synthetic: cache widget totals nightly."])
        self.assertIn("created with the Assay plugin schema", p.stdout)
        self.deposit_and_rule()
        # init set the drain watermark to "now", so all three rows are new to the sweep.
        self.sweep_exports_drain(expected_rows=3)

    def test_librarian_first_then_real_plugin(self):
        self._librarian_first(self.capture_real)

    def test_librarian_first_then_emulated_plugin(self):
        self._librarian_first(self.capture_emulated)

    # ---- plugin first, then librarian -------------------------------------

    def _plugin_first(self, capture):
        capture("Synthetic: widget collector retries twice.")
        before = self.drain_signature()
        p = self.init()
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("left untouched", p.stdout)
        self.assertEqual(self.drain_signature(), before, "init must not alter the plugin's drain")
        self.assertEqual(self.bodies(), ["Synthetic: widget collector retries twice."])
        capture("Synthetic: widget totals use the median.")
        self.deposit_and_rule()
        # The pre-install row predates the drain watermark by design (installs start at "now").
        self.sweep_exports_drain(expected_rows=3)

    def test_plugin_first_then_librarian_real(self):
        self._plugin_first(self.capture_real)

    def test_plugin_first_then_librarian_emulated(self):
        self._plugin_first(self.capture_emulated)

    # ---- the narrow table older installs left behind ------------------------

    def test_legacy_drain_is_refused_then_repaired_in_place(self):
        os.makedirs(os.path.dirname(self.drain))
        db = sqlite3.connect(self.drain)
        db.executescript(LEGACY_DRAIN)
        db.execute("INSERT INTO decisions(id, kind, body, status, layer, created_at, updated_at) "
                   "VALUES('5e1f0000-0000-4000-8000-000000000001', 'decision', "
                   "'Synthetic: pre-existing ruling.', 'tentative', 'ruling', 1, 1)")
        db.commit()
        db.close()

        refused = self.init()
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("--repair-drain", refused.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.home, ".assay", "librarian.db")),
                         "a refused install must not leave a half-built journal")

        repaired = self.init("--drain-only", "--repair-drain")
        self.assertEqual(repaired.returncode, 0, repaired.stderr)
        self.assertIn("repaired in place", repaired.stdout)
        self.assertEqual(self.bodies(), ["Synthetic: pre-existing ruling."], "rows must survive")

        ok, _ = real_plugin_available()
        (self.capture_real if ok else self.capture_emulated)("Synthetic: after repair.")
        self.assertEqual(len(self.bodies()), 2)
        again = self.init("--drain-only")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn("left untouched", again.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
