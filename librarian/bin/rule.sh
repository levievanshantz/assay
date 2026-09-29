#!/usr/bin/env bash
# rule.sh — close the loop on a librarian flag with a human ruling.
#
# The librarian raises flags (contradictions, possible supersessions, open loops) and
# never resolves them itself. This is the single path from implied to asserted: a human
# rules, this script deposits the ruling into the decision drain, and the next sweep
# verifies the flag, closes it, and — only when the verdict explicitly confirms a
# supersession — writes the supersession edge.
#
# Usage:
#   bin/rule.sh "flag #12: confirmed — the API pipeline supersedes the browser approach"
#
# The body MUST start with "flag #<N>:" — the librarian parses the flag id from it and
# will record a dangling ruling (rather than guess) if the id is unknown or closed.
# This writes one row; it is deliberately dumb. All judgment stays with you and the
# librarian's verification steps.
set -euo pipefail

DRAIN="$HOME/.assay/decisions.db"

if [ $# -ne 1 ] || [ -z "${1// }" ]; then
  echo "usage: bin/rule.sh \"flag #<N>: <verdict + why, one sentence>\"" >&2
  exit 1
fi
BODY="$1"

if ! printf '%s' "$BODY" | grep -qiE '^[[:space:]]*flag[[:space:]]*#?[0-9]+[[:space:]]*:'; then
  echo "rule.sh: body must start with 'flag #<N>:' — got: $BODY" >&2
  echo "         (the librarian parses the flag id from exactly that shape)" >&2
  exit 1
fi

[ -f "$DRAIN" ] || { echo "rule.sh: drain not found at $DRAIN — run install.sh first" >&2; exit 1; }

ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
NOW_MS="$(python3 -c 'import time; print(int(time.time()*1000))')"

# Parameter binding via python: the verdict text is arbitrary prose and must never be
# interpolated into a SQL string.
python3 - "$DRAIN" "$ID" "$BODY" "$NOW_MS" <<'PY'
import sqlite3, sys
drain, rid, body, now_ms = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
db = sqlite3.connect(drain)
db.execute("PRAGMA busy_timeout=5000")
db.execute(
    "INSERT INTO decisions(id, kind, body, status, layer, created_at, updated_at) "
    "VALUES(?, 'decision', ?, 'tentative', 'ruling', ?, ?)",
    (rid, body, now_ms, now_ms))
db.commit()
PY

touch "$HOME/.assay/librarian.tick" 2>/dev/null || true
echo "ruling deposited (D-${ID:0:8}). The next sweep will verify the flag and close it."
