"""Source reads must work on a WAL database whose writer has closed.

The plugin keeps decisions.db in WAL mode. When its last connection closes, the -wal and -shm
files are removed. Apple's /usr/bin/sqlite3 then refuses a -readonly open of that file
("unable to open database file (14)"), which made every sweep defer with SOURCE READ ERROR.
The sweep's roq() helper now opens with mode=rw plus PRAGMA query_only. This test runs that
exact helper, extracted from bin/sweep.sh, against every sqlite3 binary it can find.
"""
import os
import shutil
import sqlite3
import subprocess
import tempfile
import unittest

LIB_HOME = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
SWEEP = os.path.join(LIB_HOME, "bin", "sweep.sh")


def candidate_binaries():
    """Every distinct sqlite3 on this machine worth testing, Apple's first."""
    found = []
    for path in ("/usr/bin/sqlite3", shutil.which("sqlite3")):
        seen = [os.path.realpath(p) for p in found]
        if path and os.path.exists(path) and os.path.realpath(path) not in seen:
            found.append(path)
    return found


def closed_wal_db(directory):
    """Create a WAL database with one row, close it, and return its path."""
    path = os.path.join(directory, "decisions.db")
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE decisions (created_at INTEGER)")
    conn.execute("INSERT INTO decisions VALUES (5)")
    conn.commit()
    conn.close()
    return path


def run_roq(binary, db, sql):
    """Run bin/sweep.sh's roq() in isolation with SQLITE pointed at binary."""
    script = (
        f'SQLITE="{binary}"\n'
        f'eval "$(sed -n \'/^roq() {{/,/^}}/p\' "{SWEEP}")"\n'
        f'roq "{db}" "{sql}"\n'
    )
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, check=False)


class WalRead(unittest.TestCase):
    """roq() reads closed WAL databases, refuses writes, and never creates files."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.binaries = candidate_binaries()
        if not self.binaries:
            self.skipTest("no sqlite3 binary on this machine")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_sweep_does_not_use_readonly_flag(self):
        """sweep.sh must not go back to opening sources with -readonly."""
        with open(SWEEP, encoding="utf-8") as f:
            code = [line for line in f if not line.lstrip().startswith("#")]
        self.assertFalse(any('-readonly "' in line for line in code),
                         "sweep.sh opens a source with -readonly again")

    def test_reads_closed_wal_database(self):
        """A WAL database whose writer closed is readable with every sqlite3 found."""
        db = closed_wal_db(self.dir)
        for binary in self.binaries:
            with self.subTest(binary=binary):
                out = run_roq(binary, db, "SELECT count(*) FROM decisions;")
                self.assertEqual(out.stdout.strip(), "1", f"{binary}: {out.stderr}")

    def test_refuses_writes(self):
        """query_only keeps roq() from changing data."""
        db = closed_wal_db(self.dir)
        for binary in self.binaries:
            with self.subTest(binary=binary):
                run_roq(binary, db, "INSERT INTO decisions VALUES (9);")
                conn = sqlite3.connect(db)
                count = conn.execute("SELECT count(*) FROM decisions").fetchone()[0]
                conn.close()
                self.assertEqual(count, 1, f"{binary} wrote through roq()")

    def test_never_creates_missing_database(self):
        """mode=rw opens existing files only."""
        missing = os.path.join(self.dir, "absent.db")
        for binary in self.binaries:
            with self.subTest(binary=binary):
                out = run_roq(binary, missing, "SELECT 1;")
                self.assertEqual(out.stdout.strip(), "")
                self.assertFalse(os.path.exists(missing), f"{binary} created {missing}")


if __name__ == "__main__":
    unittest.main()
