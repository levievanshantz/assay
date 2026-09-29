#!/usr/bin/env python3
# Pre-existing style in an audited ops script; behavior changes only. pylint: disable=broad-exception-caught,invalid-name,line-too-long,missing-function-docstring,too-many-branches,too-many-locals,too-many-return-statements,too-many-statements
"""coverage-verify.py — post-run disposition audit for the librarian sweep.

THE INVARIANT THIS ENFORCES (added 2026-07-08 after the non-atomic watermark bug was
measured at 73.9-86% observation loss on affected batches): a watermark may only advance
past a batch item if that item has a durable DISPOSITION in the journal. Dispositions:

  observation  -> a row in evidence(obs_key)  OR a row in unfiled(obs_key)
  drain ruling -> flags.closed_by = 'D-<hex>' OR a dangling-ruling data-caveat naming it
                  OR a row in unfiled(obs_key)
  drain other  -> evidence(obs_key='D-<hex>') OR unfiled(obs_key)

Anything with NO disposition is (a) appended verbatim to the unfiled ledger
(logs/unfiled-ledger.jsonl) so it can never be silently lost, and (b) counted as missing
so the sweep can roll the watermarks back and retry the batch.

Usage:
    python3 coverage-verify.py <batch-file> <ledger-file> [--journal <path>]

Stdout — ALWAYS exactly one line:
    missing=<N> missing_obs=<N> missing_drain=<N> total_obs=<N> total_drain=<N>[ error=<msg>]
Exit code is ALWAYS 0. On ANY error it reports error= and missing=0 (the sweep treats an
audit failure as "cannot prove loss" and falls back to today's behavior, loudly).
"""

import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

RULING_RE = re.compile(r"^\s*flag\s*#?\d+\s*:", re.IGNORECASE)


def stat_line(missing_obs, missing_drain, total_obs, total_drain, error=None):
    line = (
        f"missing={missing_obs + missing_drain} missing_obs={missing_obs} "
        f"missing_drain={missing_drain} total_obs={total_obs} total_drain={total_drain}"
    )
    if error is not None:
        line += " error=" + re.sub(r"\s+", " ", str(error)).strip()
    return line


def drain_key(row):
    """D-<first 8 hex of uuid> — the same keying the librarian prompt mandates."""
    raw = str(row.get("id") or "")
    hexpart = re.sub(r"[^0-9a-fA-F]", "", raw)[:8].lower()
    return f"D-{hexpart}" if len(hexpart) == 8 else None


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    journal = os.path.join(os.path.expanduser("~"), ".assay", "librarian.db")
    if "--journal" in argv:
        try:
            journal = argv[argv.index("--journal") + 1]
        except IndexError:
            print(stat_line(0, 0, 0, 0, error="bad---journal-arg"))
            return 0
    if len(args) < 2:
        print(stat_line(0, 0, 0, 0, error="usage:batch+ledger-args-required"))
        return 0
    batch_path, ledger_path = args[0], args[1]

    try:
        with open(batch_path, encoding="utf-8") as f:
            batch = json.load(f)
    except Exception as e:
        print(stat_line(0, 0, 0, 0, error=f"batch-read:{e}"))
        return 0

    observations = batch.get("observations") or []
    drain = batch.get("drain") or []
    total_obs, total_drain = len(observations), len(drain)

    try:
        conn = sqlite3.connect(f"file:{journal}?mode=rw", uri=True)
        conn.execute("PRAGMA query_only=1")
        conn.execute("PRAGMA busy_timeout=5000")
    except Exception as e:
        print(stat_line(0, 0, total_obs, total_drain, error=f"journal-open:{e}"))
        return 0

    def has_row(sql, param):
        return conn.execute(sql, (param,)).fetchone() is not None

    def drain_disposed(table, column, key):
        """True only if `key` maps to an UNAMBIGUOUS disposition row.

        The journal stores drain keys in two shapes — canonical 'D-<8hex>' and historical
        full-uuid 'D-<8hex>-...' — so an exact lookup alone misses legacy rows. But a bare
        prefix match is a 32-bit comparison: a different decision sharing the first 8 hex
        characters would falsely read as dispositioned, and the real item would be neither
        ledgered nor retried. So exact match wins, and a prefix match counts only when
        exactly ONE row matches. An ambiguous prefix is treated as NOT dispositioned, which
        routes the item to the ledger — the safe direction (codex review 2026-07-24).

        Table/column are internal literals, never batch-derived, so the f-string is not a
        user-input path; the key itself is always parameterised.
        """
        if has_row(f"SELECT 1 FROM {table} WHERE {column}=? LIMIT 1", key):
            return True
        n = conn.execute(
            f"SELECT count(*) FROM (SELECT 1 FROM {table} WHERE {column} LIKE ? LIMIT 2)",
            (key + "-%",)).fetchone()[0]
        return n == 1

    missing = []  # (kind, key, item)
    try:
        for obs in observations:
            try:
                key = str(int(obs.get("id")))
            except (TypeError, ValueError):
                missing.append(("observation", None, obs))
                continue
            if has_row("SELECT 1 FROM evidence WHERE obs_key=? LIMIT 1", key) or has_row(
                "SELECT 1 FROM unfiled WHERE obs_key=? LIMIT 1", key
            ):
                continue
            missing.append(("observation", key, obs))

        missing_obs = len(missing)

        for row in drain:
            key = drain_key(row)
            if key is None:
                missing.append(("drain", None, row))
                continue
            if drain_disposed("unfiled", "obs_key", key):
                continue
            body = str(row.get("body") or "")
            is_ruling = (str(row.get("layer") or "").lower() == "ruling") or RULING_RE.match(body)
            if is_ruling:
                # Disposition = it closed a flag, or was recorded as a dangling/mismatched ruling.
                if drain_disposed("flags", "closed_by", key) or has_row(
                    "SELECT 1 FROM flags WHERE text LIKE ? LIMIT 1", f"%dangling ruling {key}%"
                ):
                    continue
            else:
                if drain_disposed("evidence", "obs_key", key):
                    continue
            missing.append(("drain", key, row))

        missing_drain = len(missing) - missing_obs
    except Exception as e:
        conn.close()
        print(stat_line(0, 0, total_obs, total_drain, error=f"audit:{e}"))
        return 0
    conn.close()

    # Preserve every missing item in the append-only ledger BEFORE reporting, so even if the
    # sweep's retry path never fires (or gives up), the raw item is recoverable forever.
    if missing:
        try:
            ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
            with open(ledger_path, "a", encoding="utf-8") as f:
                for kind, key, item in missing:
                    f.write(
                        json.dumps(
                            {
                                "ts": ts,
                                "kind": kind,
                                "key": key,
                                "reason": "no-disposition-post-run",
                                "item": item,
                            },
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
            os.chmod(ledger_path, 0o600)
        except Exception as e:
            print(stat_line(missing_obs, missing_drain, total_obs, total_drain, error=f"ledger-write:{e}"))
            return 0

    print(stat_line(missing_obs, missing_drain, total_obs, total_drain))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as e:  # last-resort: never crash the sweep
        print(stat_line(0, 0, 0, 0, error=f"fatal:{e}"))
        sys.exit(0)
