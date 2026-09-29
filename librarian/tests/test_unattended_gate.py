#!/usr/bin/env python3
"""test_unattended_gate.py — the installer's consent gate and the worker's permission knobs.

The scheduled sweep runs a headless `claude -p --permission-mode bypassPermissions` over
untrusted observation text (see "Security model" in README.md). These tests pin:

    install.sh installs NOTHING unless the exact confirmation phrase is typed
    install.sh works from the monorepo layout (assay/librarian/) and from any cwd
    the worker's permission mode defaults to today's value and is overridable
    LIBRARIAN_CLAUDE_BIN pins the worker binary ahead of anything on the sweep's PATH

No real claude and no real launchctl ever run: both are replaced by fakes, and each test
asserts the fake is what resolves before running anything. $HOME is a temp directory.

Run:  python3 -m unittest discover tests -v
"""

import json
import os
import plistlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LIB_HOME = os.path.dirname(HERE)
SEED = os.path.join(HERE, "fixtures", "seed.py")
PHRASE = "bypassPermissions"

FAKE_LAUNCHCTL = """#!/bin/bash
# Records every call; `list` reports the job only after a `load`.
LOG="$(dirname "$0")/launchctl.calls"
echo "$*" >>"$LOG"
if [ "$1" = list ] && grep -q '^load ' "$LOG" 2>/dev/null; then
  printf -- '-\\t0\\tcom.librarian.sweep\\n'
fi
exit 0
"""

# install.sh only checks that `claude` exists; if anything ever executes it, it says so loudly.
FAKE_CLAUDE_NEVER = """#!/bin/bash
echo "fake claude executed: $*" >>"$(dirname "$0")/claude.calls"
exit 1
"""

# The sweep's worker: record argv (NUL-separated; the prompt is multi-line) and exit 0.
FAKE_CLAUDE_RECORDER = """#!/bin/bash
printf '%s\\0' "$@" >"$(dirname "$0")/claude.argv"
exit 0
"""


def read(path):
    with open(path) as f:
        return f.read()


def write_exec(path, body):
    with open(path, "w") as f:
        f.write(body)
    os.chmod(path, 0o755)


class Base(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="librarian-gate-")
        self.home = os.path.join(self.root, "home")
        self.shims = os.path.join(self.root, "shims")
        os.makedirs(self.shims)
        write_exec(os.path.join(self.shims, "timeout"), '#!/bin/sh\nshift\nexec "$@"\n')

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def env(self, **extra):
        env = dict(os.environ)
        env.update(HOME=self.home, PATH=self.shims + os.pathsep + env["PATH"], **extra)
        return env

    def assert_resolves_to_shim(self, name, env):
        found = shutil.which(name, path=env["PATH"])
        self.assertEqual(found, os.path.join(self.shims, name),
                         f"refusing to run: `{name}` would resolve to {found}, not the fake")


class InstallGate(Base):
    """install.sh, run exactly as a user would after `git clone ... && cd assay/librarian`."""

    def setUp(self):
        super().setUp()
        # The monorepo layout: <clone>/librarian/. install.sh must find everything from there.
        self.lib = os.path.join(self.root, "clone", "assay", "librarian")
        shutil.copytree(LIB_HOME, self.lib, ignore=shutil.ignore_patterns(
            "logs", "__pycache__", ".git"))
        write_exec(os.path.join(self.shims, "launchctl"), FAKE_LAUNCHCTL)
        write_exec(os.path.join(self.shims, "claude"), FAKE_CLAUDE_NEVER)
        os.makedirs(os.path.join(self.home, ".claude-mem"))
        subprocess.run([sys.executable, SEED, os.path.join(self.root, "seedhome"),
                        "--observations", "4"], check=True, capture_output=True)
        shutil.copy(os.path.join(self.root, "seedhome", ".claude-mem", "claude-mem.db"),
                    os.path.join(self.home, ".claude-mem", "claude-mem.db"))
        self.plist = os.path.join(self.home, "Library", "LaunchAgents", "com.librarian.sweep.plist")
        self.settings = os.path.join(self.home, ".claude", "settings.json")

    def install(self, typed, cwd, lib=None):
        """Run install.sh as a user would: `./install.sh` from inside the directory, or
        `bash <lib>/install.sh` from anywhere else. `lib` defaults to self.lib and may be
        another spelling of the same directory (through a symlink)."""
        lib = lib or self.lib
        env = self.env()
        self.assert_resolves_to_shim("launchctl", env)
        self.assert_resolves_to_shim("claude", env)
        cmd = ["./install.sh"] if cwd == lib else ["bash", os.path.join(lib, "install.sh")]
        return subprocess.run(cmd, cwd=cwd, env=env, input=typed, capture_output=True, text=True)

    def hook_commands(self):
        with open(self.settings) as f:
            hooks = json.load(f)["hooks"]
        return {event: [h["command"] for g in hooks[event] for h in g["hooks"]]
                for event in ("SessionStart", "Stop")}

    def launchctl_calls(self):
        p = os.path.join(self.shims, "launchctl.calls")
        return read(p).splitlines() if os.path.exists(p) else []

    def assert_nothing_installed(self):
        self.assertFalse(os.path.exists(os.path.join(self.home, ".assay")), "~/.assay was created")
        self.assertFalse(os.path.exists(self.settings), "settings.json was written")
        self.assertFalse(os.path.exists(self.plist), "the launchd plist was written")
        self.assertEqual(self.launchctl_calls(), [], "launchctl was called")
        self.assertFalse(os.path.exists(os.path.join(self.lib, "logs")), "logs/ was created")

    def test_wrong_or_missing_confirmation_installs_nothing(self):
        for typed in ("yes\n", "y\n", "bypasspermissions\n", "\n", ""):
            with self.subTest(typed=typed):
                p = self.install(typed, cwd=self.root)
                self.assertNotEqual(p.returncode, 0)
                self.assertIn("not confirmed — nothing was installed", p.stderr)
                self.assertIn("--permission-mode bypassPermissions", p.stdout,
                              "the prompt must say exactly what will run")
                self.assert_nothing_installed()

    def test_confirmed_install_from_the_monorepo_subdirectory(self):
        p = self.install(PHRASE + "\n", cwd=self.root)          # from outside the directory
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("== installed ==", p.stdout)
        # install.sh records the physical path. self.lib may sit under a symlinked
        # temp dir (macOS: /var -> /private/var), so compare against its real path.
        lib = os.path.realpath(self.lib)

        with open(self.plist, "rb") as f:
            plist = plistlib.load(f)                            # well-formed after rendering
        self.assertEqual(plist["ProgramArguments"], ["/bin/bash", os.path.join(lib, "bin", "sweep.sh")])
        self.assertEqual(plist["WorkingDirectory"], lib)
        self.assertEqual(plist["WatchPaths"], [os.path.join(self.home, ".assay", "librarian.tick")])
        self.assertEqual(plist["StandardOutPath"], os.path.join(lib, "logs", "launchd.log"))
        self.assertIn(f"load {self.plist}", self.launchctl_calls())

        with open(self.settings) as f:
            hooks = json.load(f)["hooks"]
        start = hooks["SessionStart"][0]["hooks"][0]["command"]
        stop = hooks["Stop"][0]["hooks"][0]["command"]
        self.assertEqual(start, os.path.join(lib, "bin", "inject-glossary.sh"))
        self.assertEqual(stop, os.path.join(lib, "bin", "on-stop.sh"))
        for cmd in (start, stop, plist["ProgramArguments"][1]):
            self.assertTrue(os.access(cmd, os.X_OK), f"{cmd} missing or not executable")

        self.assertTrue(os.path.isdir(os.path.join(self.lib, "logs")))
        self.assertTrue(os.path.exists(os.path.join(self.home, ".assay", "librarian.db")))
        db = sqlite3.connect(os.path.join(self.home, ".assay", "decisions.db"))
        cols = {r[1] for r in db.execute("PRAGMA table_info(decisions)")}
        db.close()
        self.assertIn("supersedes_resolved_id", cols, "drain must carry the plugin schema")
        self.assertFalse(os.path.exists(os.path.join(self.shims, "claude.calls")),
                         "install.sh must never execute claude")

        # Re-run from inside the directory: idempotent, still gated, nothing duplicated.
        again = self.install(PHRASE + "\n", cwd=self.lib)
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertIn("journal already exists", again.stdout)
        self.assertIn("left untouched", again.stdout)
        with open(self.settings) as f:
            hooks = json.load(f)["hooks"]
        self.assertEqual(len(hooks["SessionStart"]), 1)
        self.assertEqual(len(hooks["Stop"]), 1)

    def test_reinstall_through_a_different_path_to_the_same_directory_adds_no_hooks(self):
        # The same clone reached two ways: through a symlink, and by its real path.
        # Whichever way install.sh runs, a second run must be a no-op for the hooks.
        real = os.path.realpath(self.lib)
        link = os.path.join(self.root, "link-to-clone")
        os.symlink(os.path.dirname(real), link)                  # link-to-clone -> <real>/assay
        via_link = os.path.join(link, "librarian")
        self.assertNotEqual(via_link, real)
        self.assertEqual(os.path.realpath(via_link), real)

        runs = [
            (self.root, via_link),   # bash <symlinked path>/install.sh, from elsewhere
            (real, real),            # ./install.sh from inside the real directory
            (via_link, via_link),    # ./install.sh from inside, entered through the symlink
        ]
        for cwd, lib in runs:
            with self.subTest(cwd=cwd, lib=lib):
                p = self.install(PHRASE + "\n", cwd=cwd, lib=lib)
                self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
                self.assertEqual(self.hook_commands(), {
                    "SessionStart": [os.path.join(real, "bin", "inject-glossary.sh")],
                    "Stop": [os.path.join(real, "bin", "on-stop.sh")],
                })

    def test_reinstall_recognizes_hooks_an_earlier_install_wrote_with_an_unresolved_path(self):
        # Installs before the pwd -P fix could record the symlinked spelling. A re-run
        # with the fix must treat those entries as already wired, not add new ones.
        real = os.path.realpath(self.lib)
        link = os.path.join(self.root, "link-to-clone")
        os.symlink(os.path.dirname(real), link)
        old = os.path.join(link, "librarian", "bin")
        os.makedirs(os.path.dirname(self.settings))
        with open(self.settings, "w") as f:
            json.dump({"hooks": {
                "SessionStart": [{"matcher": "*", "hooks": [
                    {"type": "command", "command": os.path.join(old, "inject-glossary.sh")}]}],
                "Stop": [{"matcher": "*", "hooks": [
                    {"type": "command", "command": os.path.join(old, "on-stop.sh"), "timeout": 5, "async": True}]}],
            }}, f)
        p = self.install(PHRASE + "\n", cwd=real, lib=real)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("SessionStart: already wired", p.stdout)
        self.assertIn("Stop: already wired", p.stdout)
        self.assertEqual(self.hook_commands(), {
            "SessionStart": [os.path.join(old, "inject-glossary.sh")],
            "Stop": [os.path.join(old, "on-stop.sh")],
        })


class WorkerPermissions(Base):
    """What sweep.sh actually passes to the worker binary."""

    def setUp(self):
        super().setUp()
        subprocess.run([sys.executable, SEED, self.home, "--observations", "20",
                        "--age-seconds", "3600"], check=True, capture_output=True)
        self.lib = os.path.join(self.root, "librarian")
        shutil.copytree(LIB_HOME, self.lib, ignore=shutil.ignore_patterns(
            "logs", "__pycache__", ".git", "tests"))
        os.makedirs(os.path.join(self.lib, "logs"))
        self.worker = os.path.join(self.shims, "claude")
        write_exec(self.worker, FAKE_CLAUDE_RECORDER)

    def sweep(self, **extra):
        env = self.env(SETTLE_BUFFER="0", LIBRARIAN_CLAUDE_BIN=self.worker, **extra)
        for k in ("LIBRARIAN_PERMISSION_MODE", "LIBRARIAN_ALLOWED_TOOLS"):
            if k not in extra:
                env.pop(k, None)
        subprocess.run(["bash", os.path.join(self.lib, "bin", "sweep.sh")], env=env,
                       capture_output=True, text=True)
        with open(os.path.join(self.shims, "claude.argv"), "rb") as f:
            return [a.decode() for a in f.read().split(b"\0")[:-1]]

    def flag(self, argv, name):
        return argv[argv.index(name) + 1] if name in argv else None

    def test_default_is_unchanged_bypass_permissions(self):
        argv = self.sweep()
        self.assertEqual(argv[0], "-p")
        self.assertEqual(self.flag(argv, "--permission-mode"), "bypassPermissions")
        self.assertNotIn("--allowedTools", argv)
        self.assertEqual(self.flag(argv, "--settings"), '{"enabledPlugins":{},"hooks":{}}')
        self.assertIn("BATCH FILE: ", argv[-1], "the prompt must stay the last argument")

    def test_mode_and_allowlist_are_overridable(self):
        argv = self.sweep(LIBRARIAN_PERMISSION_MODE="dontAsk",
                          LIBRARIAN_ALLOWED_TOOLS="Read,Bash(sqlite3:*)")
        self.assertEqual(self.flag(argv, "--permission-mode"), "dontAsk")
        self.assertEqual(self.flag(argv, "--allowedTools"), "Read,Bash(sqlite3:*)")
        self.assertIn("BATCH FILE: ", argv[-1])
        log = "".join(read(os.path.join(self.lib, "logs", n))
                      for n in os.listdir(os.path.join(self.lib, "logs")) if n.startswith("sweep-"))
        self.assertIn("librarian: permission_mode=dontAsk allowed_tools=Read,Bash(sqlite3:*)", log)

    def test_pinned_worker_beats_a_claude_earlier_on_the_sweep_path(self):
        # sweep.sh puts $HOME/.local/bin (and /opt/homebrew/bin, /usr/local/bin) AHEAD of the
        # caller's PATH. A claude there must not win over the pinned binary.
        decoy_dir = os.path.join(self.home, ".local", "bin")
        os.makedirs(decoy_dir)
        write_exec(os.path.join(decoy_dir, "claude"),
                   f'#!/bin/bash\ntouch "{self.root}/DECOY-RAN"\nexit 0\n')
        argv = self.sweep()
        self.assertTrue(argv, "the pinned worker did not run")
        self.assertFalse(os.path.exists(os.path.join(self.root, "DECOY-RAN")),
                         "a claude found on the sweep's PATH ran instead of LIBRARIAN_CLAUDE_BIN")


if __name__ == "__main__":
    unittest.main(verbosity=2)
