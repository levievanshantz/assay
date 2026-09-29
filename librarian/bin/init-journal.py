#!/usr/bin/env python3
# Pre-existing style in an audited ops script; behavior changes only. pylint: disable=consider-using-with,f-string-without-interpolation,inconsistent-return-statements,invalid-name,line-too-long,missing-function-docstring,too-many-locals,too-many-statements,unspecified-encoding
"""init-journal.py — create the journal and decision drain for a fresh install.

Idempotent by refusal: if ~/.assay/librarian.db already exists this script stops
rather than touching it (--force to recreate, which DESTROYS the existing journal).

What it does:
  1. Preflight the claude-mem substrate: the DB must exist and its `observations`
     table must carry the columns the sweep exports. A schema drift here fails NOW,
     loudly, instead of as a mysterious empty batch three days in.
  2. Create ~/.assay/librarian.db with the production schema (append-only unique
     indexes included) and no rows.
  3. Set the watermarks: claude-mem to the CURRENT max observation id — the system
     starts from "now" and does not try to ingest your entire history. Pass
     --backfill-days N to start N days back instead. The drain watermark starts at
     the current epoch so only new rule.sh/deposit.sh rows flow.
  4. The decision drain, ~/.assay/decisions.db. The Assay plugin owns this file (its
     Stop hook writes every captured decision there); rule.sh and deposit.sh append to
     it too. Install order must not matter, so:
       - absent  -> create it with the plugin's own schema, verbatim
                    (bin/decisions-schema.sql), so the plugin later finds exactly
                    the schema it would have created itself;
       - present with the plugin schema -> left untouched;
       - present with the narrower table older librarian installs created ->
         refuse (the plugin cannot write to it) unless --repair-drain, which adds
         the missing columns in place. Existing rows are kept.
     The drain is checked BEFORE the journal is created, so a refusal leaves nothing
     half-installed.
  5. Touch the tick file so the first sweep can fire.

Usage:
    python3 bin/init-journal.py [--backfill-days N] [--force]
    python3 bin/init-journal.py --drain-only [--repair-drain]   # drain only; journal untouched
"""

import argparse
import os
import sqlite3
import sys
import time

HOME = os.path.expanduser("~")
ASSAY = os.path.join(HOME, ".assay")
JOURNAL = os.path.join(ASSAY, "librarian.db")
DRAIN = os.path.join(ASSAY, "decisions.db")
CM_DB = os.path.join(HOME, ".claude-mem", "claude-mem.db")
DRAIN_SCHEMA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "decisions-schema.sql")

# The columns the sweep's batch exporter actually reads. If claude-mem's schema has
# drifted past these, the install must fail here, not silently later.
REQUIRED_OBS_COLUMNS = {"id", "created_at", "type", "title", "subtitle", "facts",
                        "narrative", "created_at_epoch"}

JOURNAL_SCHEMA = """
CREATE TABLE authorities(id INTEGER PRIMARY KEY, name TEXT UNIQUE, domain TEXT, kind TEXT,
    status TEXT, one_line TEXT, notion_page_id TEXT, first_seen TEXT, last_evidence TEXT,
    dirty INTEGER DEFAULT 0);
CREATE TABLE evidence(obs_key TEXT, authority_id INTEGER, obs_date TEXT, obs_type TEXT,
    role TEXT DEFAULT 'primary', PRIMARY KEY(obs_key, authority_id));
CREATE TABLE flags(id INTEGER PRIMARY KEY AUTOINCREMENT, authority_id INTEGER, class TEXT,
    text TEXT, status TEXT DEFAULT 'open', created TEXT DEFAULT (datetime('now')), closed_by TEXT);
CREATE TABLE aliases(alias TEXT, authority_id INTEGER);
CREATE TABLE edges(src INTEGER, dst INTEGER, type TEXT, note TEXT);
CREATE TABLE watermarks(source TEXT PRIMARY KEY, last_key TEXT, updated TEXT);
CREATE TABLE writer_lock(id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER, started TEXT);
CREATE TABLE unfiled(obs_key TEXT PRIMARY KEY, reason TEXT, ts TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX ux_aliases ON aliases(alias, authority_id);
CREATE UNIQUE INDEX ux_edges ON edges(src, dst, type);
CREATE UNIQUE INDEX ux_flags_dedupe ON flags(authority_id, class, text);
"""

def fail(msg):
    print(f"init-journal: FAIL — {msg}", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------------------
# The decision drain. Its schema is the Assay plugin's, never ours: see decisions-schema.sql.
# ---------------------------------------------------------------------------------------

def drain_schema_sql():
    try:
        with open(DRAIN_SCHEMA_FILE) as f:
            return f.read()
    except OSError as e:
        fail(f"drain schema missing at {DRAIN_SCHEMA_FILE}: {e}")


def open_drain(path):
    """Open the drain the way the plugin does (WAL, foreign keys on).

    The plugin's schema stamps schema_migrations with unixepoch(), which SQLite only has
    from 3.38. Python builds linked against an older library get an equivalent shim, so
    the SQL can stay byte-for-byte the plugin's.
    """
    db = sqlite3.connect(path)
    db.execute("PRAGMA busy_timeout=5000")
    if sqlite3.sqlite_version_info < (3, 38, 0):
        db.create_function("unixepoch", 0, lambda: int(time.time()))
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db


def plugin_decision_columns():
    """[(name, declared type)] of the plugin's decisions table, read from the schema file."""
    mem = sqlite3.connect(":memory:")
    if sqlite3.sqlite_version_info < (3, 38, 0):
        mem.create_function("unixepoch", 0, lambda: int(time.time()))
    mem.executescript(drain_schema_sql())
    cols = [(r[1], r[2], bool(r[3])) for r in mem.execute("PRAGMA table_info(decisions)")]
    mem.close()
    return cols


def inspect_drain():
    """Read-only look at an existing drain.

    Returns (state, missing_columns):
      'absent'  — no file yet
      'empty'   — file exists but has no decisions table
      'ok'      — decisions table carries every column the plugin writes
      'legacy'  — only nullable plugin columns are missing (the older librarian table)
      'foreign' — anything else; never touched
    """
    if not os.path.exists(DRAIN):
        return "absent", []
    try:
        db = sqlite3.connect(f"file:{DRAIN}?mode=rw", uri=True)
        db.execute("PRAGMA query_only=1")
        db.execute("PRAGMA busy_timeout=5000")
        have = {r[1] for r in db.execute("PRAGMA table_info(decisions)")}
        db.close()
    except sqlite3.Error as e:
        fail(f"could not read the existing drain at {DRAIN}: {e}")
    if not have:
        return "empty", []
    plugin = plugin_decision_columns()
    missing = [(n, t, notnull) for n, t, notnull in plugin if n not in have]
    if not missing:
        return "ok", []
    if any(notnull for _, _, notnull in missing):
        return "foreign", [n for n, _, _ in missing]
    return "legacy", missing


def check_drain(repair):
    """Refuse early (before any write) if the drain is in a state we will not fix."""
    state, missing = inspect_drain()
    if state == "foreign":
        fail(f"{DRAIN} has a decisions table this installer does not recognise "
             f"(missing required columns {missing}). Left untouched.")
    if state == "legacy" and not repair:
        names = [n for n, _, _ in missing]
        fail(f"{DRAIN} has the narrower decisions table an older librarian install created.\n"
             f"  The Assay plugin cannot write to it (missing {names}), so its Stop hook\n"
             f"  degrades silently and captures nothing. To add the missing columns in place\n"
             f"  (additive only; every existing row is kept), run:\n"
             f"    python3 {os.path.abspath(__file__)} --drain-only --repair-drain")
    return state, missing


def ensure_drain(state, missing):
    """Bring the drain to the plugin's schema. Returns a one-line description of what it did."""
    if state == "ok":
        return "already present with the Assay plugin schema — left untouched"
    d = open_drain(DRAIN)
    try:
        if state == "legacy":
            # Additive repair: nullable columns only, so no existing row can violate anything.
            # Then the plugin's own CREATE ... IF NOT EXISTS script adds the indexes, the
            # transition/evidence tables, their append-only triggers and the migration stamp.
            for name, typ, _ in missing:
                d.execute(f'ALTER TABLE decisions ADD COLUMN "{name}" {typ}')
        d.executescript(drain_schema_sql())
        d.commit()
    finally:
        d.close()
    state_after, still_missing = inspect_drain()
    if state_after != "ok":
        fail(f"drain at {DRAIN} is still not on the plugin schema after setup "
             f"(state={state_after}, missing={still_missing})")
    if state == "legacy":
        return f"repaired in place (+{len(missing)} plugin columns, rows kept)"
    return "created with the Assay plugin schema (v1)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill-days", type=int, default=0,
                    help="start the watermark N days back instead of at 'now'")
    ap.add_argument("--force", action="store_true",
                    help="recreate the journal even if one exists (DESTROYS it)")
    ap.add_argument("--drain-only", action="store_true",
                    help="only create/verify ~/.assay/decisions.db; never touch the journal")
    ap.add_argument("--repair-drain", action="store_true",
                    help="add the plugin's missing columns to an older librarian-created drain")
    a = ap.parse_args()

    if a.drain_only:
        os.makedirs(ASSAY, exist_ok=True)
        state, missing = check_drain(a.repair_drain)
        print(f"init-journal: drain {DRAIN} — {ensure_drain(state, missing)}")
        return

    # 1. Preflight the substrate.
    if not os.path.exists(CM_DB):
        fail(f"claude-mem database not found at {CM_DB}.\n"
             "  Install the claude-mem plugin first and run at least one Claude Code\n"
             "  session so it creates its database — that is the capture substrate\n"
             "  this whole system files from. See SETUP.md step 1.")
    cm = sqlite3.connect(f"file:{CM_DB}?mode=rw", uri=True)
    cm.execute("PRAGMA query_only=1")
    cm.execute("PRAGMA busy_timeout=5000")
    try:
        cols = {r[1] for r in cm.execute("PRAGMA table_info(observations)")}
    except sqlite3.Error as e:
        fail(f"could not read claude-mem observations table: {e}")
    missing = REQUIRED_OBS_COLUMNS - cols
    if missing:
        fail(f"claude-mem schema drift — observations table is missing {sorted(missing)}.\n"
             "  This install was validated against claude-mem 13.x. Check your version\n"
             "  before proceeding; the sweep would export empty batches against this schema.")
    tables = {r[0] for r in cm.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "pending_messages" not in tables:
        fail("claude-mem schema drift — no pending_messages table (the settle gate reads it).")

    # Watermark starting point.
    if a.backfill_days > 0:
        cutoff_ms = int((time.time() - a.backfill_days * 86400) * 1000)
        row = cm.execute("SELECT COALESCE(MAX(id),0) FROM observations WHERE created_at_epoch < ?",
                         (cutoff_ms,)).fetchone()
    else:
        row = cm.execute("SELECT COALESCE(MAX(id),0) FROM observations").fetchone()
    cm_watermark = int(row[0])
    total = cm.execute("SELECT COUNT(*) FROM observations WHERE id > ?", (cm_watermark,)).fetchone()[0]
    cm.close()

    # 2. Create the journal. Both refusals (existing journal, unusable drain) happen before
    #    the first write, so a refused install leaves nothing behind.
    os.makedirs(ASSAY, exist_ok=True)
    if os.path.exists(JOURNAL) and not a.force:
        fail(f"{JOURNAL} already exists. This script will not touch an existing journal.\n"
             "  If you really want a fresh one (destroying all filed state), re-run with --force.")
    drain_state, drain_missing = check_drain(a.repair_drain)
    if os.path.exists(JOURNAL):
        os.remove(JOURNAL)
    j = sqlite3.connect(JOURNAL)
    j.executescript(JOURNAL_SCHEMA)

    # 3. Watermarks.
    now_ms = int(time.time() * 1000)
    j.executemany("INSERT INTO watermarks(source, last_key, updated) VALUES(?,?,datetime('now'))",
                  [("claude-mem", str(cm_watermark)), ("assay-drain", str(now_ms))])
    j.commit()
    j.close()

    # 4. The drain (plugin-owned schema; see check_drain / ensure_drain).
    drain_note = ensure_drain(drain_state, drain_missing)

    # 5. Tick.
    open(os.path.join(ASSAY, "librarian.tick"), "a").close()

    print(f"init-journal: OK")
    print(f"  journal:        {JOURNAL} (empty, schema ready)")
    print(f"  drain:          {DRAIN} ({drain_note})")
    print(f"  cm watermark:   {cm_watermark}"
          + (f" ({a.backfill_days}-day backfill: {total} observations will flow on the first sweeps)"
             if a.backfill_days > 0 else " (starting from now)"))
    print(f"  drain watermark: {now_ms} (only new rule.sh/deposit.sh rows flow)")


if __name__ == "__main__":
    main()
