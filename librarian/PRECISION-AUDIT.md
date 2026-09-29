# Filing precision audit — 2026-07-24

## Why this exists

The system's headline number was **"6,599 of 6,599 observations dispositioned, 100.00%."**
That number is real, but it measures the wrong thing. It proves every item got a
*bookkeeping row* — it says nothing about whether the item was filed onto the **right**
authority. A system that filed everything onto one authority would also score 100%.

This audit measures the thing that actually matters: **is the filing correct?**

## Method

- **Population:** 9,380 evidence rows filed in the post-fix era (`obs_date >= 2026-07-08`),
  restricted to claude-mem observations (numeric `obs_key`).
- **Sample:** 120 rows, uniform random, `random.seed(42)` so the draw is reproducible.
- **Judges:** four independent graders, 30 rows each, each shown the observation
  (title/subtitle/type), the authority it was filed to, **and the full menu of 85
  authorities it could have been filed to instead.**
- **Instruction:** grade harshly, do not give benefit of the doubt, and enforce the
  system's own two rules — *prefer the narrower authority* and *never attach run-log
  noise to a strategy or decision authority*.

Grades:

| Grade | Meaning |
|---|---|
| **correct** | best or clearly-tied-best fit in the menu |
| **acceptable** | defensible, but a narrower/more apt authority existed |
| **wrong** | does not belong on that authority at all |

## Result

| | Count | Share |
|---|---:|---:|
| correct | 100 | **83.3%** |
| acceptable | 6 | 5.0% |
| **wrong** | **14** | **11.7%** |

Per judge: 24/1/5 · 26/1/3 · 24/1/5 · 26/3/1. The spread is tight, so the number is
not an artifact of one harsh grader.

**Read it plainly: roughly one filing in nine is on the wrong authority.** Combined with
the coverage number, the honest claim is *"nothing is lost, and ~88% of what is kept is
filed defensibly"* — not "100% accurate."

## The four failure modes, in order of how often they showed up

**1. Magnet authorities.** Authority 3 (*Librarian architecture*) and Authority 44
(*Notion MCP & API*) absorb a disproportionate share of anything that mentions
"evidence count" or "Notion page." In one 30-row batch, 17 rows landed on Authority 3.
Much of that is legitimate — Authority 3 genuinely is the system describing itself — but
judges flagged it functioning as a default bucket for any cross-authority observation.

**2. Inconsistent routing of identical content.** Structurally identical observations
land on different authorities depending on incidental wording. Judges caught matched
pairs: `18193` (correct) versus `12637` (wrong) are the same "Authority N Notion page
synchronized, evidence count updated" shape, filed to two different places. There is no
stable rule for where routine cross-authority sync noise belongs.

**3. Broad-authority drift on outreach operations.** Send tallies, recipient rosters,
and contact segmentation repeatedly land on the broad *a broad client-project GTM playbook*
playbook instead of the narrower outreach-infrastructure authorities. This is a direct
violation of the system's own "prefer the narrower authority" rule, and it is the single
most repeatable category error (3 clear cases plus 1 borderline in one 30-row batch).

**4. Keyword capture overriding topical fit.** At least one misfile (`13758`) was routed
to *claude-mem Search & Retrieval* purely because the text contained the string
"claude-mem watermark," when the subject was batch dirty-flag bookkeeping. One row
(`15945`) was a complete non-sequitur, suggesting an occasional fallback-bucket failure
rather than a near-miss.

## Suspected cause

`bin/prefilter.py` auto-files when **exactly one** authority matches on either a
whole-word alias hit or **two or more** distinctive name tokens. Two tokens is a loose
bar when 85 authorities share vocabulary like "Notion," "page," "evidence," and
"pipeline." The strict "exactly one candidate" guard prevents *ambiguous* filings but
does nothing when the loose matcher produces exactly one *wrong* candidate.

Note this audit does not separate prefilter-filed rows from librarian-filed rows —
retrospectively they are indistinguishable in the journal. That is itself a gap: the
`evidence` table should record which tier filed each row so precision can be attributed.

## What this does not measure

- **Recall of supersession and contradiction detection.** Whether the system *missed*
  supersessions is unmeasured and is probably the more valuable next audit.
- **Pre-fix filings.** The sample is post-2026-07-08 only. Earlier rows came through a
  lossy path and their quality is unknown.
- **Judge calibration.** The graders are LLMs applying a rubric, not the system's owner.
  They agree closely with each other, which is evidence of consistency, not of ground truth.

## Reproducing

```bash
python3 tools/precision-sample.py --seed 42 --n 120 --since 2026-07-08
```

The sample draw is deterministic; the grading step is not.
