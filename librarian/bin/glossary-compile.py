#!/usr/bin/env python3
# Pre-existing style in an audited ops script; behavior changes only. pylint: disable=broad-exception-caught,consider-using-f-string,invalid-name,line-too-long,missing-function-docstring
"""glossary-compile.py — compile the Decision-State Glossary from the librarian journal.

Reads authorities + open-flag counts from ~/.assay/librarian.db (READ-ONLY) and
writes:
  ~/.assay/glossary.md       (atomic tmp+rename)
  ~/.assay/glossary.version  (first 12 hex of sha256 of the glossary BODY)

Design notes:
- stdlib only, no external deps.
- The glossary header embeds `v<hash>`, and glossary.version holds the same hash.
  Since the header itself contains the hash, the hash is computed over the BODY
  (every line below the header: the domain sections + footer). This makes the
  version content-addressed and stable across runs when the underlying decision
  state has not changed, while the header's volatile UTC timestamp is excluded
  from the digest.
- HARD CAP 7500 chars. If exceeded, trim from the LOWEST-priority domain upward:
  drop entries oldest-last_evidence-first within a domain, and once a domain is
  emptied it renders as `(<N> entries — query /library)`. Partially-trimmed
  domains show their newest entries plus a `(+<M> older — query /library)` marker.
- Exit 0 ALWAYS. Problems are logged to logs/glossary.log; a failure leaves any
  prior glossary.md untouched.
"""

import hashlib
import os
import sqlite3
import sys
import tempfile
import traceback
from datetime import datetime, timedelta, timezone

HOME = os.path.expanduser("~")
DB_PATH = os.path.join(HOME, ".assay", "librarian.db")
OUT_MD = os.path.join(HOME, ".assay", "glossary.md")
OUT_VERSION = os.path.join(HOME, ".assay", "glossary.version")
LOG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs", "glossary.log")

CAP = 7500

# EXACT priority order (highest first).
DOMAIN_ORDER = [
    "Product",
    "Strategy & GTM",
    "Infra & Tooling",
    "Client Projects",
    "Personal",
]

# Statuses that compress to a struck-through one-liner.
COMPRESSED_STATUSES = {"Superseded", "Retracted"}

FOOTER = (
    "Journal (read-only for you): ~/.assay/librarian.db — never edit it directly; the librarian is the only writer.\n"
    "Routine decisions are captured automatically — do nothing. To close an open flag when the user rules on it, "
    "run: bin/rule.sh 'flag #N: <verdict + why>'. To save something the user explicitly asks to record, "
    "run: bin/deposit.sh '<one-sentence decision>'."
)

# Window (days) and cap for the "Changed recently" section.
RECENT_DAYS = 7
RECENT_MAX = 8


def log(msg):
    """Best-effort append to the glossary log; never raise."""
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write("{} {}\n".format(ts, msg))
    except Exception:
        pass


def load_authorities():
    """Return list of authority dicts with evidence + open-flag counts, read-only."""
    uri = "file:{}?mode=rw".format(DB_PATH)
    con = sqlite3.connect(uri, uri=True, timeout=5.0)
    try:
        con.execute("PRAGMA query_only=1")
        con.execute("PRAGMA busy_timeout=5000")
        # Evidence counts and open-flag counts joined onto each authority.
        rows = con.execute(
            """
            SELECT a.id, a.name, a.domain, a.status, a.one_line, a.last_evidence,
                   (SELECT COUNT(*) FROM evidence e WHERE e.authority_id = a.id) AS ev,
                   (SELECT COUNT(*) FROM flags f
                      WHERE f.authority_id = a.id AND f.status = 'open') AS flags
            FROM authorities a
            """
        ).fetchall()
    finally:
        con.close()

    out = []
    for r in rows:
        out.append(
            {
                "id": r[0],
                "name": (r[1] or "").strip(),
                "domain": (r[2] or "").strip(),
                "status": (r[3] or "").strip(),
                "one_line": (r[4] or "").strip(),
                "last_evidence": (r[5] or "").strip(),
                "ev": int(r[6] or 0),
                "flags": int(r[7] or 0),
            }
        )
    return out


_CLOSERS = "'\"”’)]»"       # trailing quote/paren chars that may sit after a terminator
_TERMINATORS = ".!?…"        # sentence-ending marks


def mark_if_truncated(one_line):
    """The librarian stores each one_line clipped to a fixed char cap, so a clip lands
    mid-sentence with no terminator (e.g. ends on '(' or a bare word). Append '…' to those
    so the reader sees the summary continues. Sentences that already terminate cleanly —
    optionally inside a closing quote/paren, e.g. `... 'waste of time.'` — are left as-is."""
    core = one_line.rstrip()
    if not core:
        return one_line
    tail = core.rstrip(_CLOSERS).rstrip()
    if tail and tail[-1] in _TERMINATORS:
        return core
    return core + "…"


def render_entry(a):
    """Render one authority line."""
    if a["status"] in COMPRESSED_STATUSES:
        return "- ~~{}~~ — {}".format(a["name"], a["status"].lower())
    last = a["last_evidence"] if a["last_evidence"] else "—"
    meta = "{} · ev {} · last {}".format(a["status"], a["ev"], last)
    if a["flags"] > 0:
        meta += " · flags {}".format(a["flags"])
    return "- {} — {} [{}]".format(a["name"], mark_if_truncated(a["one_line"]), meta)


def order_entries(entries):
    """Newest-last_evidence first; compressed/undated fall to the bottom."""
    live = [e for e in entries if e["status"] not in COMPRESSED_STATUSES]
    comp = [e for e in entries if e["status"] in COMPRESSED_STATUSES]
    live.sort(key=lambda a: (a["last_evidence"] or "", a["name"].lower()), reverse=True)
    comp.sort(key=lambda a: (a["last_evidence"] or "", a["name"].lower()), reverse=True)
    return live + comp


def build_changed_recently(authorities):
    """Lines for the '## Changed recently' section: up to RECENT_MAX authorities whose
    last_evidence is within the past RECENT_DAYS days, newest first, one compressed line
    each. Returns [] when none qualify (caller then omits the section)."""
    cutoff = (datetime.now(timezone.utc).date() - timedelta(days=RECENT_DAYS)).isoformat()
    recent = [a for a in authorities if a["last_evidence"] and a["last_evidence"] >= cutoff]
    recent.sort(key=lambda a: (a["last_evidence"], a["name"].lower()), reverse=True)
    return [
        "- {} ({}) — last {}".format(a["name"], a["domain"] or "—", a["last_evidence"])
        for a in recent[:RECENT_MAX]
    ]


def build_body(domains, keep, collapsed, changed=None):
    """Assemble the body (sections + footer) given per-domain visibility state.

    keep[d]      -> number of leading (newest) entries to show for domain d
    collapsed    -> set of domains rendered as the `(<N> entries — query /library)` line
    changed      -> pre-rendered '## Changed recently' lines (omitted when empty)
    """
    parts = []
    if changed:
        parts.append("## Changed recently")
        parts.extend(changed)
        parts.append("")  # blank line before the domain sections
    for d in domains:
        entries = domains[d]
        if not entries:
            continue
        parts.append("## {}".format(d))
        total = len(entries)
        if d in collapsed:
            parts.append("({} entries — query /library)".format(total))
        else:
            k = keep[d]
            for e in entries[:k]:
                parts.append(render_entry(e))
            hidden = total - k
            if hidden > 0:
                parts.append("(+{} older — query /library)".format(hidden))
        parts.append("")  # blank line between sections
    parts.append(FOOTER)
    return "\n".join(parts)


def enforce_cap(domains, changed=None):
    """Return a body string under CAP, trimming lowest-priority domains first.

    Trims entries oldest-last_evidence-first within a domain; empties collapse to
    the `(<N> entries — query /library)` placeholder. The '## Changed recently'
    header section (`changed`) is fixed and counts toward the cap but is not trimmed.
    Returns the body regardless (best effort if even a fully-collapsed glossary
    exceeds the cap)."""
    ordered = [d for d in DOMAIN_ORDER if domains.get(d)]
    # Include any unexpected domains (defensive) after the known ones, alpha.
    extras = sorted(d for d in domains if d not in DOMAIN_ORDER and domains.get(d))
    ordered = ordered + extras

    keep = {d: len(domains[d]) for d in ordered}
    collapsed = set()

    def current():
        return build_body({d: domains[d] for d in ordered}, keep, collapsed, changed)

    body = current()
    if doc_len(body) <= CAP:
        return body

    # Lowest priority first == reverse of the display order.
    for d in reversed(ordered):
        while keep[d] > 0:
            keep[d] -= 1
            if keep[d] == 0:
                collapsed.add(d)
            body = current()
            if doc_len(body) <= CAP:
                return body
    return current()


def doc_len(body):
    """Exact character length of the final document for a given body.

    The final document is `header + "\\n" + body + "\\n"`. The header embeds the
    12-hex body hash (fixed width) and a fixed-width UTC timestamp, so its length
    is deterministic given the body; this lets us enforce the HARD cap against the
    true total, not an approximation."""
    return len(make_header(body_hash(body))) + 1 + len(body) + 1


def body_hash(body):
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:12]


def make_header(h):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return (
        "# Decision-State Glossary · v{} · generated {} · "
        "SOURCE: ~/.assay/librarian.db (read-only for you)".format(h, ts)
    )


def atomic_write(path, text):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".swp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass
        raise


def main():
    authorities = load_authorities()

    # Bucket by domain.
    domains = {}
    for a in authorities:
        domains.setdefault(a["domain"], []).append(a)
    for d in domains:
        domains[d] = order_entries(domains[d])

    changed = build_changed_recently(authorities)
    body = enforce_cap(domains, changed)
    h = body_hash(body)
    header = make_header(h)
    doc = header + "\n" + body + "\n"

    if len(doc) > CAP:
        log("WARNING glossary {} chars exceeds cap {} after full trim".format(len(doc), CAP))

    # defang: any literal decision-tag text (e.g. inside an authority one_line) must not
    # be drain-parseable once this glossary lands in session transcripts.
    doc = doc.replace("<assay-decision", "\u2039assay-decision").replace("</assay-decision", "\u2039/assay-decision")
    atomic_write(OUT_MD, doc)
    atomic_write(OUT_VERSION, h + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        log("ERROR " + traceback.format_exc().replace("\n", " | "))
        # Never propagate failure to a hook.
        sys.exit(0)
