#!/usr/bin/env bash
# deposit.sh — explicitly record a decision into the drain.
#
# Routine decisions are captured ambiently by claude-mem; you should almost never need
# this. It exists for the two explicit cases: the user says "record this decision", or
# the user asserts a supersession in so many words ("X replaces Y — log it"). One
# sentence, stated as the decision itself, not as narration about it.
#
# Usage:
#   bin/deposit.sh "We are dropping provider A for provider B for all collection runs."
set -euo pipefail

DRAIN="$HOME/.assay/decisions.db"

if [ $# -ne 1 ] || [ -z "${1// }" ]; then
  echo "usage: bin/deposit.sh \"<one-sentence decision>\"" >&2
  exit 1
fi
BODY="$1"

[ -f "$DRAIN" ] || { echo "deposit.sh: drain not found at $DRAIN — run install.sh first" >&2; exit 1; }

ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
NOW_MS="$(python3 -c 'import time; print(int(time.time()*1000))')"

python3 - "$DRAIN" "$ID" "$BODY" "$NOW_MS" <<'PY'
import sqlite3, sys
drain, rid, body, now_ms = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
db = sqlite3.connect(drain)
db.execute("PRAGMA busy_timeout=5000")
db.execute(
    "INSERT INTO decisions(id, kind, body, status, layer, created_at, updated_at) "
    "VALUES(?, 'decision', ?, 'tentative', NULL, ?, ?)",
    (rid, body, now_ms, now_ms))
db.commit()
PY

touch "$HOME/.assay/librarian.tick" 2>/dev/null || true
echo "decision deposited (D-${ID:0:8}). The next sweep will file it."
