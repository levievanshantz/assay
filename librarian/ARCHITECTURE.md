# Librarian — Architecture

This document exists to take an engineer who has never heard of this system from zero to
deep understanding in one sitting. It is not the operator manual (`README.md`) and it is not
the tight summary on the Notion architecture page. Those tell you *what to run* and *what the
pieces are called*. This one tells you *why the thing is shaped the way it is* — abstraction
first, mechanics second — so that when you touch it, you change it for the right reasons.

Read it skeptically. Every rule below is paired with the reason it exists, and several of the
reasons are scars.

> **Dated 2026-07-03 — five days before the biggest scar.** This document predates the
> non-atomic-watermark data-loss bug and the coverage gate built in response to it. The
> architecture described here is accurate, but the commit path it describes is the one
> that failed. Read `POSTMORTEM.md` alongside this: it is the missing chapter, and the
> two documents disagreeing about the commit step is the whole lesson.

---

## 1. The problem, in human terms

A person working with AI assistants makes decisions faster than their own memory can keep up
with. Over a few months you accumulate hundreds of small rulings — "we're using FTS5, not
vectors, in the query path"; "exports run nightly, not on every save"; "the POC is
done, the real thing shipped" — and each one quietly changes what is *currently true* about
the project. No single decision is hard to remember. The aggregate is impossible.

The obvious fix is to record everything, and that already exists. An ambient memory tool
(`claude-mem`) sits under every session and writes down observations continuously — nearly
9,200 of them here, of every flavor: discoveries, changes, bugfixes, features. A second
capture path (the "decision drain") scrapes decision-shaped statements out of session
transcripts into their own store — close to 5,000 of those.

So the problem is **not forgetting**. Everything is written down. The problem is that a
perfect recording device has no idea what is *still true*. It remembers that on June 1 you
decided X, and it remembers with equal confidence that on June 20 you replaced X with Y, and
when you ask "what are we doing about X," it will hand you both with a straight face. The
failure mode of ambient memory is not amnesia. It is **confident staleness** — surfacing a
dead decision as though it were live, because nothing in the recording knows the decision
died.

That asymmetry is the whole ballgame. Forgetting is loud: you notice a gap and go looking.
Staleness is silent: you act on an answer that was true once, and nothing warns you it
expired. The system in this directory exists to convert a pile of recordings into an answer
to one question a recording device can never answer on its own: *given everything that has
been said, what is the current state?*

---

## 2. The idea

The design is a single **scribe** — the "librarian" — that does one narrow, disciplined job:
it files ambient memory into **authority records**, one concept per record, and it keeps each
record's *current state* current.

Four commitments define it:

- **One concept, one record.** Everything the system knows about "the outreach campaign" or
  "the librarian architecture" lives in exactly one authority. New evidence attaches to the
  concept it is about; it does not spawn a near-duplicate. This is what makes "current state"
  a well-defined thing to ask for.

- **Supersession is recorded explicitly, never inferred silently.** When a new decision
  replaces an old one, that replacement is a fact to be written down with a citation — *if it
  was stated*. If it merely *looks* like a replacement, the scribe does not decide. It raises
  a flag and moves on.

- **It flags what it cannot decide.** Contradictions, possible supersessions, open loops,
  thin evidence — these are not resolved by the scribe. They become entries in a human work
  queue.

- **It serves current state two ways.** A compiled **glossary** — a small, machine-readable
  digest — is injected into every AI session so that assistants start already knowing the
  current state. A human-readable **Notion library** gives a person the full write-up per
  concept, with timeline and citations.

The single most important stance is this: **the librarian is a scribe, not a judge.** It
ascertains and records what was decided or observed; it never adjudicates which competing
claim *ought* to win. This sounds like timidity. It is not — it is the direct consequence of
an error-cost asymmetry. If the scribe wrongly *fails* to record a supersession, the old and
new claims both sit in the record, a human sees the tension, and someone resolves it: the
data is all still there. If the scribe wrongly *asserts* a supersession — marks a live
decision "superseded" when it wasn't — that decision silently vanishes from every future
answer, and nobody goes looking for a thing they believe was retired. **False supersession is
invisible data loss.** Because the two errors are not symmetric, the thresholds are not
symmetric: when unsure, the scribe does less and leaves a flag. Every conservative-looking
rule downstream is a restatement of this one asymmetry.

---

## 3. The topology

Three tiers, and the direction of flow is the point.

```
   SOURCES (read-only)                JOURNAL (the only writer)         PROJECTIONS (read-only)
   ┌────────────────────┐            ┌──────────────────────┐          ┌────────────────────┐
   │ claude-mem          │  ───────▶ │  ~/.assay/librarian.db │  ──────▶ │ glossary.md (machines)│
   │  observations       │            │  authorities, evidence │          │  → injected into every│
   │ assay decision drain │  ───────▶ │  flags, edges, aliases │          │    session            │
   │  decisions.db        │            │  watermarks, writer_lock│  ──────▶ │ Notion library (humans)│
   └────────────────────┘            └──────────────────────┘          └────────────────────┘
```

**Sources are foreign and strictly read-only.** `claude-mem` and the decision drain are owned
by other systems. The librarian never writes them. It only advances its own bookmarks
(watermarks) into them. The reason is containment: the sources have their own lifecycles,
their own bugs, and their own upgrade cadence, and if the librarian could write back, a bad
librarian run could corrupt the ground truth it depends on. By making the source relationship
one-directional, a librarian failure can never be worse than "the journal is stale" — never
"the inputs are wrong."

**The journal is the only writable center — the single source of truth.** Every piece of
curation state — which authorities exist, what evidence supports them, which flags are open,
which supersession edges have been asserted, how far each watermark has advanced — lives here
and *only* here. There is exactly one writer to it (the sweep), and everything else opens it
read-only. This is not a performance decision; it is a correctness decision. A single-writer
invariant is the cheapest possible concurrency model, and for a system whose worst outcome is
silent data loss, "impossible to have two writers race" is worth more than any throughput a
multi-writer design would buy.

**Notion is a viewport, never a source.** The Notion library is a *rendering* of the journal
for human eyes. If Notion and the journal ever disagree, the journal wins and Notion is
wrong-and-will-be-corrected. This matters because Notion is editable by hand and by other
tools, and if it were ever treated as authoritative, a stray human edit or an API glitch
could rewrite reality. Making it projection-only means the worst a Notion mishap can do is
make a page look wrong until the next render fixes it.

**The librarian is stateless per run.** Each sweep launches a *fresh* headless model instance
with no memory of any prior run. Its only state is the journal it reads and writes. This is
deliberate and it is subtle: a long-lived librarian that accumulated its own running
interpretation of the project would drift — it would start compacting, summarizing, and
quietly re-deciding based on its own prior summaries rather than the evidence. (The proof of
concept for this system explicitly chose a stateless instance over a stateful one "to avoid
bias drift.") By making every run start from zero and derive everything from the journal, the
system's memory lives in an inspectable database, not in an opaque model context that no one
can audit.

---

## 4. The loop, mechanically

One "tick" of the system is a sweep. Here is the full path from a session ending to the
glossary updating, and — importantly — where each step refuses to trust the step before it.

1. **Tick (the Stop hook).** When any Claude session ends, a Stop hook (`bin/on-stop.sh`)
   does two tiny things in under 300ms: it `touch`es `~/.assay/librarian.tick`, and it
   appends one line of settle telemetry (the current max observation id and the count of
   pending memory messages). It writes nothing else and always exits 0. It is deliberately
   near-trivial because a Stop hook runs on the user's critical path — anything slow or
   fragile here degrades every session.

2. **launchd (WatchPaths + heartbeat).** The sweep is scheduled two ways at once
   (`com.librarian.sweep.plist`): a `WatchPaths` trigger on the tick file, so a
   sweep fires within seconds of a session ending, and a `StartInterval` of 1200s (20 min) as
   a heartbeat so nothing is missed if the event trigger is flaky. A `ThrottleInterval` of
   120s prevents tick-storms from launching sweeps back-to-back. Event-plus-heartbeat is
   belt-and-suspenders on purpose: the event path gives freshness, the heartbeat gives
   guaranteed eventual progress.

3. **The settle gate.** This is the most important non-obvious step. `claude-mem` files its
   observations *asynchronously* — when a session ends, the memory tool has usually not yet
   finished writing that session's observations to disk. If the sweep ran immediately it would
   ingest a half-written session, file fragments, and then have to churn the same authority
   again on the next cycle. So the sweep refuses to proceed unless memory has **settled**:
   `pending_messages == 0` *and* the newest observation is at least `SETTLE_BUFFER` (600s)
   old. If either condition fails, the sweep logs "not settled" and exits **without advancing
   its marker**, so the next cycle retries. The gate trades latency for the guarantee that the
   librarian only ever sees complete sessions.

4. **Batch export with watermarks.** Past the gate, the sweep reads everything new: claude-mem
   observations with `id` greater than the claude-mem watermark, and drain decisions with
   `created_at` greater than the drain watermark. Observations are capped at 400 per run
   (oldest first); anything past the cap is explicitly deferred to the next cycle and logged.
   The two watermarks are the system's precise definition of "new" — see §5.

5. **The deterministic prefilter (`bin/prefilter.py`).** Before the batch reaches the
   expensive model, a deterministic pass auto-files the *unambiguous* run-log observations.
   The criteria are strict and all must hold: the observation is **not** a decision; its
   title and subtitle contain **no** supersession-trigger language; and it resolves to
   **exactly one** authority (via an exact alias substring hit, or ≥2 distinctive name tokens)
   whose kind is `system` or `project`. When all four gates pass, the observation's evidence is
   filed directly and the authority's `last_evidence` date is bumped monotonically — nothing
   else. Crucially, **the prefilter never touches decisions, never creates authorities or
   aliases, never asserts supersession, and never marks anything dirty** (run-log noise does
   not warrant a Notion re-render). It exists to keep the firehose of routine telemetry off
   the model's desk so the model spends its judgment only where judgment is required. If the
   prefilter empties the batch and there is no drain to process, the sweep advances the
   watermarks itself, recompiles the glossary, and skips the model entirely — a zero-cost
   cycle. On *any* error it files nothing and hands the whole batch to the model; it is
   engineered to fail safe, never to fail wrong.

6. **The headless LLM librarian.** Whatever the prefilter left goes to a headless `claude -p`
   run driven by a **locked prompt** (`prompts/librarian.md`). Two details are load-bearing.
   First, it runs with `--settings '{"enabledPlugins":{},"hooks":{}}'` — memory and hooks are
   disabled *for the librarian's own session*. Without this, `claude-mem` would observe the
   librarian working, generate observations *about the librarian*, and the next sweep would
   ingest them: a perpetual self-documentation loop. The system must be invisible to the memory
   it curates. Second, the model's whole contract — how it files, when it flags, when (and only
   when) it may assert a supersession — is the prompt, discussed in §6.

7. **Render, then commit.** The model updates the Notion pages of any authority it marked
   dirty, then advances the watermarks to the batch's maxima. The sweep does **not** take the
   model's word for it. After the run it re-reads the watermarks from the journal and verifies
   they actually advanced; if the model exited 0 but the watermarks did not move, the sweep
   treats the run as **failed**, saves the batch to `logs/last-failed-batch.json`, and leaves
   its marker unadvanced so the next cycle retries. "The model said it committed" and "the
   journal shows it committed" are different facts, and only the second one is trusted. This is
   the same skeptical posture as the settle gate, applied to the librarian's own output.

The through-line of the loop: **every stage distrusts the one before it and can be retried
without harm.** Watermarks only advance on verified progress, so a crash anywhere leaves the
system exactly where it was, and the next tick picks up cleanly.

---

## 5. The data model

Eight tables in `~/.assay/librarian.db`. Each exists for a reason, and the invariants are as
important as the columns.

- **`authorities`** — one row per concept: `name` (unique), `domain`, `kind` (`decision` ·
  `system` · `project` · `playbook` · `entity`), `status` (`Active` · `Superseded` ·
  `Retracted` · `Aged` · `Mixed`), a `one_line` current-state summary, a `notion_page_id`, a
  `last_evidence` date, and a `dirty` flag. This is the glossary's backbone. There are 78 of
  them today. The `one_line` is what makes the concept queryable in a sentence; `status` is
  what makes staleness *visible* rather than silent.

- **`evidence`** — the append-only support timeline. Each row keys an observation or decision
  (`obs_key`) to an authority, with the primary key `(obs_key, authority_id)` making every
  filing **idempotent**: re-filing the same evidence is a no-op. There are ~9,000 rows. The
  evidence key format is exact and non-negotiable — a claude-mem observation is keyed by its
  bare integer id as text (`'9116'`), *not* the citation form `cm-obs #9116`, which is for page
  prose only. This distinction has bitten before; the journal's join integrity depends on it.

- **`edges`** — the supersession graph: `(src, dst, type, note)`, where `src` supersedes
  `dst`. This is the most consequential table and the smallest: **there is exactly one edge in
  the entire journal.** That number is not a bug — it is the scribe-not-judge stance made
  visible. Across nearly 5,000 drain decisions, the system has asserted supersession *once*,
  and that once went through a human ruling (see §10). Every other apparent supersession is
  sitting in the flag queue, unasserted, waiting for a human.

- **`flags`** — the question queue: `(authority_id, class, text, status, closed_by)`. Classes
  are a controlled vocabulary (`possible-supersession` · `contradiction` · `open-loop` ·
  `deadline` · `thin-evidence` · `data-caveat`). There are **217 open flags and only 3 ever
  closed.** Read that ratio as intended: the scribe is voracious about surfacing uncertainty
  and never resolves it itself. The flags are not a backlog to feel bad about; they are the
  system doing its job — converting silent staleness into an explicit, human-addressable list.

- **`aliases`** — synonyms mapping surface terms to authorities (141 of them). These earn
  their keep in the prefilter: an exact alias hit is the fast, safe path into deterministic
  filing, which keeps routine observations off the model's desk.

- **`watermarks`** — two rows, `claude-mem` and `assay-drain`, each holding the last key
  consumed. This table *is* the system's definition of "new": everything past the watermark is
  unprocessed, everything at-or-before it is done. Watermarks advance only on verified commit,
  which is what makes the whole loop crash-safe and idempotent.

- **`writer_lock`** — a single-row lock recording the pid of the sweep currently writing.
  Combined with the launchd single-entry design, this enforces the one-writer invariant
  structurally rather than by convention.

Note what the two source stores contribute and how they differ. `claude-mem` observations are
typed and rich (discoveries, changes, bugfixes) and arrive by ascending integer id — a clean
monotone stream. The drain's `decisions.db` is messier: nearly 5,000 rows, **100% still in
`tentative` status, with supersession never once resolved** (its `supersedes_resolved_id` is
perpetually null — see §8). The drain is the problem statement running live: a firehose that
records decisions but has no working notion of which are current. The librarian is the layer
that gives that firehose a current state.

---

## 6. The prompt as architecture

In most systems the prompt is a detail. Here it is a load-bearing component, versioned and
locked (`prompts/librarian.md`), because it encodes the entire epistemology the scribe is
required to obey. Treat it like source code, because it is.

- **Bias to inaction.** The opening instruction is explicit: "If you are unsure whether a
  change is warranted, do less and leave a flag." This is the error-cost asymmetry of §2
  compiled into the model's default behavior. Every other rule is downstream of it.

- **A typed batch contract.** The model is handed a single JSON batch with a fixed shape:
  watermarks, watermark *targets*, observations, drain items, a deferred count, and (when
  present) a `prefiled` summary. Prefiled items are marked "context, not work" — the model is
  told a deterministic pass already filed them and must not re-resolve them. A rigid input
  contract is what lets a stateless model behave consistently run over run.

- **Explicit-only supersession.** The model may record a supersession as a fact *only* when
  the evidence contains explicit replacement language ("replaces," "we are dropping X for Y,"
  "reverted," "no longer"). Anything that merely reads like a replacement is filed as a
  `possible-supersession` flag, never an edge. This is the single rule that most directly
  prevents invisible data loss.

- **Ruling escalation — the one authorized path from implied to asserted.** There is exactly
  one way an implied supersession becomes an asserted one: a human *ruling* that explicitly
  confirms it (§7). The model processes rulings before ordinary filing, and only a ruling
  whose verdict explicitly confirms the supersession may cause the model to write an edge and
  flip a status. A hedged verdict ("maybe," "leaning toward") closes the flag but writes no
  edge. This is the sole sanctioned bridge across the scribe/judge line, and it requires a
  human on the other side.

- **Quote discipline.** Anything inside quotation marks must be a single contiguous verbatim
  span from one source — never stitched, trimmed-in-the-middle, or paraphrased. If the model
  needs to combine or compress, it must write plain prose labeled "(synthesized from …)." The
  reason is that a fabricated-looking quote in an authority page destroys trust in every quote,
  and the whole value of the library is that its citations can be relied on.

- **Controlled vocabularies.** `domain`, `kind`, `status`, and `flags.class` are closed sets
  that must match the Notion select options exactly. Free-text categories would drift into
  synonyms and the "one concept, one record" property would erode. The vocabularies are the
  guardrails that keep the journal and its projection in lockstep.

- **Anti-over-filing.** Run-log observations attach only to the specific *system* authority
  they describe — never to a *strategy* or *decision* authority, which record human judgments,
  not operations. When a choice exists between a broad authority and a narrow one, the narrow
  one wins. Breadth is where over-filing hides, and an authority that accretes unrelated
  evidence stops meaning one thing.

---

## 7. The human loop

The flags are only useful if a human can act on them cheaply, from anywhere, without opening
the database. That is what the ruling grammar provides.

A **flag** is the scribe saying "I found tension I won't resolve." A **ruling** is a human
saying "here is the resolution." A ruling is deposited the same way any decision is — as a
tagged statement in an ordinary session — addressed to a flag by number. The next sweep
processes rulings *before* ordinary filing: it parses the flag id and the verdict, verifies
the flag is real and still open, checks that the verdict actually addresses that flag's
subject, then closes it (`status='closed'`, `closed_by='D-<hex>'`) and re-renders the
authority. Only for a ruling — and only when the verdict *explicitly* confirms a supersession
— may the sweep also assert the edge and flip the superseded authority's status.

Because rulings ride the same decision-tag mechanism as everything else, this document has to
be careful about how it *shows* one. The decision drain scans session transcripts — and any
document quoted into a transcript — for decision tags and captures whatever it finds. If this
file contained a real, parseable tag pair, then the moment this file was pasted into a
session, the drain would capture the example as a spurious decision and pollute the very store
the librarian curates. This is not hypothetical: the drain has already ingested the source
code of the glossary compiler and the librarian prompt, purely because those files contain
tag-shaped text. So every tag below uses the lookalike brackets ‹ and › (U+2039 / U+203A)
instead of real angle brackets. **When you actually emit a ruling, swap ‹ › for real `<` `>`.
Never write a real pair into a document that might be quoted.**

A ruling that closes a flag and confirms a supersession looks like this:

```
‹assay-decision layer="ruling"›flag #187: confirmed — the duplicate "export-v2" labels
are a display bug, not real data; safe to ignore‹/assay-decision›
```

(A drain row also counts as a ruling when its body simply begins `flag #N:` even without the
`layer` attribute — the regex is the fallback for when the attribute is missing.)

Two consumer surfaces close the loop for people. The **Flag Queue** (a Notion database)
renders the open flags as a work list — where a human decides what to rule on. The
**`/library`** slash command searches the journal read-only from any session: name, alias, or
one-line match, with status, open flags, supersession edges, and the Notion link, drillable
into the underlying evidence. Both are read-only consumers; neither writes the journal.
Writing is always the sweep's job alone.

---

## 8. Hard-won invariants

Each of these is a rule the system will not bend, and each is here because breaking it once
cost something real.

- **Never full-replace a Notion page that parents live content.** The render step prefers
  targeted section edits and uses full content replacement only on leaf pages whose structure
  must change. A page that has child content is never blown away and rebuilt — an early
  full-replace sent live content to the trash. Rebuilding from scratch feels cleaner; it is
  how you lose the things the page was holding.

- **The librarian must be invisible to the memory it curates.** The headless run disables
  plugins and hooks so `claude-mem` does not observe the librarian. The one time this was not
  true, every run generated observations about itself, which the next run ingested — a
  self-documentation loop that inflates the corpus with the system's own reflection. A curator
  that ends up curating itself has stopped curating the thing that matters.

- **Attributes must parse from *escaped* transcript JSONL.** The drain reads decision tags out
  of the session transcript, where the tag text is JSON-escaped. A parser written against the
  *raw* tag form silently failed to extract the `supersedes` attribute for roughly three
  months — which is precisely why `decisions.db` holds nearly 5,000 decisions and has resolved
  supersession *zero* times. The bug was silent because a null supersession looks exactly like
  "nothing was superseded." This incident is the reason the librarian treats supersession as an
  explicit, human-escalated act rather than trusting any upstream attribute: the one automated
  supersession path in the stack was quietly dead for a quarter and nobody noticed, because its
  failure was indistinguishable from success.

- **Subject-match before applying a ruling.** Before closing a flag, the sweep verifies the
  verdict plausibly addresses *that flag's own subject*. A ruling about adapters must not close
  a flag about outreach. This was codified after the librarian caught a live mismatch: a stray
  example tag looked exactly like a real ruling and nearly closed an unrelated flag. Because
  tag-shaped text turns up in examples and copy-paste accidents, "it references flag #N" is not
  enough — the verdict has to be *about* flag #N.

- **Dedup at the source, not downstream.** A single decision emitted across several sessions
  used to arrive as many duplicate drain rows for the librarian to reconcile — a duplication
  ratio that ran as high as 86 to 1 in one measured case. Deduplication now happens upstream in
  the drain, so the sweep reads already-unique decisions. Reconciling duplicates downstream is
  possible but wasteful; the cheapest duplicate is the one never emitted twice.

- **Evidence sampling is forbidden; completeness lives in the journal.** When an authority
  would take on a very high-volume run-log stream (past ~150 rows in one run), the model files
  only representative items *and raises a flag* — it does not silently sample and move on, and
  it does not bulk-dump the stream either. The journal is the place where "we have all of it"
  is guaranteed; a summary that quietly drops evidence would make the journal's completeness a
  lie, and completeness is the one property everything downstream assumes.

---

## 9. Where it is deliberately incomplete

Honesty about the boundaries, so no one mistakes a deferral for an oversight.

- **Single machine, single user.** The whole system runs on one Mac, curating one person's
  work. There is no server, no multi-tenant story.

- **Capability separation is deferred, and is a hard prerequisite.** The safety model today is
  structural and singular: exactly one writer, `sweep.sh`, behind one launchd entry point,
  guarded by `writer_lock`. Per-writer capability tokens — which a second user or a second
  writer would require — are deliberately not built. Until they exist, that single entry point
  *is* the guarantee, and adding a second writer of any kind would break the invariant the
  correctness of the journal rests on.

- **Supersession detection is explicit-only, by choice.** The system asserts supersession only
  on explicit language plus human confirmation. An offline, embedding-based detector
  (cosine-similarity over decision pairs, writing *audit-only* flags, never flipping status on
  its own) is designed but not on the hot path. It stays a candidate *flag generator*, never a
  *judge*, precisely because the error-cost asymmetry forbids letting a similarity score
  silently retire a live decision.

- **Model tiering is untested at the floor.** The librarian currently runs on a mid-tier model.
  Whether a cheaper model can hold the prompt's discipline — especially the flag/assert line —
  has not been validated, so the floor is unproven.

---

## 10. A worked example — the one edge in the graph

Trace the single supersession the system has ever asserted, because it exercises every layer
at once.

Early in the build, before the live librarian existed, a **proof-of-concept pipeline** was
run: pull observations from claude-mem, have a model compose authority pages, push them to a
Notion teamspace — a dry run to validate that rich retrospective curation was even feasible
before committing to build the autonomous version. The librarian filed this as its own project
authority, *Library POC pipeline*, `Active`, one concept with its own evidence and timeline.

On July 2 the real thing shipped: the live librarian v0, filed under the system authority
*Librarian architecture*. Now the journal held two related concepts, and a question hung over
them: did shipping the real system *supersede* the POC? A human would say obviously yes. The
scribe would not. What it had in evidence was a POC that had finished and a new system that had
launched — which *reads like* a replacement but contains no explicit statement that one
retired the other. Per the explicit-only rule, the librarian did exactly what it is built to
do: it did **not** assert. It left the tension as an open flag (an `open-loop` on the POC,
recorded as flag #68) and moved on. This is the scribe-not-judge stance in its natural
habitat — the "obvious" call is precisely the one the machine is forbidden to make alone.

Then a human closed the loop with a ruling — decision `D-020f4c55` — explicitly confirming the
POC was done and superseded by the shipped system. The next sweep processed the ruling before
ordinary filing: it verified flag #68 was real and open, confirmed the verdict addressed the
POC's subject, and closed it (`closed_by='D-020f4c55'`). Because the verdict *explicitly*
confirmed a supersession, the sweep took the one authorized step across the scribe/judge line:
it wrote the edge — *Librarian architecture* `supersedes` *Library POC pipeline* — with the
note citing both the explicit observation (`cm-obs #9116`) and the ruling. It flipped *Library
POC pipeline* to `Superseded` and marked it dirty. That is the entire `edges` table: one row,
put there by a human decision, not by the scribe's inference.

The projections then did their jobs. The Notion page for the POC got its supersession callout
and its status. And in the compiled glossary — the digest injected into every session — the
POC now renders as a single struck-through line:

```
- ~~Library POC pipeline~~ — superseded
```

So the payoff: some weeks from now, a fresh session asks "should we run the POC pipeline?" The
glossary is already in its context, and it shows the POC struck through and superseded. The
assistant does not re-propose a dead approach; it does not re-litigate a decision already made.
The whole apparatus — the stateless scribe, the flag it raised because it wouldn't judge, the
human ruling that authorized the one edge, the strike-through in the digest — exists to make
that one future non-event happen: a settled decision, staying settled, without anyone having to
remember it.
