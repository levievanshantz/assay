#!/usr/bin/env bash
# demo.sh — run the REAL sweep against SYNTHETIC data in under a minute.
#
# No API key, no LLM, no network. A fake `claude` shim plays the librarian: it files
# every residual observation and advances the watermarks, exactly as a good worker would.
# Everything happens inside one mktemp -d workdir under a synthetic $HOME; nothing touches
# the real ~/.assay, ~/.claude-mem, or the repo's own logs/. The point is to watch the
# genuine bin/sweep.sh — prefilter, coverage audit, dual-watermark commit — do its thing.
#
# macOS only: the sweep uses BSD `stat -f %m` and `shlock`. Stdlib + sqlite3 only.
set -euo pipefail

# Resolve the repo root from this script's location so the tree can move.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"

# One disposable workdir holds the synthetic HOME, a private copy of the tree, and the shims.
# Keep it on failure (so an evaluator can inspect the log), or when KEEP=1; otherwise clean up.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/librarian-demo.XXXXXX")"
cleanup() {
  local rc=$?
  if [ "$rc" != 0 ]; then
    echo "demo failed (rc=$rc) — workdir kept for inspection: $WORK" >&2
  elif [ "${KEEP:-0}" = 1 ]; then
    echo "KEEP=1 — workdir kept: $WORK" >&2
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

echo "== 1. seeding synthetic environment =="
# 20 observations aged 1h so the settle gate is satisfied even with SETTLE_BUFFER=0. The seed
# alternates change/discovery rows: 10 are prefilter-eligible run-log rows, 10 carry judgment.
python3 "$REPO_ROOT/tests/fixtures/seed.py" "$WORK/home" --observations 20 --age-seconds 3600 >/dev/null
HOME_DIR="$WORK/home"
JOURNAL="$HOME_DIR/.assay/librarian.db"
echo "   synthetic HOME: $HOME_DIR"
echo "   20 observations seeded, watermarks at 0"

echo "== 2. copying a private tree (repo logs stay clean) =="
# The sweep writes into LIB_HOME/logs. Copy bin/ + prompts/ into the workdir so every log,
# marker, ledger, and retry-counter this run produces lands here, never in the repo.
PRIVATE="$WORK/librarian"
mkdir -p "$PRIVATE/logs"
cp -R "$REPO_ROOT/bin" "$PRIVATE/bin"
cp -R "$REPO_ROOT/prompts" "$PRIVATE/prompts"
echo "   private tree: $PRIVATE"

echo "== 3. installing fake worker + timeout shims =="
# The sweep appends 'BATCH FILE: <path>' to the librarian prompt. The shim extracts that path,
# then files every residual observation as evidence and advances BOTH watermarks to the batch
# targets in one transaction — a correct, filing worker. This is the ONLY fake in the demo;
# every other line of the pipeline is the real sweep.
SHIM="$WORK/shims"
mkdir -p "$SHIM"

cat >"$WORK/worker.py" <<'PYEOF'
import json, sqlite3, sys
b = json.load(open(sys.argv[1])); db = sqlite3.connect(sys.argv[2])
db.execute("BEGIN IMMEDIATE")
for o in b.get("observations") or []:
    db.execute("INSERT OR IGNORE INTO evidence(obs_key,authority_id,obs_date,obs_type)"
               " VALUES(?,1,?,?)", (str(o["id"]), str(o.get("date") or "")[:10], o.get("type")))
db.execute("UPDATE watermarks SET last_key=? WHERE source='claude-mem'", (str(b["cm_watermark_target"]),))
db.execute("UPDATE watermarks SET last_key=? WHERE source='assay-drain'", (str(b["drain_watermark_target"]),))
db.commit()
PYEOF

cat >"$SHIM/claude" <<PYEOF
#!/bin/bash
# Extract the batch path the sweep appended to the prompt, then run the worker against it.
BATCH="\$(printf '%s' "\${@: -1}" | grep -o 'BATCH FILE: [^ ]*' | tail -1 | sed 's/BATCH FILE: //')"
$(command -v python3) "$WORK/worker.py" "\$BATCH" "\$HOME/.assay/librarian.db"
echo '{"ts":"demo","filed":0,"unfiled":0,"rendered":0,"notion_available":false}'
PYEOF
chmod +x "$SHIM/claude"

# Stock macOS has no `timeout`; the sweep requires it. A pass-through lets us exercise the gate
# instead of the coreutils install.
cat >"$SHIM/timeout" <<'EOF'
#!/bin/sh
shift
exec "$@"
EOF
chmod +x "$SHIM/timeout"
echo "   shims on PATH: claude (filing worker), timeout (pass-through)"

echo "== 4. running the real sweep (bin/sweep.sh) =="
# SETTLE_BUFFER=0 so the 1h-old batch counts as settled immediately. HOME points at the
# synthetic tree; PATH is prefixed with the shims so `claude` and `timeout` resolve to them.
# LIBRARIAN_CLAUDE_BIN pins the fake worker even if a real claude sits in /opt/homebrew/bin.
HOME="$HOME_DIR" SETTLE_BUFFER=0 PATH="$SHIM:$PATH" LIBRARIAN_CLAUDE_BIN="$SHIM/claude" \
  bash "$PRIVATE/bin/sweep.sh"
LOG="$(ls "$PRIVATE"/logs/sweep-*.log | tail -1)"
echo "   sweep exited 0; log: $LOG"

echo
echo "== 5. the story, from the sweep's own log =="
# 20 observations in: 10 auto-filed deterministically (zero LLM), 10 handed to the worker,
# coverage audit finds nothing missing, run commits.
grep -E 'batch:|prefilter:|coverage:|sweep: COMPLETE' "$LOG" | sed 's/^/   /'

echo
echo "== 6. evidence filed, per authority (from the journal) =="
sqlite3 -column -header "$JOURNAL" \
  "SELECT a.name AS authority, a.kind, count(*) AS evidence_rows
     FROM evidence e JOIN authorities a ON a.id = e.authority_id
    GROUP BY a.id ORDER BY a.id;" | sed 's/^/   /'

echo
echo "== 7. watermarks (both advanced to the batch target = 20) =="
sqlite3 -column -header "$JOURNAL" \
  "SELECT source, last_key FROM watermarks ORDER BY source;" | sed 's/^/   /'

echo
echo "20 observations: 10 auto-filed deterministically (zero LLM), 10 filed by the worker, coverage audit missing=0."
echo "Now break it on purpose: see FAILURE_DEMO.md"
