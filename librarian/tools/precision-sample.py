#!/usr/bin/env python3
# Pre-existing style in an audited ops script; behavior changes only. pylint: disable=invalid-name,missing-function-docstring,unspecified-encoding
"""precision-sample.py — draw a reproducible sample of filing decisions to audit.

Coverage (every item has a disposition) and precision (the disposition is CORRECT)
are different properties. The sweep proves the first on every run. This draws the
sample used to measure the second; see PRECISION-AUDIT.md for the 2026-07-24 result.

The draw is deterministic for a given --seed, so a later audit can re-grade the same
120 rows and compare, or draw a disjoint sample with a different seed.

Usage:
    python3 tools/precision-sample.py --seed 42 --n 120 --since 2026-07-08
    python3 tools/precision-sample.py --n 60 --out /tmp/sample.json

Emits two files next to --out:
    <out>                 the sample: observation text + the authority it was filed to
    <out>.authorities     the full authority menu a grader needs to judge alternatives

Both databases are opened read-only. This tool never writes to the journal.
"""

import argparse
import json
import os
import random
import sqlite3
import sys

HOME = os.path.expanduser("~")
JOURNAL = os.path.join(HOME, ".assay", "librarian.db")
SUBSTRATE = os.path.join(HOME, ".claude-mem", "claude-mem.db")


def ro(path):
    if not os.path.exists(path):
        sys.exit(f"database not found: {path}")
    conn = sqlite3.connect(f"file:{path}?mode=rw", uri=True)
    conn.execute("PRAGMA query_only=1")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42, help="reproducible draw (default 42)")
    ap.add_argument("--n", type=int, default=120, help="sample size")
    ap.add_argument("--since", default="2026-07-08",
                    help="earliest obs_date to sample (default: the post-fix era)")
    ap.add_argument("--journal", default=JOURNAL)
    ap.add_argument("--substrate", default=SUBSTRATE)
    ap.add_argument("--out", default="precision-sample.json")
    a = ap.parse_args()

    j, cm = ro(a.journal), ro(a.substrate)
    authorities = {r[0]: {"name": r[1], "kind": r[2], "one_line": r[3]}
                   for r in j.execute("SELECT id,name,kind,one_line FROM authorities")}

    # Numeric obs_key only: drain decisions (D-<hex>) carry no substrate text to grade.
    population = j.execute(
        "SELECT obs_key, authority_id FROM evidence "
        "WHERE obs_date >= ? AND obs_key GLOB '[0-9]*'", (a.since,)).fetchall()
    if not population:
        sys.exit(f"no evidence rows on or after {a.since}")
    if a.n > len(population):
        sys.exit(f"--n {a.n} exceeds population {len(population)}")

    random.seed(a.seed)
    rows = []
    for key, aid in random.sample(population, a.n):
        obs = cm.execute("SELECT title, subtitle, type FROM observations WHERE id=?",
                         (int(key),)).fetchone()
        if not obs or aid not in authorities:
            continue  # substrate row pruned, or authority deleted; not a filing error
        rows.append({
            "obs_key": key,
            "obs_title": obs[0],
            "obs_subtitle": (obs[1] or "")[:200],
            "obs_type": obs[2],
            "filed_to_id": aid,
            "filed_to_name": authorities[aid]["name"],
            "authority_one_line": (authorities[aid]["one_line"] or "")[:300],
        })

    menu = [{"id": i, "name": v["name"], "kind": v["kind"],
             "one_line": (v["one_line"] or "")[:160]}
            for i, v in sorted(authorities.items())]

    with open(a.out, "w") as f:
        json.dump(rows, f, indent=1, ensure_ascii=False)
    with open(a.out + ".authorities", "w") as f:
        json.dump(menu, f, indent=1, ensure_ascii=False)

    dropped = a.n - len(rows)
    print(f"population={len(population)} sampled={len(rows)}"
          + (f" dropped={dropped}" if dropped else "")
          + f" authorities={len(menu)} seed={a.seed}")
    print(f"wrote {a.out} and {a.out}.authorities")


if __name__ == "__main__":
    main()
