#!/usr/bin/env bash
# break-it.sh — reproduce THE ORIGINAL BUG and watch the fix contain it.
#
# Same synthetic setup as demo.sh, but the fake worker is the pre-2026-07-08 failure mode:
# it advances BOTH watermarks to the batch targets and files NOTHING. Before the fix, that
# exact worker produced "sweep: COMPLETE" and deleted the batch — silent, permanent loss
# (measured at 74-86% on affected batches). Here you watch the coverage gate catch it:
# roll the watermarks back, preserve every residual item in the recovery ledger, retry a
# bounded number of times, then give up LOUDLY without ever losing an item.
#
# macOS only: BSD `stat -f %m` and `shlock`. Stdlib + sqlite3 only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/librarian-breakit.XXXXXX")"
cleanup() {
  local rc=$?
  if [ "$rc" != 0 ]; then
    echo "break-it failed (rc=$rc) — workdir kept for inspection: $WORK" >&2
  elif [ "${KEEP:-0}" = 1 ]; then
    echo "KEEP=1 — workdir kept: $WORK" >&2
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

echo "== 1. seeding synthetic environment =="
python3 "$REPO_ROOT/tests/fixtures/seed.py" "$WORK/home" --observations 20 --age-seconds 3600 >/dev/null
HOME_DIR="$WORK/home"
LEDGER="$WORK/librarian/logs/unfiled-ledger.jsonl"

echo "== 2. copying a private tree (repo logs stay clean) =="
PRIVATE="$WORK/librarian"
mkdir -p "$PRIVATE/logs"
cp -R "$REPO_ROOT/bin" "$PRIVATE/bin"
cp -R "$REPO_ROOT/prompts" "$PRIVATE/prompts"

echo "== 3. installing the BROKEN worker + timeout shims =="
# THE BUG: advance both watermarks to the targets, file nothing. The 10 prefilter-eligible
# rows are still auto-filed deterministically upstream, so exactly the 10 residual (judgment)
# observations end the run with no disposition — the silent-loss state the gate must catch.
SHIM="$WORK/shims"
mkdir -p "$SHIM"

cat >"$WORK/worker.py" <<'PYEOF'
import json, sqlite3, sys
b = json.load(open(sys.argv[1])); db = sqlite3.connect(sys.argv[2])
db.execute("UPDATE watermarks SET last_key=? WHERE source='claude-mem'", (str(b["cm_watermark_target"]),))
db.execute("UPDATE watermarks SET last_key=? WHERE source='assay-drain'", (str(b["drain_watermark_target"]),))
db.commit()
PYEOF

cat >"$SHIM/claude" <<PYEOF
#!/bin/bash
BATCH="\$(printf '%s' "\${@: -1}" | grep -o 'BATCH FILE: [^ ]*' | tail -1 | sed 's/BATCH FILE: //')"
$(command -v python3) "$WORK/worker.py" "\$BATCH" "\$HOME/.assay/librarian.db"
echo '{"ts":"break-it","filed":0,"unfiled":0,"rendered":0,"notion_available":false}'
PYEOF
chmod +x "$SHIM/claude"

cat >"$SHIM/timeout" <<'EOF'
#!/bin/sh
shift
exec "$@"
EOF
chmod +x "$SHIM/timeout"
echo "   shim installed: worker advances watermarks, files NOTHING"

echo
echo "== 4. running the sweep up to 5 times =="
# Runs 1-3 roll the watermarks back (retry 1/3, 2/3, 3/3) and re-preserve the residual.
# Run 4 hits the retry cap and gives up LOUDLY — but only because the items are provably in
# the ledger. Run 5 (if reached) is a clean no-op: watermarks already at target.
for i in 1 2 3 4 5; do
  echo "   -- run $i --"
  HOME="$HOME_DIR" SETTLE_BUFFER=0 PATH="$SHIM:$PATH" LIBRARIAN_CLAUDE_BIN="$SHIM/claude" \
    bash "$PRIVATE/bin/sweep.sh"
  LOG="$(ls "$PRIVATE"/logs/sweep-*.log | tail -1)"
  # Show only the lines that carry the decision for this run.
  grep -E 'coverage:|ROLLED BACK|INCOMPLETE|HUMAN REVIEW|sweep: COMPLETE' "$LOG" \
    | tail -3 | sed 's/^/      /'
  # Once the gate escalates, the story is told; a 5th run would only be a caught-up no-op.
  if grep -q 'HUMAN REVIEW NEEDED' "$LOG"; then
    echo "      (gate escalated — stopping the loop)"
    break
  fi
done

echo
echo "== 5. nothing was lost — the recovery ledger holds every residual item =="
# The verifier appends the 10 undispositioned residual items to the ledger BEFORE each rollback,
# so the count grows by 10 per run, but the set of distinct keys is exactly the 10 residual.
echo "   ledger lines (10 preserved per run): $(wc -l <"$LEDGER" | tr -d ' ')"
python3 - "$LEDGER" <<'PYEOF'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
keys = {r["key"] for r in rows}
print(f"   distinct residual keys preserved: {len(keys)}")
s = rows[0]
print(f"   sample entry: key={s['key']} reason={s['reason']} title={s['item'].get('title')!r}")
PYEOF

echo
echo "Runs 1-3 rolled the watermarks back and re-preserved all 10 residual items verbatim."
echo "Run 4 gave up with HUMAN REVIEW NEEDED — but every item is in the ledger; nothing was silently lost."
echo "Pre-fix behavior: this exact worker produced 'sweep: COMPLETE' and permanent loss."
