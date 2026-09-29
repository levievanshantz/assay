# Operating it: the day-to-day loop

## What you do daily

Nothing. Work normally in Claude Code. The system is silence-by-default: routine decisions are captured ambiently by claude-mem, filed automatically by the sweep, and surfaced in the glossary. You only step in when it raises a flag — and it will tell you when it does.

## The glossary

Every new session opens with a **Decision-State Glossary** block. That is the journal talking to your Claude instance: a compiled snapshot, capped at 7,500 characters, of what is still true.

How to read it:

- **Changed recently** — authorities with new evidence in the past week, newest first. Scan this to see what moved.
- **Domain sections** — one-line authorities grouped by domain (Product, Strategy & GTM, Infra & Tooling, Client Projects, Personal).
- **Each line** reads `Name — one-line summary [status · ev N · last DATE · flags N]`: the current status, how many observations back it, when it last saw evidence, and how many open flags it carries.
- **Struck-through entries** (`~~like this~~`) are superseded or retracted — kept for continuity, no longer true.

## Flags — where your judgment is required

The librarian is a scribe, not a judge. It never resolves a contradiction or a supersession on its own — a wrongly asserted supersession is invisible data loss, so when it is unsure it does less and raises a flag, then waits for you.

See open flags:

```bash
sqlite3 ~/.assay/librarian.db "SELECT id, class, text FROM flags WHERE status='open' ORDER BY id DESC LIMIT 20;"
```

Rule on one:

```bash
bin/rule.sh "flag #12: confirmed — the API pipeline supersedes the browser approach"
```

The body must start with `flag #<N>:`. Your ruling lands in the drain. The next sweep verifies the flag still exists and is open, checks that your verdict actually addresses that flag's subject, closes it, and writes a supersession edge **only** if the verdict explicitly confirms one. A hedged verdict closes the flag but writes no edge.

## Teaching your Claude instance the loop

Paste this into your project's `CLAUDE.md` so your Claude instance knows how to use the system:

```
The Decision-State Glossary block at session start is your decision-state context —
treat it as what we already know is true. When the user rules on a flag, run
bin/rule.sh 'flag #N: <verdict>'. When the user explicitly asks to record a decision,
run bin/deposit.sh '<one-sentence decision>'. Never edit ~/.assay/librarian.db
directly — the librarian is the single writer to it.
```

## Querying your memory

```bash
# Top authorities by evidence
sqlite3 ~/.assay/librarian.db "SELECT name, status, (SELECT count(*) FROM evidence e WHERE e.authority_id=a.id) ev FROM authorities a ORDER BY ev DESC LIMIT 15;"

# Evidence for one authority
sqlite3 ~/.assay/librarian.db "SELECT obs_key, obs_date, obs_type FROM evidence WHERE authority_id=42 ORDER BY obs_date DESC;"

# Open flags by class
sqlite3 ~/.assay/librarian.db "SELECT class, count(*) FROM flags WHERE status='open' GROUP BY class;"

# Supersession edges
sqlite3 ~/.assay/librarian.db "SELECT src, dst, note FROM edges WHERE type='supersedes';"
```

## What to expect, honestly

- **Precision is 83.3%** (see PRECISION-AUDIT.md). Roughly one filing in nine lands on the wrong authority — nothing is lost (coverage is separately audited at 100.00%), but expect to occasionally find evidence filed under the wrong topic and to correct it with a ruling.
- **Flags accumulate if you never rule.** That is your queue, not the system's backlog — the librarian will not clear it for you, because clearing it is the judgment call it deliberately leaves to you.
- **The first week is thin.** An authority needs at least three related observations before it forms, so early on the glossary shows little. It fills in as you work.
