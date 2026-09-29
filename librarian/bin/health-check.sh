#!/usr/bin/env bash
# health-check.sh — read-only status block for the Assay librarian.
# Never writes anything. Always exits 0 so it is safe to wire into dashboards/cron.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$ROOT/logs"
LIB_DB="$HOME/.assay/librarian.db"          # the journal (single source of truth)
MEM_DB="$HOME/.claude-mem/claude-mem.db"    # foreign: observations (read-only source)
DEC_DB="$HOME/.assay/decisions.db"          # foreign: decision drain (read-only source)
GLOSSARY="$HOME/.assay/glossary.md"
GLOSSARY_VER="$HOME/.assay/glossary.version"
PLIST_LABEL="com.librarian.sweep"

now_s=$(date +%s)

# q <db> <sql...> — read-only sqlite query. Empty string on any error/missing db.
q() {
  local db="$1"; shift
  [ -f "$db" ] || { printf ''; return; }
  sqlite3 -cmd ".timeout 5000" -cmd "PRAGMA query_only=1" "file:${db}?mode=rw" "$*" 2>/dev/null || printf ''
}

# True only if the argument is a non-empty run of decimal digits. Any value that gets fed into
# SQL interpolation or shell arithmetic must pass this first — a non-numeric read (corrupt row,
# error string) is then reported raw with a WARN instead of building a bad query or crashing $((.
is_num() { case "${1:-}" in ''|*[!0-9]*) return 1;; *) return 0;; esac; }

# minutes since an epoch-ms value, given "now" in seconds
age_min_from_ms() { # <epoch_ms>
  local ms="$1"
  is_num "$ms" || { printf 'n/a'; return; }
  printf '%s' "$(( (now_s - ms / 1000) / 60 ))"
}

echo "======================================================================"
echo " Assay librarian — health check   $(date '+%Y-%m-%d %H:%M:%S')"
echo "======================================================================"

# --- Sources: watermark vs store max, with LAG ---
# The watermark is interpolated into the LAG query, so validate it is numeric first; a
# non-numeric watermark is reported raw (WARN) rather than used to build a query.
mem_wm=$(q "$LIB_DB" "SELECT last_key FROM watermarks WHERE source='claude-mem';")
mem_max=$(q "$MEM_DB" "SELECT max(id) FROM observations;")
if is_num "$mem_wm"; then
  mem_lag=$(q "$MEM_DB" "SELECT count(*) FROM observations WHERE id > ${mem_wm};")
else
  mem_lag="WARN non-numeric wm='${mem_wm}'"
fi

drain_wm=$(q "$LIB_DB" "SELECT last_key FROM watermarks WHERE source='assay-drain';")
drain_max=$(q "$DEC_DB" "SELECT max(created_at) FROM decisions;")
if is_num "$drain_wm"; then
  drain_lag=$(q "$DEC_DB" "SELECT count(*) FROM decisions WHERE created_at > ${drain_wm};")
else
  drain_lag="WARN non-numeric wm='${drain_wm}'"
fi

echo "SOURCES (watermark -> store max = LAG unconsumed)"
echo "  claude-mem : wm=${mem_wm:-?}  store_max=${mem_max:-?}  LAG=${mem_lag:-?}"
echo "  assay-drain: wm=${drain_wm:-?}  store_max=${drain_max:-?}  LAG=${drain_lag:-?}"

# --- Ingest freshness ---
pending=$(q "$MEM_DB" "SELECT count(*) FROM pending_messages;")
newest_ms=$(q "$MEM_DB" "SELECT max(created_at_epoch) FROM observations;")
echo "INGEST"
echo "  pending_messages=${pending:-?}   newest_observation_age=$(age_min_from_ms "$newest_ms")m"

# --- Pinned dependency versions ---
# claude-mem is the read-only ingest source; drift off the validated 13.x major means the
# observation schema/semantics may have changed and ingest should be re-vetted.
CM_PIN_PREFIX="13"
INSTALLED_JSON="$HOME/.claude/plugins/installed_plugins.json"
CM_CACHE="$HOME/.claude/plugins/cache/thedotmack/claude-mem"
cm_ver=""
if [ -f "$INSTALLED_JSON" ]; then
  cm_ver=$(awk '
    /"claude-mem@thedotmack"/ {f=1}
    f && /"version"[[:space:]]*:/ {
      match($0, /"version"[[:space:]]*:[[:space:]]*"[^"]+"/); s=substr($0,RSTART,RLENGTH);
      sub(/.*"version"[[:space:]]*:[[:space:]]*"/,"",s); sub(/".*/,"",s);
      print s; exit
    }' "$INSTALLED_JSON" 2>/dev/null)
fi
# fallback: highest installed version directory in the plugin cache
if [ -z "$cm_ver" ] && [ -d "$CM_CACHE" ]; then
  cm_ver=$(ls -1 "$CM_CACHE" 2>/dev/null | sort -V | tail -1)
fi
echo "PINS"
case "${cm_ver:-}" in
  ${CM_PIN_PREFIX}*)
    echo "  claude-mem=${cm_ver}  OK (matches pin ${CM_PIN_PREFIX}.x)" ;;
  "")
    echo "  claude-mem=<unreadable>  WARN drifted from pin ${CM_PIN_PREFIX}.x — vet before trusting ingest" ;;
  *)
    echo "  claude-mem=${cm_ver}  WARN drifted from pin ${CM_PIN_PREFIX}.x — vet before trusting ingest" ;;
esac

# --- Journal ---
auth=$(q "$LIB_DB" "SELECT count(*) FROM authorities;")
dirty=$(q "$LIB_DB" "SELECT count(*) FROM authorities WHERE dirty=1;")
oflags=$(q "$LIB_DB" "SELECT count(*) FROM flags WHERE status='open';")
ev=$(q "$LIB_DB" "SELECT count(*) FROM evidence;")

# WRITER LOCK: the real single-writer guarantee is the filesystem pid lock (`shlock` on
# librarian.lock), NOT the vestigial writer_lock DB table (which stays empty). Report the
# pid-lock file: present? whose pid? is that pid alive (a live run) or stale (crashed sweep,
# which the next run auto-reclaims via shlock)?
LOCK_FILE="$HOME/.assay/librarian.lock"
if [ -f "$LOCK_FILE" ]; then
  lock_pid=$(tr -cd '0-9' < "$LOCK_FILE" 2>/dev/null)
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    lockstate="HELD pid=${lock_pid} (alive — a sweep is running)"
  elif [ -n "$lock_pid" ]; then
    lockstate="STALE pid=${lock_pid} (dead — next sweep auto-reclaims via shlock)"
  else
    lockstate="present but no pid parsed ($LOCK_FILE)"
  fi
elif [ -d "${LOCK_FILE}.d" ]; then
  lockstate="HELD via mkdir fallback (${LOCK_FILE}.d exists)"
else
  lockstate="<free> (no $LOCK_FILE)"
fi

echo "JOURNAL"
echo "  authorities=${auth:-?}  dirty(unrendered)=${dirty:-?}  open_flags=${oflags:-?}  evidence_rows=${ev:-?}"
echo "  writer_lock(pid-file)=${lockstate}"

# --- Glossary ---
echo "GLOSSARY"
if [ -f "$GLOSSARY" ]; then
  g_chars=$(wc -c < "$GLOSSARY" | tr -d ' ')
  g_mtime=$(stat -f %m "$GLOSSARY" 2>/dev/null || echo "$now_s")
  g_ver=$( [ -f "$GLOSSARY_VER" ] && tr -d '\n' < "$GLOSSARY_VER" || printf '?' )
  if is_num "$g_mtime"; then g_age="$(( (now_s - g_mtime) / 60 ))m ago"; else g_age="age unknown (mtime='${g_mtime}')"; fi
  echo "  present  chars=${g_chars}  version=${g_ver}  generated=${g_age}"
else
  echo "  MISSING — not generated yet ($GLOSSARY)"
fi

# --- launchd sweep job ---
echo "LAUNCHD ($PLIST_LABEL)"
ld=$(launchctl list 2>/dev/null | grep "$PLIST_LABEL")
if [ -n "$ld" ]; then
  echo "  loaded  pid=$(echo "$ld" | awk '{print $1}')  last_exit=$(echo "$ld" | awk '{print $2}')"
else
  echo "  NOT loaded — sweep is not scheduled (launchctl load the plist to start it)"
fi

# --- Sweep logs ---
echo "SWEEP LOGS ($LOGS)"
newest_log=$(ls -t "$LOGS"/*.log 2>/dev/null | head -1)
if [ -n "$newest_log" ]; then
  echo "  newest: $(basename "$newest_log")"
  tail -3 "$newest_log" 2>/dev/null | sed 's/^/    | /'
else
  echo "  (no *.log files yet)"
fi
runs="$LOGS/librarian-runs.jsonl"
if [ -f "$runs" ]; then
  echo "  last run: $(tail -1 "$runs" 2>/dev/null)"
else
  echo "  last run: (no librarian-runs.jsonl yet)"
fi

# --- Settle telemetry ---
settle="$HOME/.assay/settle-telemetry.jsonl"
echo "SETTLE"
if [ -f "$settle" ]; then
  echo "  settle-telemetry.jsonl lines=$(wc -l < "$settle" | tr -d ' ')"
  echo "    newest: $(tail -1 "$settle" 2>/dev/null)"
else
  echo "  (no settle-telemetry.jsonl yet)"
fi

echo "======================================================================"
exit 0
