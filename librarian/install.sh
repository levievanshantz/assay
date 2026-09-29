#!/usr/bin/env bash
# install.sh — wire the librarian into this machine.
#
# What it does, in order (each step says what it did):
#   1. Preflight: macOS, sqlite3, python3, uuidgen, shlock, the claude CLI, and a
#      claude-mem database with the schema the sweep reads.
#   2. Confirm: explains the unattended worker (headless `claude -p` with
#      --permission-mode bypassPermissions over untrusted observation text) and stops
#      unless you type the exact confirmation. Declining installs nothing.
#   3. Journal: creates ~/.assay/librarian.db + the decision drain (bin/init-journal.py).
#      Refuses to touch an existing journal. The drain ~/.assay/decisions.db belongs to
#      the Assay plugin: it is created with the plugin's own schema if absent and left
#      alone if the plugin already made it, so install order does not matter.
#   4. Hooks: merges two entries into ~/.claude/settings.json — a SessionStart hook that
#      injects the glossary and a Stop hook that ticks the sweep. Your existing settings
#      are backed up first and never removed; if the entries are already present this is
#      a no-op.
#   5. Scheduler: renders the launchd template with this directory's path and loads it
#      (20-minute heartbeat + fires within seconds of a session ending).
#
# Re-runnable: every step is idempotent or refuses rather than clobbers. Every path is
# resolved from this script's own location, so it works from any cwd — including as the
# librarian/ subdirectory of the assay repo (git clone ... && cd assay/librarian).
#
# Usage:
#   ./install.sh [--backfill-days N]
set -euo pipefail

# Physical path (pwd -P): the hook commands and launchd paths written below must be
# the same string however install.sh is invoked (./install.sh from inside the
# directory, bash <path>/install.sh from elsewhere, or through a symlinked path
# such as macOS's /var -> /private/var). Otherwise a re-run would not recognize
# its own hooks and would register them a second time.
LIB_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SETTINGS="$HOME/.claude/settings.json"
PLIST_LABEL="com.librarian.sweep"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
BACKFILL=""
[ "${1:-}" = "--backfill-days" ] && BACKFILL="--backfill-days ${2:?--backfill-days needs a number}"

step() { printf '\n== %s ==\n' "$*"; }
die() { printf 'install.sh: FAIL — %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------------------
step "1/5 preflight"
# ---------------------------------------------------------------------------------------
[ "$(uname)" = "Darwin" ] || die "macOS only: sweep.sh depends on BSD stat and shlock. See LIMITATIONS.md."
for bin in sqlite3 python3 uuidgen shlock; do
  command -v "$bin" >/dev/null || die "$bin not found on PATH"
done
command -v claude >/dev/null || die "claude CLI not found — the librarian worker runs headless via 'claude -p'.
  Install Claude Code first: https://claude.com/claude-code"
command -v timeout >/dev/null 2>&1 || command -v gtimeout >/dev/null 2>&1 \
  || die "no timeout/gtimeout — install coreutils: brew install coreutils"
[ -f "$HOME/.claude-mem/claude-mem.db" ] \
  || die "claude-mem database not found. Install the claude-mem plugin in Claude Code and run
  one session so it creates ~/.claude-mem/claude-mem.db — it is the capture substrate.
  (In Claude Code: /plugin install claude-mem@thedotmack)"
echo "   macOS + sqlite3 + python3 + uuidgen + shlock + claude + timeout + claude-mem: all present"

# ---------------------------------------------------------------------------------------
step "2/5 confirm the unattended worker"
# ---------------------------------------------------------------------------------------
# Nothing has been written yet. This gate sits before the first change so declining leaves
# the machine exactly as it was. See "Security model" in README.md for the full picture.
CONFIRM_PHRASE="bypassPermissions"
cat <<EOF
   This installs a launchd job that runs bin/sweep.sh every 20 minutes and within seconds
   of each Claude Code turn ending. When a batch needs judgment it starts a headless
     claude -p --permission-mode bypassPermissions
   (Sonnet by default, up to 15 minutes) as you, on your Claude subscription, with NO
   permission prompts and no sandbox: it can run any command and read or write any file
   your user can. Its input is verbatim text from your claude-mem observations and captured
   decisions, which can hold anything your sessions saw (web pages, files, tool output).
   Text written to look like instructions could steer that worker.

   To install anyway, type exactly:  $CONFIRM_PHRASE
EOF
printf '   > '
CONFIRM=""
read -r CONFIRM || true
[ "$CONFIRM" = "$CONFIRM_PHRASE" ] \
  || die "not confirmed — nothing was installed. Read \"Security model\" in README.md, then re-run."
echo "   confirmed"

# ---------------------------------------------------------------------------------------
step "3/5 journal + drain"
# ---------------------------------------------------------------------------------------
if [ -f "$HOME/.assay/librarian.db" ]; then
  echo "   journal already exists at ~/.assay/librarian.db — keeping it (init skipped)"
  # Still make sure the drain exists and is on the Assay plugin's schema.
  python3 "$LIB_HOME/bin/init-journal.py" --drain-only
else
  # shellcheck disable=SC2086
  python3 "$LIB_HOME/bin/init-journal.py" $BACKFILL
fi
mkdir -p "$LIB_HOME/logs"
chmod +x "$LIB_HOME"/bin/*.sh "$LIB_HOME"/bin/*.py 2>/dev/null || true

# ---------------------------------------------------------------------------------------
step "4/5 hooks -> ~/.claude/settings.json"
# ---------------------------------------------------------------------------------------
python3 - "$SETTINGS" "$LIB_HOME" <<'PY'
import json, os, shutil, sys, time

settings_path, lib_home = sys.argv[1], sys.argv[2]
inject = os.path.join(lib_home, "bin", "inject-glossary.sh")
onstop = os.path.join(lib_home, "bin", "on-stop.sh")

os.makedirs(os.path.dirname(settings_path), exist_ok=True)
if os.path.exists(settings_path):
    backup = settings_path + ".pre-librarian." + time.strftime("%Y%m%d%H%M%S")
    shutil.copy2(settings_path, backup)
    print(f"   settings backed up -> {backup}")
    with open(settings_path) as f:
        settings = json.load(f)   # a parse error here must abort, not clobber
else:
    settings = {}
    print("   no existing settings.json — creating one")

hooks = settings.setdefault("hooks", {})

def same_file(a, b):
    """True when two hook commands name the same script, even through different
    spellings of its path (a symlinked prefix, or an earlier install that
    recorded the unresolved path)."""
    if not isinstance(a, str) or not isinstance(b, str):
        return False
    return a == b or os.path.realpath(a) == os.path.realpath(b)

def ensure(event, command, extra=None):
    """Append a command hook under `event` unless the same script is already wired."""
    groups = hooks.setdefault(event, [])
    for g in groups:
        for h in g.get("hooks", []):
            if same_file(h.get("command"), command):
                print(f"   {event}: already wired — skipped")
                return
    entry = {"type": "command", "command": command}
    if extra:
        entry.update(extra)
    groups.append({"matcher": "*", "hooks": [entry]})
    print(f"   {event}: + {os.path.basename(command)}")

ensure("SessionStart", inject)
ensure("Stop", onstop, {"timeout": 5, "async": True})

tmp = settings_path + ".tmp"
with open(tmp, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
os.replace(tmp, settings_path)
print("   settings.json written")
PY

# ---------------------------------------------------------------------------------------
step "5/5 scheduler (launchd)"
# ---------------------------------------------------------------------------------------
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__LIB_HOME__|$LIB_HOME|g" -e "s|__HOME__|$HOME|g" \
  "$LIB_HOME/com.librarian.sweep.plist.template" > "$PLIST_DST"
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
launchctl list | grep -q "$PLIST_LABEL" || die "launchd job did not load — check $PLIST_DST"
echo "   loaded $PLIST_LABEL (heartbeat 20 min + fires after each session ends)"

# ---------------------------------------------------------------------------------------
printf '\n== installed ==\n'
cat <<EOF

Next:
  1. Work normally in Claude Code. claude-mem captures observations ambiently;
     ending a session ticks the sweep.
  2. After a few sessions:  $LIB_HOME/bin/health-check.sh
  3. Your next NEW session will open with a "Decision-State Glossary" block —
     that is the journal talking to your Claude instance.

What a healthy first sweep looks like (logs/sweep-YYYYMMDD.log):
  settle: OK (pending=0 newest_age=...s new_cm=N new_dr=0) — exporting batch
  batch: observations=N drain=0 ...
  prefilter: prefiled=X residual_obs=Y residual_drain=0
  librarian: running (model=claude-sonnet-4-6 timeout=900s)
  coverage: missing=0 ...
  sweep: COMPLETE (filed run committed; marker advanced)

If a sweep ever ends INCOMPLETE with "ROLLED BACK", that is the coverage gate doing
its job — the batch retries next cycle. See POSTMORTEM.md for why that gate exists.

To rule on a flag the librarian raises:   bin/rule.sh "flag #N: <verdict>"
To explicitly record a decision:          bin/deposit.sh "<one sentence>"
Read OPERATING.md for the day-to-day loop.
EOF
