#!/usr/bin/env python3
"""seed.py — build a synthetic, self-contained environment for the sweep tests.

Creates a fake $HOME containing the three databases the sweep reads/writes:
    <root>/.assay/librarian.db      the journal (single source of truth)
    <root>/.assay/decisions.db      the assay decision drain
    <root>/.claude-mem/claude-mem.db  the memory substrate (read-only input)

Nothing here touches the real ~/.assay or ~/.claude-mem. The schemas mirror
production exactly (including the unique indexes the idempotency contract
depends on) so a test failure means a real behavioural change, not a fixture
drift.

Usage:
    python3 seed.py <root> [--observations N] [--age-seconds S]

--age-seconds controls how old the newest observation looks. The sweep's settle
gate defers when the newest observation is younger than SETTLE_BUFFER, so tests
that want a sweep to actually run should seed an age comfortably above it (or
run the sweep with SETTLE_BUFFER=0).
"""

import argparse
import os
import sqlite3
import time

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

CM_SCHEMA = """
CREATE TABLE observations(id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT,
    text TEXT, type TEXT, title TEXT, subtitle TEXT, facts TEXT, narrative TEXT,
    created_at TEXT, created_at_epoch INTEGER);
CREATE TABLE pending_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_db_id INTEGER);
"""

# The drain is the Assay plugin's database, so the fixture uses the plugin's schema verbatim
# (the same file init-journal.py installs), not a hand-written subset of it.
DR_SCHEMA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              os.pardir, os.pardir, "bin", "decisions-schema.sql")

# Two authorities: one 'system' (prefilter-eligible) and one 'decision' (never auto-filed).
AUTHORITIES = [
    (1, "Widget collection pipeline", "Infra & Claude Tooling", "system", "Active",
     "Nightly widget collector; retries on provider timeout.", "page-1",
     "2026-01-01", "2026-01-01", 0),
    (2, "Release plan", "Assay Strategy & GTM", "decision", "Active",
     "Ship the plugin first; the Librarian follows.", "page-2", "2026-01-01", "2026-01-01", 0),
]


def build(root, n_obs, age_seconds):
    """Create a sandboxed HOME with seeded claude-mem, journal and decisions databases."""
    assay = os.path.join(root, ".assay")
    cmdir = os.path.join(root, ".claude-mem")
    os.makedirs(assay, exist_ok=True)
    os.makedirs(cmdir, exist_ok=True)

    j = sqlite3.connect(os.path.join(assay, "librarian.db"))
    j.executescript(JOURNAL_SCHEMA)
    j.executemany("INSERT INTO authorities VALUES(?,?,?,?,?,?,?,?,?,?)", AUTHORITIES)
    # Watermarks start at 0 so every seeded observation is 'new'.
    j.executemany("INSERT INTO watermarks(source,last_key,updated) VALUES(?,?,datetime('now'))",
                  [("claude-mem", "0"), ("assay-drain", "0")])
    j.commit()
    j.close()

    cm = sqlite3.connect(os.path.join(cmdir, "claude-mem.db"))
    cm.executescript(CM_SCHEMA)
    now = int(time.time()) - age_seconds
    rows = []
    for i in range(1, n_obs + 1):
        # Alternate between a prefilter-eligible run-log row and a row the deterministic
        # tier must refuse (type 'discovery' never auto-files), so every test batch
        # exercises both the zero-LLM path and the LLM path.
        if i % 2:
            typ, title = "change", "Widget collection pipeline completed nightly run"
        else:
            typ, title = "discovery", "Observed unexplained variance in widget totals"
        epoch_ms = (now - (n_obs - i)) * 1000
        rows.append((i, "sess", "test", "", typ, title, "synthetic fixture row",
                     "", "", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch_ms / 1000)),
                     epoch_ms))
    cm.executemany("INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?,?,?)", rows)
    cm.commit()
    cm.close()

    d = sqlite3.connect(os.path.join(assay, "decisions.db"))
    if sqlite3.sqlite_version_info < (3, 38, 0):   # the plugin schema stamps with unixepoch()
        d.create_function("unixepoch", 0, lambda: int(time.time()))
    with open(DR_SCHEMA_FILE, encoding="utf-8") as f:
        d.executescript(f.read())
    d.commit()
    d.close()

    # The sweep's no-op fast path requires a tick newer than the last-sweep marker.
    with open(os.path.join(assay, "librarian.tick"), "w", encoding="utf-8"):
        pass
    return root


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--observations", type=int, default=20)
    ap.add_argument("--age-seconds", type=int, default=3600)
    a = ap.parse_args()
    print(build(a.root, a.observations, a.age_seconds))
