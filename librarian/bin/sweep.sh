#!/bin/bash
# librarian-sweep — background sweep entry point (schedule via launchd/systemd/cron, ~20 min).
#
# Launched by launchd every 20 min (StartInterval 1200). Keeps the decision-state
# library current by draining new claude-mem observations + assay decisions into the
# journal (~/.assay/librarian.db) and rendering dirty authorities into the Notion Library,
# via a headless `claude -p` librarian run.
#
# Contract:
#   - Single writer (only one sweep runs at a time).
#   - No-op runs are silent and sub-second and exit 0.
#   - It only ADVANCES the .last-sweep marker when the batch was actually committed
#     (or confirmed to be a true no-op). A failed/incomplete run leaves the marker so the
#     next cycle retries.
#   - Non-zero exit ONLY on genuine infrastructure failure (missing binary, unwritable log
#     dir). Never non-zero for a no-op or a "not settled yet" deferral.
#
# This macOS host has no `flock`; single-writer is enforced with `shlock` (BSD, always
# present) plus an EXIT trap, falling back to an atomic mkdir. launchd's PATH is minimal,
# so we resolve every non-system binary explicitly.

set -o pipefail
umask 077   # every file/dir this run creates (batch, run dir, logs, marker) is owner-only

# ---------------------------------------------------------------------------------------
# Paths (resolved relative to this script so the tree can move; assay dir via HOME).
# ---------------------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
LIB_HOME="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
HOME="${HOME:?HOME must be set}"
ASSAY_DIR="$HOME/.assay"

JOURNAL="$ASSAY_DIR/librarian.db"
CM_DB="$HOME/.claude-mem/claude-mem.db"
DR_DB="$ASSAY_DIR/decisions.db"
TICK="$ASSAY_DIR/librarian.tick"
LOCK="$ASSAY_DIR/librarian.lock"

LOGDIR="$LIB_HOME/logs"
MARKER="$LOGDIR/.last-sweep"
PROMPT="$LIB_HOME/prompts/librarian.md"
GLOSSARY="$LIB_HOME/bin/glossary-compile.py"
COVERAGE="$LIB_HOME/bin/coverage-verify.py"
UNFILED_LEDGER="$LOGDIR/unfiled-ledger.jsonl"     # append-only; every batch item that ends a run
                                                  # with no journal disposition lands here verbatim
COVERAGE_RETRIES="$LOGDIR/.coverage-retries"      # "<cm_wm> <count>" — bounded-retry state
RUNS_JSONL="$LOGDIR/librarian-runs.jsonl"
LOG="$LOGDIR/sweep-$(date +%Y%m%d).log"

# The batch lives inside a private mktemp -d run dir under ~/.assay/ (mode 700), created
# lazily right before export and removed in the EXIT trap. Never in world-readable /tmp.
RUN_DIR=""
BATCH=""
CLAUDE_OUT="$LOGDIR/librarian-out-$$.txt"

# Tunables (env-overridable).
SETTLE_BUFFER="${SETTLE_BUFFER:-600}"          # seconds a session must be quiet before we sweep
BATCH_CAP="${LIBRARIAN_BATCH_CAP:-400}"        # max observations per run
LIBRARIAN_MODEL="${LIBRARIAN_MODEL:-claude-sonnet-4-6}"
CLAUDE_TIMEOUT="${LIBRARIAN_CLAUDE_TIMEOUT:-900}"
DRY_RUN="${LIBRARIAN_DRY_RUN:-0}"              # 1 = build+export+verify but DON'T invoke claude
# Worker permissions. The default is unchanged (bypassPermissions: no prompts, every tool).
# A tighter mode has NOT been verified to let the worker finish its procedure; if it cannot
# run sqlite3, the watermarks never advance and the batch retries (fails closed, never loses
# items). See "Security model" in README.md before changing either value.
PERMISSION_MODE="${LIBRARIAN_PERMISSION_MODE:-bypassPermissions}"
ALLOWED_TOOLS="${LIBRARIAN_ALLOWED_TOOLS:-}"    # optional; passed as --allowedTools when set

# Make launchd's minimal PATH usable, then resolve binaries to absolute paths.
export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/anaconda3/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
SQLITE="$(command -v sqlite3 || true)"
PYTHON="$(command -v python3 || true)"
# LIBRARIAN_CLAUDE_BIN pins the worker binary. The tests and demos set it to their fake: the
# PATH above puts /opt/homebrew/bin and /usr/local/bin FIRST, so a fake passed only via PATH
# would lose to a real claude installed there and the "no LLM" demo would call the real one.
CLAUDE="${LIBRARIAN_CLAUDE_BIN:-$(command -v claude || true)}"
TIMEOUT="$(command -v timeout || command -v gtimeout || true)"

# ---------------------------------------------------------------------------------------
# Logging + lock plumbing.
# ---------------------------------------------------------------------------------------
mkdir -p "$LOGDIR" 2>/dev/null
# Log dir must be writable — everything downstream logs. A failure here is genuine infra
# failure (bad perms / full disk), so exit non-zero. Trap not yet armed; nothing to clean.
if ! : >>"$LOG" 2>/dev/null; then
  printf 'librarian sweep: FATAL log not writable: %s\n' "$LOG" >&2
  exit 1
fi

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }
fatal() { log "FATAL $*"; cleanup; exit 1; }

LOCK_HELD=0
LOCK_IS_DIR=0
cleanup() {
  [ "${LOCK_HELD:-0}" = 1 ] && {
    if [ "${LOCK_IS_DIR:-0}" = 1 ]; then rmdir "$LOCK.d" 2>/dev/null
    else rm -f "$LOCK" 2>/dev/null; fi
  }
  # Remove the whole private run dir (batch + any prefilter temp). KEEP_BATCH=1 (DRY_RUN)
  # retains it for inspection; a moved/failed batch already left the dir empty.
  if [ "${KEEP_BATCH:-0}" != 1 ] && [ -n "${RUN_DIR:-}" ]; then
    rm -rf "$RUN_DIR" 2>/dev/null
  fi
  rm -f "$CLAUDE_OUT" 2>/dev/null
}
KEEP_BATCH=0
trap cleanup EXIT

acquire_lock() {
  # 0 = acquired, 1 = someone else holds it. shlock reuses the pidfile and steals it if the
  # recorded PID is dead (crash-safe). mkdir fallback is atomic but not stale-aware.
  if command -v shlock >/dev/null 2>&1; then
    if shlock -f "$LOCK" -p $$; then LOCK_HELD=1; return 0; fi
    return 1
  fi
  if mkdir "$LOCK.d" 2>/dev/null; then LOCK_HELD=1; LOCK_IS_DIR=1; return 0; fi
  return 1
}

# Run a read-only, timeout-bounded scalar query. Echoes result (empty on error).
roq() { # roq <db> <sql>
  [ -n "$SQLITE" ] || return 1
  # Not -readonly: a read-only open cannot recreate the -shm file of a WAL database whose
  # writer has closed ("unable to open database file"). mode=rw never creates a missing
  # file, and query_only makes the connection refuse every write.
  "$SQLITE" -cmd ".timeout 5000" -cmd "PRAGMA query_only=1" "file:$1?mode=rw" "$2" 2>/dev/null
}

# True only if the argument is a non-empty run of decimal digits (safe for -eq / SQL interp).
is_num() { case "${1:-}" in ''|*[!0-9]*) return 1;; *) return 0;; esac; }

# Advance the .last-sweep marker ONLY if the tick has not moved since we snapshotted it at
# the start of the run. If it moved, a new signal arrived mid-run; leaving the marker behind
# (older than the tick) guarantees the next cycle re-runs and picks up that fresh work,
# instead of us stamping "swept" over a tick we never processed.
touch_marker_if_tick_unmoved() {
  local now_mtime
  now_mtime="$(stat -f %m "$TICK" 2>/dev/null)"
  if [ -n "$now_mtime" ] && [ "$now_mtime" = "${TICK_MTIME_START:-}" ]; then
    touch "$MARKER"
    return 0
  fi
  log "tick moved mid-run — marker left for next cycle (start_mtime=${TICK_MTIME_START:-?} now_mtime=${now_mtime:-?})"
  return 1
}

# ---------------------------------------------------------------------------------------
# (a) SINGLE WRITER
# ---------------------------------------------------------------------------------------
acquire_lock || exit 0   # another sweep is running; leave it be

# ---------------------------------------------------------------------------------------
# (b) NO-OP FAST PATH — must stay silent + sub-second.
#     Nothing to do unless the tick file exists AND is newer than our last sweep marker.
# ---------------------------------------------------------------------------------------
[ -f "$TICK" ] || exit 0
[ "$TICK" -nt "$MARKER" ] || exit 0

# Snapshot the tick's mtime now, right after we commit to a run. Every marker-touch below is
# gated on this value being unchanged, so a tick that fires mid-run is never stamped as swept.
TICK_MTIME_START="$(stat -f %m "$TICK" 2>/dev/null)"

# Past here we intend to do real work, so infrastructure must be present.
[ -n "$SQLITE" ] || fatal "sqlite3 not found on PATH"

# ---------------------------------------------------------------------------------------
# (c) SETTLE CHECK — all read-only.
# ---------------------------------------------------------------------------------------
CM_WM="$(roq "$JOURNAL" "SELECT last_key FROM watermarks WHERE source='claude-mem';")"
DR_WM="$(roq "$JOURNAL" "SELECT last_key FROM watermarks WHERE source='assay-drain';")"
CM_WM="${CM_WM:-0}"; DR_WM="${DR_WM:-0}"

# Watermarks are interpolated into SQL strings below. A non-numeric watermark means the journal
# is corrupt — never build SQL around it. This is genuine infrastructure failure, so bail hard.
case "$CM_WM" in ''|*[!0-9]*) fatal "corrupt watermark: claude-mem last_key='$CM_WM' is not numeric";; esac
case "$DR_WM" in ''|*[!0-9]*) fatal "corrupt watermark: assay-drain last_key='$DR_WM' is not numeric";; esac

NEW_CM="$(roq "$CM_DB" "SELECT count(*) FROM observations WHERE id > CAST('$CM_WM' AS INTEGER);")"
NEW_DR="$(roq "$DR_DB" "SELECT count(*) FROM decisions WHERE created_at > CAST('$DR_WM' AS INTEGER);")"
# A source-count read FAILURE is an error, never zero (lesson 2026-07-04: a corrupted
# claude-mem db returned empty here, the :-0 default masked 32 unconsumed rows as
# "caught up", and sweeps marked themselves swept while blind). Defer loudly instead.
if [ -z "$NEW_CM" ] || [ -z "$NEW_DR" ]; then
  # Re-run the failed read once with stderr kept, so the log says why it failed.
  CM_ERR=""; DR_ERR=""
  [ -z "$NEW_CM" ] && CM_ERR="$("$SQLITE" -cmd ".timeout 5000" -cmd "PRAGMA query_only=1" "file:$CM_DB?mode=rw" "SELECT count(*) FROM observations WHERE id > CAST('$CM_WM' AS INTEGER);" 2>&1 >/dev/null | head -1)"
  [ -z "$NEW_DR" ] && DR_ERR="$("$SQLITE" -cmd ".timeout 5000" -cmd "PRAGMA query_only=1" "file:$DR_DB?mode=rw" "SELECT count(*) FROM decisions WHERE created_at > CAST('$DR_WM' AS INTEGER);" 2>&1 >/dev/null | head -1)"
  log "settle: SOURCE READ ERROR (cm='${NEW_CM:-<empty>}' drain='${NEW_DR:-<empty>}' cm_err='${CM_ERR}' drain_err='${DR_ERR}') — possible source-db corruption; deferring, NOT marking swept. Run health-check + integrity_check."
  exit 0
fi

if [ "$NEW_CM" = 0 ] && [ "$NEW_DR" = 0 ]; then
  # Tick fired but the journal is already caught up. No work was skipped, so we may mark swept —
  # but still honor the tick-race guard: if a new tick landed after this check, leave the marker.
  log "settle: tick fired but 0 new inputs (cm_wm=$CM_WM drain_wm=$DR_WM) — marking swept"
  touch_marker_if_tick_unmoved
  exit 0
fi

PENDING="$(roq "$CM_DB" "SELECT count(*) FROM pending_messages;")"
NEWEST_AGE="$(roq "$CM_DB" "SELECT CAST(strftime('%s','now') AS INTEGER) - COALESCE(MAX(created_at_epoch)/1000, 0) FROM observations;")"
PENDING="${PENDING:-1}"                 # default: assume pending (defer) on a read error
case "$NEWEST_AGE" in ''|*[!0-9-]*) NEWEST_AGE=0;; esac   # default: age 0 (defer) on a bad read

if [ "$PENDING" != 0 ] || [ "$NEWEST_AGE" -le "$SETTLE_BUFFER" ]; then
  log "settle: NOT settled (pending=$PENDING newest_age=${NEWEST_AGE}s buffer=${SETTLE_BUFFER}s new_cm=$NEW_CM new_dr=$NEW_DR) — deferring to next cycle"
  exit 0   # do NOT advance the marker; retry next cycle
fi

log "settle: OK (pending=0 newest_age=${NEWEST_AGE}s new_cm=$NEW_CM new_dr=$NEW_DR) — exporting batch"

# SETTLE SNAPSHOT: freeze the upper bound of what this run may touch, taken at settle time.
# The export below only reads rows with id/created_at <= these values, so any observation or
# decision that lands AFTER we judged the sources settled is left for the next cycle rather
# than exported mid-arrival (unsettled). Targets are derived from this bounded set.
CM_SNAP="$(roq "$CM_DB" "SELECT COALESCE(max(id),0) FROM observations;")"; CM_SNAP="${CM_SNAP:-0}"
DR_SNAP="$(roq "$DR_DB" "SELECT COALESCE(max(created_at),0) FROM decisions;")"; DR_SNAP="${DR_SNAP:-0}"
case "$CM_SNAP" in ''|*[!0-9]*) CM_SNAP="$CM_WM";; esac
case "$DR_SNAP" in ''|*[!0-9]*) DR_SNAP="$DR_WM";; esac
log "settle: snapshot bound cm_snap=$CM_SNAP drain_snap=$DR_SNAP"

# ---------------------------------------------------------------------------------------
# (d) EXPORT BATCH — read-only; caps observations at BATCH_CAP (oldest first).
# ---------------------------------------------------------------------------------------
[ -n "$PYTHON" ] || fatal "python3 not found on PATH"

# Create the private run dir now that we know there's work. mktemp -d makes it 0700; the umask
# and explicit chmod keep it owner-only. Everything for this run (batch + prefilter temp) lives
# inside it and is removed by the EXIT trap (unless KEEP_BATCH for DRY_RUN inspection).
RUN_DIR="$(mktemp -d "$ASSAY_DIR/librarian-run.XXXXXX" 2>/dev/null)" || fatal "could not create run dir under $ASSAY_DIR"
chmod 700 "$RUN_DIR" 2>/dev/null
BATCH="$RUN_DIR/batch.json"

EXPORT_STATS="$("$PYTHON" - "$CM_DB" "$DR_DB" "$CM_WM" "$DR_WM" "$CM_SNAP" "$DR_SNAP" "$BATCH" "$BATCH_CAP" <<'PYEOF'
import sqlite3, json, sys
cm_db, dr_db, cm_wm, dr_wm, cm_snap, dr_snap, out, cap = sys.argv[1:9]
cm_wm = int(cm_wm or 0); dr_wm = int(dr_wm or 0)
cm_snap = int(cm_snap or 0); dr_snap = int(dr_snap or 0); cap = int(cap or 400)

def ro(p):
    c = sqlite3.connect(f"file:{p}?mode=rw", uri=True)
    c.execute("PRAGMA query_only=1")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=5000")
    return c

# Every read is upper-bounded by the settle snapshot (id/created_at <= snap) so rows that
# arrived after the settle check are never exported unsettled. Targets derive from this set.
cm = ro(cm_db)
obs = [dict(r) for r in cm.execute(
    "SELECT id, created_at AS date, type, title, subtitle, facts, narrative "
    "FROM observations WHERE id > ? AND id <= ? ORDER BY id ASC LIMIT ?", (cm_wm, cm_snap, cap)).fetchall()]
total_new = cm.execute("SELECT count(*) FROM observations WHERE id > ? AND id <= ?", (cm_wm, cm_snap)).fetchone()[0]
deferred = max(0, total_new - len(obs))
cm_target = obs[-1]["id"] if obs else cm_wm

dr = ro(dr_db)
drain = [dict(r) for r in dr.execute(
    "SELECT id, kind, substr(body,1,4000) AS body, status, created_at, layer FROM decisions WHERE created_at > ? AND created_at <= ? "
    "ORDER BY created_at ASC", (dr_wm, dr_snap)).fetchall()]
dr_target = max((d["created_at"] for d in drain), default=dr_wm)

batch = {
    "cm_watermark": cm_wm, "drain_watermark": dr_wm,
    "cm_watermark_target": cm_target, "drain_watermark_target": dr_target,
    "observations": obs, "drain": drain, "deferred_observations": deferred,
}
with open(out, "w") as f:
    json.dump(batch, f, ensure_ascii=False)
print(f"{len(obs)} {len(drain)} {deferred} {cm_target} {dr_target}")
PYEOF
)"
EXPORT_RC=$?
if [ "$EXPORT_RC" != 0 ] || [ ! -s "$BATCH" ]; then
  fatal "batch export failed (rc=$EXPORT_RC) — no batch written"
fi
set -- $EXPORT_STATS
N_OBS="${1:-0}"; N_DRAIN="${2:-0}"; N_DEFER="${3:-0}"; CM_TARGET="${4:-$CM_WM}"; DR_TARGET="${5:-$DR_WM}"
# Targets are parsed from the exporter's stdout and interpolated into SQL below, so they
# get the same strict-numeric guard the watermarks get at read time. A malformed target
# would otherwise reach a sqlite3 command string unvalidated (codex review 2026-07-24).
case "$CM_TARGET" in ''|*[!0-9]*) fatal "corrupt batch export: cm_target='$CM_TARGET' is not numeric";; esac
case "$DR_TARGET" in ''|*[!0-9]*) fatal "corrupt batch export: drain_target='$DR_TARGET' is not numeric";; esac
log "batch: observations=$N_OBS drain=$N_DRAIN deferred=$N_DEFER cm_target=$CM_TARGET drain_target=$DR_TARGET file=$BATCH"
[ "$N_DEFER" != 0 ] && log "batch: DEFERRED $N_DEFER observations past the ${BATCH_CAP}-item cap; next cycle will pick them up"

# ---------------------------------------------------------------------------------------
# (d2) PREFILTER — deterministic tiered filing. Auto-files the unambiguous, non-decision,
#      non-supersession observations onto a single system/project authority and rewrites the
#      batch down to the residual the LLM must still handle. If the residual is empty AND there
#      is no drain, we advance both watermarks ourselves (the same statements the librarian
#      would run), compile the glossary, and skip the LLM entirely — a zero-LLM cycle.
#      Under DRY_RUN the prefilter runs read-only (--dry-run): it reports what it would file but
#      writes nothing and never commits, preserving DRY_RUN's no-side-effects contract.
# ---------------------------------------------------------------------------------------
PREFILTER="$LIB_HOME/bin/prefilter.py"
RESID_OBS="$N_OBS"; RESID_DRAIN="$N_DRAIN"; PREFILED=0
if [ -f "$PREFILTER" ]; then
  PF_ARGS=""; [ "$DRY_RUN" = 1 ] && PF_ARGS="--dry-run"
  PF_STATS="$("$PYTHON" "$PREFILTER" "$BATCH" $PF_ARGS 2>>"$LOG")"
  log "prefilter:${PF_ARGS:+ (dry-run)} $PF_STATS"
  # Parse "prefiled=<N> residual_obs=<N> residual_drain=<N>[ error=<msg>]".
  PF_ERR=0; case "$PF_STATS" in *error=*) PF_ERR=1;; esac
  for kv in $PF_STATS; do
    case "$kv" in
      prefiled=*)       PREFILED="${kv#prefiled=}";;
      residual_obs=*)   RESID_OBS="${kv#residual_obs=}";;
      residual_drain=*) RESID_DRAIN="${kv#residual_drain=}";;
    esac
  done
  # Fall back to the pre-prefilter counts on any non-numeric parse (keeps us off the zero path).
  case "$RESID_OBS" in ''|*[!0-9]*) RESID_OBS="$N_OBS";; esac
  case "$RESID_DRAIN" in ''|*[!0-9]*) RESID_DRAIN="$N_DRAIN";; esac
  if [ "$DRY_RUN" != 1 ] && [ "$PF_ERR" = 0 ] && [ "$RESID_OBS" = 0 ] && [ "$RESID_DRAIN" = 0 ]; then
    # Whole batch auto-filed and nothing draining — commit watermarks ourselves, no LLM run.
    # Both advances in ONE transaction: a half-advanced watermark pair is exactly the
    # non-atomic state the 2026-07-08 data-loss postmortem traced losses to.
    "$SQLITE" "$JOURNAL" -cmd ".timeout 30000" \
      "BEGIN IMMEDIATE;
       UPDATE watermarks SET last_key='$CM_TARGET', updated=datetime('now') WHERE source='claude-mem';
       UPDATE watermarks SET last_key='$DR_TARGET', updated=datetime('now') WHERE source='assay-drain';
       COMMIT;" \
      >>"$LOG" 2>&1
    WM_RC=$?
    if [ "$WM_RC" != 0 ]; then
      log "prefilter-cycle: watermark advance FAILED (rc=$WM_RC) — falling through to LLM path"
    else
      if [ -f "$GLOSSARY" ]; then
        if "$PYTHON" "$GLOSSARY" >>"$LOG" 2>&1; then log "glossary-compile: ok"
        else log "glossary-compile: WARN exit $?"; fi
      else
        log "glossary-compile: WARN script missing at $GLOSSARY — skipped"
      fi
      rm -f "$BATCH" 2>/dev/null
      touch_marker_if_tick_unmoved
      log "post: watermarks advanced cm $CM_WM->$CM_TARGET drain $DR_WM->$DR_TARGET (prefilter-only)"
      log "sweep: COMPLETE (prefilter-only cycle — zero LLM)"
      exit 0
    fi
  fi
else
  log "prefilter: WARN script missing at $PREFILTER — skipped (full batch to LLM)"
fi

# ---------------------------------------------------------------------------------------
# (e) RUN LIBRARIAN (headless claude -p). DRY_RUN skips the actual invocation.
# ---------------------------------------------------------------------------------------
[ -f "$PROMPT" ] || fatal "librarian prompt missing at $PROMPT"

# PRE-RUN BACKUP — one rolling snapshot of the journal, overwritten each run, taken immediately
# before the librarian could mutate it. Blast-radius mitigation: if a run corrupts the journal,
# this is the last-known-good copy. A failed backup only WARNs — it must not block the sweep.
PRESWEEP_BACKUP="$ASSAY_DIR/librarian.db.pre-sweep"
if "$SQLITE" -cmd ".timeout 10000" "$JOURNAL" ".backup '$PRESWEEP_BACKUP'" >>"$LOG" 2>&1; then
  log "pre-sweep backup: ok -> $PRESWEEP_BACKUP"
else
  log "pre-sweep backup: WARN failed (rc=$?) — proceeding without a fresh snapshot"
fi

if [ "$DRY_RUN" = 1 ]; then
  log "DRY_RUN=1 — skipping claude invocation; batch left at $BATCH for inspection"
  KEEP_BATCH=1      # keep batch for inspection; marker stays put (treated as an incomplete run)
  CLAUDE_EXIT=0
  DRY=1
else
  [ -n "$CLAUDE" ]  || fatal "claude binary not found on PATH"
  [ -n "$TIMEOUT" ] || fatal "timeout/gtimeout not found on PATH"
  DRY=0
  log "librarian: running (model=$LIBRARIAN_MODEL timeout=${CLAUDE_TIMEOUT}s)"
  log "librarian: permission_mode=$PERMISSION_MODE allowed_tools=${ALLOWED_TOOLS:-<unset>}"
  PERM_ARGS=(--permission-mode "$PERMISSION_MODE")
  [ -n "$ALLOWED_TOOLS" ] && PERM_ARGS+=(--allowedTools "$ALLOWED_TOOLS")
  # --settings disables memory plugins for the librarian's own session: without this,
  # claude-mem observes the sweep and every run generates observations about itself,
  # which the next sweep ingests — a perpetual self-documentation loop. Verified 2026-07-02:
  # with the override, pending_messages stays 0 during a headless run.
  "$TIMEOUT" "$CLAUDE_TIMEOUT" "$CLAUDE" -p \
      --model "$LIBRARIAN_MODEL" \
      "${PERM_ARGS[@]}" \
      --settings '{"enabledPlugins":{},"hooks":{}}' \
      "$(cat "$PROMPT") BATCH FILE: $BATCH · RUNS LOG: $RUNS_JSONL" >"$CLAUDE_OUT" 2>&1
  CLAUDE_EXIT=$?
  log "librarian: exit=$CLAUDE_EXIT — last 50 lines of output follow:"
  tail -n 50 "$CLAUDE_OUT" 2>/dev/null | sed 's/^/    | /' >>"$LOG"
  [ "$CLAUDE_EXIT" = 124 ] && log "librarian: TIMED OUT after ${CLAUDE_TIMEOUT}s"
fi

# ---------------------------------------------------------------------------------------
# (f) POST — glossary compile, verify watermarks advanced, decide marker.
# ---------------------------------------------------------------------------------------
if [ -f "$GLOSSARY" ]; then
  if "$PYTHON" "$GLOSSARY" >>"$LOG" 2>&1; then log "glossary-compile: ok"
  else log "glossary-compile: WARN exit $?"; fi
else
  log "glossary-compile: WARN script missing at $GLOSSARY — skipped"
fi

POST_CM="$(roq "$JOURNAL" "SELECT last_key FROM watermarks WHERE source='claude-mem';")"; POST_CM="${POST_CM:-$CM_WM}"
POST_DR="$(roq "$JOURNAL" "SELECT last_key FROM watermarks WHERE source='assay-drain';")"; POST_DR="${POST_DR:-$DR_WM}"

# DUAL-WATERMARK SUCCESS: the run is committed only if BOTH watermarks reached this batch's
# targets (numeric equality). When a source had nothing new, its target equals its watermark,
# so equality still holds. "Either advanced" is not enough — a half-filed run must be retried.
wm_ok=0
if is_num "$POST_CM" && is_num "$POST_DR" && is_num "$CM_TARGET" && is_num "$DR_TARGET" \
   && [ "$POST_CM" -eq "$CM_TARGET" ] && [ "$POST_DR" -eq "$DR_TARGET" ]; then
  wm_ok=1
fi

if [ "$DRY" = 1 ]; then
  # KEEP_BATCH=1 keeps the batch; the EXIT trap still releases the lock and clears CLAUDE_OUT.
  log "DRY_RUN complete — marker NOT advanced, batch retained at $BATCH"
  exit 0
fi

# ---------------------------------------------------------------------------------------
# (f2) COVERAGE AUDIT — the anti-data-loss gate (added 2026-07-08).
#     Watermark equality alone proved insufficient: the librarian can advance watermarks having
#     filed only PART of the batch (measured 73.9-86% loss on affected batches), and once the
#     batch is deleted those items are unreachable forever. So before we accept a run, every
#     batch item must have a durable disposition (evidence / unfiled / processed ruling).
#     Missing items are appended to the unfiled ledger by the verifier (never lost), and the
#     run is retried by ROLLING THE WATERMARKS BACK to their pre-run values — bounded at
#     3 retries per starting watermark so a chronically incomplete batch can't livelock.
# ---------------------------------------------------------------------------------------
COVERAGE_MISSING=0
COVERAGE_ERR=0
if [ "$CLAUDE_EXIT" = 0 ] && [ "$wm_ok" = 1 ] && [ -f "$COVERAGE" ] && [ -f "$BATCH" ]; then
  COV_STATS="$("$PYTHON" "$COVERAGE" "$BATCH" "$UNFILED_LEDGER" 2>>"$LOG")"
  log "coverage: $COV_STATS"
  # An audit that errored cannot prove preservation. Critically, a LEDGER-WRITE failure
  # reports missing>0 with error= — and the give-up path would then accept the run while
  # logging "items preserved in the ledger", which would be a lie, and delete the batch.
  # So the error flag is load-bearing control flow, not a log line (codex review 2026-07-24).
  case "$COV_STATS" in *error=*) COVERAGE_ERR=1;; esac
  for kv in $COV_STATS; do case "$kv" in missing=*) COVERAGE_MISSING="${kv#missing=}";; esac; done
  is_num "$COVERAGE_MISSING" || COVERAGE_MISSING=0
  if [ "$COVERAGE_ERR" = 1 ] && [ "$COVERAGE_MISSING" = 0 ]; then
    log "coverage: WARN audit errored with nothing missing — cannot prove loss either way; accepting run"
  fi
elif [ "$CLAUDE_EXIT" = 0 ] && [ "$wm_ok" = 1 ] && [ ! -f "$COVERAGE" ]; then
  log "coverage: WARN verifier missing at $COVERAGE — skipped (pre-audit behavior)"
fi

if [ "$CLAUDE_EXIT" = 0 ] && [ "$wm_ok" = 1 ] && [ "$COVERAGE_MISSING" != 0 ]; then
  # Watermarks are past items with no disposition — the silent-loss state. Decide retry/accept.
  RETRY_COUNT=0
  if [ -f "$COVERAGE_RETRIES" ]; then
    # Keyed on BOTH watermarks. Keyed on cm alone, a run where claude-mem had nothing new
    # (cm unchanged) but the drain did would inherit a previous batch's retry count and
    # give up early on its first attempt (codex review 2026-07-24).
    read -r PREV_CM PREV_DR PREV_COUNT <"$COVERAGE_RETRIES" 2>/dev/null
    [ "${PREV_CM:-}" = "$CM_WM" ] && [ "${PREV_DR:-}" = "$DR_WM" ] && is_num "${PREV_COUNT:-}" \
      && RETRY_COUNT="$PREV_COUNT"
  fi
  # Give up ONLY when the ledger actually holds the missing items. If the audit errored,
  # preservation is unproven, so retry forever rather than accept-and-delete on a false
  # "preserved" claim. A stuck batch is recoverable; a deleted one is not.
  if [ "$COVERAGE_ERR" = 1 ]; then
    log "ERROR coverage: audit errored with $COVERAGE_MISSING missing — preservation UNPROVEN; refusing the give-up path, rolling back and retrying (batch retained)"
  fi
  if [ "$RETRY_COUNT" -ge 3 ] && [ "$COVERAGE_ERR" = 0 ]; then
    # Bounded give-up: the items are preserved in the unfiled ledger; accept the run so the
    # pipeline moves on, but say so loudly — this needs a human look.
    log "ERROR coverage: $COVERAGE_MISSING item(s) STILL undispositioned after $RETRY_COUNT retries — accepting run; items preserved in $UNFILED_LEDGER (HUMAN REVIEW NEEDED)"
    rm -f "$COVERAGE_RETRIES" 2>/dev/null
  else
    RETRY_COUNT=$((RETRY_COUNT + 1))
    printf '%s %s %s\n' "$CM_WM" "$DR_WM" "$RETRY_COUNT" >"$COVERAGE_RETRIES"
    "$SQLITE" "$JOURNAL" -cmd ".timeout 30000" \
      "BEGIN IMMEDIATE;
       UPDATE watermarks SET last_key='$CM_WM', updated=datetime('now') WHERE source='claude-mem';
       UPDATE watermarks SET last_key='$DR_WM', updated=datetime('now') WHERE source='assay-drain';
       COMMIT;" >>"$LOG" 2>&1
    RB_RC=$?
    if [ "$RB_RC" = 0 ]; then
      log "ERROR coverage: $COVERAGE_MISSING item(s) have NO disposition — watermarks ROLLED BACK cm $POST_CM->$CM_WM drain $POST_DR->$DR_WM (retry $RETRY_COUNT/3); batch re-exports next cycle"
      if mv -f "$BATCH" "$LOGDIR/last-failed-batch.json" 2>/dev/null; then
        chmod 600 "$LOGDIR/last-failed-batch.json" 2>/dev/null
      fi
      log "sweep: INCOMPLETE — marker NOT advanced (coverage retry); batch saved to logs/last-failed-batch.json"
      exit 0
    fi
    log "ERROR coverage: watermark ROLLBACK FAILED (rc=$RB_RC) — accepting run to avoid an inconsistent state; missing items preserved in $UNFILED_LEDGER"
  fi
fi

if [ "$CLAUDE_EXIT" = 0 ] && [ "$wm_ok" = 1 ]; then
  log "post: watermarks reached targets cm $CM_WM->$POST_CM (target $CM_TARGET) drain $DR_WM->$POST_DR (target $DR_TARGET)"
  rm -f "$BATCH" "$COVERAGE_RETRIES" 2>/dev/null
  touch_marker_if_tick_unmoved
  log "sweep: COMPLETE (filed run committed; marker advanced)"
else
  if [ "$CLAUDE_EXIT" = 0 ]; then
    log "ERROR librarian exited 0 but watermarks did NOT reach targets — cm post=$POST_CM target=$CM_TARGET, drain post=$POST_DR target=$DR_TARGET — treating as failed"
  else
    log "ERROR librarian failed (exit=$CLAUDE_EXIT) — cm post=$POST_CM target=$CM_TARGET, drain post=$POST_DR target=$DR_TARGET"
  fi
  if mv -f "$BATCH" "$LOGDIR/last-failed-batch.json" 2>/dev/null; then
    chmod 600 "$LOGDIR/last-failed-batch.json" 2>/dev/null
  fi
  log "sweep: INCOMPLETE — marker NOT advanced (retries next cycle); batch saved to logs/last-failed-batch.json"
fi

exit 0
