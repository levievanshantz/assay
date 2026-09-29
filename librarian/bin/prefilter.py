#!/usr/bin/env python3
"""prefilter.py — deterministic, conservative auto-filer for the librarian sweep.

Tiered filing (v1): before a batch is handed to the expensive LLM librarian, resolve the
UNAMBIGUOUS run-log observations onto a single, clearly identified system/project authority
and file their evidence directly in the journal. Anything the least bit uncertain is left in
the batch for the LLM. This layer only ever ADDS evidence and bumps `last_evidence`
MONOTONICALLY; it never sets `dirty` (run-log noise does not warrant a Notion re-render),
never touches drain items, and never creates authorities or aliases.

Usage:
    python3 prefilter.py <batch-file> [--dry-run]

--dry-run computes and reports exactly what it WOULD file but writes nothing and leaves the
batch untouched (used by the sweep's LIBRARIAN_DRY_RUN path so a dry sweep has no side effects).

Stdout — ALWAYS exactly one line:
    prefiled=<N> residual_obs=<N> residual_drain=<N>[ error=<msg>]
Exit code is ALWAYS 0. On ANY error it files nothing, leaves the batch untouched, and reports
the still-unfiled counts so the sweep proceeds down its normal LLM path (the sweep additionally
treats the presence of `error=` as "prefilter did nothing").

Auto-file criteria — ALL must hold for an observation:
    a) obs type is in {'change','bugfix'}                (only these unambiguous run-log types
                                                          auto-file; everything else — every
                                                          decision, discovery, plan, etc. — goes
                                                          to the LLM)
    b) title+subtitle contain no supersession trigger    (SUPERSESSION_RE below)
    c) EXACTLY ONE authority (across ALL kinds) matches, via:
         - a case-insensitive WHOLE-WORD alias hit in title+subtitle: aliases of len>=5 match on
           regex word boundaries (\\b...\\b); shorter aliases match only as an exact whole token
           (so "ci" never matches inside "circle"), OR
         - >=2 of the authority's distinctive name tokens (len>3, minus stopwords) present
           as whole words in title+subtitle (already whole-token via WORD_RE — never substring)
    d) that single matched authority is kind 'system' or 'project'
"""

import json
import os
import re
import sqlite3
import sys

JOURNAL = os.path.join(os.path.expanduser("~"), ".assay", "librarian.db")

# Explicit replacement/reversal language. Mirrors the librarian prompt's supersession cues.
# Any hit sends the observation to the LLM rather than auto-filing (supersession is a judgment call).
SUPERSESSION_RE = re.compile(
    r"(replace[sd]?|supersede[sd]?|no longer|dropping|dropped|instead of"
    r"|switch(ed|ing)? (to|from)|revert(ed)?|abandon(ed|ing)?|deprecat)",
    re.IGNORECASE,
)

# Distinctive-token filter: keep tokens with len>3 that are not stopwords. This is a pure
# English function-word list on purpose — domain nouns (dashboard, backend, pipeline, ...) are
# left as valid tokens because many authority names are "<Brand> <generic noun>" and need the
# generic noun to reach the >=2-token threshold. False collisions are caught by the strict
# "EXACTLY ONE candidate" + "kind in (system,project)" guards, not by an aggressive stoplist.
STOPWORDS = {
    "about", "above", "after", "again", "against", "along", "already", "also", "although",
    "always", "among", "another", "around", "because", "been", "before", "being", "below",
    "between", "both", "cannot", "could", "does", "doing", "done", "down", "during", "each",
    "either", "else", "enough", "even", "ever", "every", "from", "further", "gave", "gets",
    "give", "given", "goes", "gone", "hadn", "hasn", "have", "having", "here", "hers",
    "herself", "himself", "into", "itself", "just", "keep", "kept", "later", "least", "less",
    "like", "made", "make", "many", "more", "most", "much", "must", "near", "need", "next",
    "none", "once", "only", "onto", "other", "others", "over", "overly", "past", "perhaps",
    "rather", "really", "same", "seem", "seen", "several", "should", "since", "some", "still",
    "such", "sure", "take", "taken", "than", "that", "their", "theirs", "them", "then",
    "there", "these", "they", "thing", "things", "this", "those", "though", "through", "thus",
    "together", "took", "toward", "under", "until", "upon", "used", "uses", "using", "very",
    "want", "well", "went", "were", "what", "when", "where", "whether", "which", "while",
    "whom", "whose", "will", "with", "within", "without", "would", "your", "yours", "yourself",
}

WORD_RE = re.compile(r"[a-z0-9]+")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FILEABLE_KINDS = {"system", "project"}
# Only these observation types are unambiguous enough to auto-file. Everything else (decision,
# discovery, plan, insight, ...) carries judgment the deterministic tier must not make — it goes
# to the LLM. Narrower than the old "anything non-decision" rule on purpose.
FILEABLE_TYPES = {"change", "bugfix"}
# An alias must be at least this long to match on regex word boundaries; shorter aliases match
# only as an exact whole token, so a 2-3 char alias can never latch onto a longer word.
MIN_BOUNDARY_ALIAS_LEN = 5


def stat_line(prefiled, residual_obs, residual_drain, error=None):
    line = f"prefiled={prefiled} residual_obs={residual_obs} residual_drain={residual_drain}"
    if error is not None:
        # Collapse whitespace so the whole thing stays a single, space-split-parseable line.
        line += " error=" + re.sub(r"\s+", " ", str(error)).strip()
    return line


def distinctive_tokens(name):
    return {t for t in WORD_RE.findall((name or "").lower()) if len(t) > 3 and t not in STOPWORDS}


def load_journal():
    """Read authorities (id -> name, kind, distinctive token set) and aliases (read-only)."""
    conn = sqlite3.connect(f"file:{JOURNAL}?mode=ro", uri=True)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        authorities = {}
        for aid, name, kind in conn.execute("SELECT id, name, kind FROM authorities"):
            authorities[aid] = {"name": name, "kind": kind, "tokens": distinctive_tokens(name)}
        aliases = [
            (alias, aid)
            for alias, aid in conn.execute("SELECT alias, authority_id FROM aliases")
            if alias and alias.strip() and aid in authorities
        ]
    finally:
        conn.close()
    return authorities, aliases


def candidates_for(obs, authorities, aliases):
    """Return the set of authority ids that this observation resolves to (any kind).

    Alias matching is whole-word, not substring: a raw substring hit made short/common aliases
    fire inside unrelated words (e.g. an alias "ci" matching "circle"). Long aliases (len>=5)
    match on regex word boundaries; short ones must equal a whole token exactly. The name-token
    path is already whole-token (WORD_RE tokens intersected), so it needs no change.
    """
    text = ((obs.get("title") or "") + " " + (obs.get("subtitle") or "")).lower()
    words = set(WORD_RE.findall(text))
    found = set()
    for alias, aid in aliases:
        al = alias.lower().strip()
        if not al:
            continue
        if len(al) >= MIN_BOUNDARY_ALIAS_LEN:
            if re.search(r"\b" + re.escape(al) + r"\b", text):
                found.add(aid)
        elif al in words:
            found.add(aid)
    for aid, meta in authorities.items():
        if len(meta["tokens"] & words) >= 2:
            found.add(aid)
    return found


def resolve(obs, authorities, aliases):
    """Return (obs_key, authority_id, obs_date, obs_type) if the obs should auto-file, else None."""
    obs_type = (obs.get("type") or "").strip().lower()
    if obs_type not in FILEABLE_TYPES:
        return None  # (a) only change/bugfix auto-file; every other type (incl. decision) → LLM
    text = (obs.get("title") or "") + " " + (obs.get("subtitle") or "")
    if SUPERSESSION_RE.search(text):
        return None  # (b) supersession is a judgment call
    cands = candidates_for(obs, authorities, aliases)
    if len(cands) != 1:
        return None  # (c) ambiguous or unmatched
    aid = next(iter(cands))
    if authorities[aid]["kind"] not in FILEABLE_KINDS:
        return None  # (d) never auto-file onto strategy/decision/playbook/entity authorities
    obs_date = str(obs.get("date") or "")[:10]
    if not DATE_RE.match(obs_date):
        return None  # unparseable date — do not corrupt obs_date/last_evidence
    try:
        obs_key = str(int(obs.get("id")))
    except (TypeError, ValueError):
        return None
    return (obs_key, aid, obs_date, obs_type)


def write_evidence(rows):
    """File evidence + bump last_evidence monotonically, in one transaction. Raises on failure."""
    conn = sqlite3.connect(JOURNAL, timeout=5.0)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("BEGIN IMMEDIATE")
        for obs_key, aid, obs_date, obs_type in rows:
            conn.execute(
                "INSERT OR IGNORE INTO evidence(obs_key,authority_id,obs_date,obs_type,role) "
                "VALUES(?,?,?,?, 'primary')",
                (obs_key, aid, obs_date, obs_type),
            )
            # COALESCE guards the SQLite quirk that max(NULL, x) is NULL; keeps advance monotonic.
            conn.execute(
                "UPDATE authorities SET last_evidence=max(COALESCE(last_evidence,''), ?) WHERE id=?",
                (obs_date, aid),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    dry_run = "--dry-run" in argv[1:]
    if not args:
        print(stat_line(0, 0, 0, error="no-batch-arg"))
        return 0
    batch_path = args[0]

    try:
        with open(batch_path, encoding="utf-8") as f:
            batch = json.load(f)
    except Exception as e:
        print(stat_line(0, 0, 0, error=f"batch-read:{e}"))
        return 0

    observations = batch.get("observations") or []
    drain = batch.get("drain") or []
    n_obs, n_drain = len(observations), len(drain)

    try:
        authorities, aliases = load_journal()
    except Exception as e:
        print(stat_line(0, n_obs, n_drain, error=f"journal-read:{e}"))
        return 0

    to_file = []
    residual = []
    by_authority = {}
    try:
        for obs in observations:
            row = resolve(obs, authorities, aliases)
            if row is None:
                residual.append(obs)
            else:
                to_file.append(row)
                name = authorities[row[1]]["name"]
                by_authority[name] = by_authority.get(name, 0) + 1
    except Exception as e:
        print(stat_line(0, n_obs, n_drain, error=f"resolve:{e}"))
        return 0

    prefiled = len(to_file)

    if dry_run:
        # Report what we would do; write nothing, leave the batch untouched.
        print(stat_line(prefiled, len(residual), n_drain))
        return 0

    batch["observations"] = residual
    batch["prefiled"] = {"count": prefiled, "by_authority": by_authority}

    # Serialize the residual batch to a sibling temp file FIRST; only then touch the journal;
    # only then atomically swap it in. If anything fails we file nothing new that isn't idempotent
    # and never leave a half-written batch.
    tmp_path = f"{batch_path}.prefilter.tmp.{os.getpid()}"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(batch, f, ensure_ascii=False)
    except Exception as e:
        _quiet_remove(tmp_path)
        print(stat_line(0, n_obs, n_drain, error=f"batch-serialize:{e}"))
        return 0

    try:
        if to_file:
            write_evidence(to_file)
    except Exception as e:
        _quiet_remove(tmp_path)
        print(stat_line(0, n_obs, n_drain, error=f"evidence-write:{e}"))
        return 0

    try:
        os.replace(tmp_path, batch_path)
    except Exception as e:
        # Evidence (if any) is already committed and is idempotent (INSERT OR IGNORE + monotonic
        # max); the untouched batch still holds those obs, so the LLM will re-file them harmlessly.
        _quiet_remove(tmp_path)
        print(stat_line(0, n_obs, n_drain, error=f"batch-replace:{e}"))
        return 0

    print(stat_line(prefiled, len(residual), n_drain))
    return 0


def _quiet_remove(path):
    try:
        os.remove(path)
    except OSError:
        pass


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as e:  # last-resort: never crash the sweep, never touch the batch
        print(stat_line(0, 0, 0, error=f"fatal:{e}"))
        sys.exit(0)
