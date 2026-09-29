#!/usr/bin/env bash
# on-stop.sh — Stop hook target.
# Two jobs, total budget <300ms, NO stdout output at all, exit 0 ALWAYS.
#   a) touch ~/.assay/librarian.tick
#   b) append one JSON line to ~/.assay/settle-telemetry.jsonl:
#        {"ts":"<UTC ISO>","cm_max_id":<int|null>,"pending":<int|null>}
# Values come from claude-mem.db (read-only, .timeout 2000). On ANY error, write
# nulls. The entire body is guarded so a locked DB can never break the Stop hook.

{
  ASSAY_DIR="$HOME/.assay"
  TICK="$ASSAY_DIR/librarian.tick"
  TELEM="$ASSAY_DIR/settle-telemetry.jsonl"
  CM_DB="$HOME/.claude-mem/claude-mem.db"

  mkdir -p "$ASSAY_DIR" 2>/dev/null || true
  touch "$TICK" 2>/dev/null || true

  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")

  cm_max_id="null"
  pending="null"

  if [ -r "$CM_DB" ]; then
    v=$(sqlite3 -cmd ".timeout 2000" "file:${CM_DB}?mode=ro" \
          "SELECT MAX(id) FROM observations;" 2>/dev/null || echo "")
    case "$v" in
      ''|*[!0-9]*) cm_max_id="null" ;;
      *) cm_max_id="$v" ;;
    esac

    p=$(sqlite3 -cmd ".timeout 2000" "file:${CM_DB}?mode=ro" \
          "SELECT COUNT(*) FROM pending_messages;" 2>/dev/null || echo "")
    case "$p" in
      ''|*[!0-9]*) pending="null" ;;
      *) pending="$p" ;;
    esac
  fi

  printf '{"ts":"%s","cm_max_id":%s,"pending":%s}\n' "$ts" "$cm_max_id" "$pending" \
    >>"$TELEM" 2>/dev/null || true
} || true

exit 0
