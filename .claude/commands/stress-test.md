# /stress-test — Stress test a proposal against the Assay corpus

Stress test the user's proposal against organizational evidence. This is deliberate judgment mode — find weaknesses, overlaps, conflicts, and gaps.

## Arguments
$ARGUMENTS — The proposal or question to stress test

## Behavior

1. Call `retrieve_evidence` with the user's proposal as query_text, mode="guided", full_content=true, top_k=60
2. Note the total results returned and how many were below the RRF threshold (dropped off)
3. Apply the stress test evaluation to the retrieved evidence

## Evaluation Framework

Analyze the evidence through these lenses:

**Overlap Analysis** — What existing work, decisions, or initiatives already cover this ground? Cite specific evidence with Notion URLs. Severity: high/medium/low.

**Conflict Analysis** — What contradicts this proposal? What prior decisions, constraints, or findings push against it? Cite with URLs. Severity: high/medium/low.

**Assumption Weaknesses** — What does the proposal take for granted that the evidence challenges or doesn't support? Name the assumption, explain the weakness, cite the challenging evidence.

**Evidence Gaps** — What evidence is missing from the corpus that would be needed to validate this? What could go wrong if the gap isn't addressed?

**Supporting Evidence** — What backs this up? What prior work, interviews, or decisions support proceeding? Cite with URLs.

**Inductive Connections** — Surface unexpected connections across disparate sources. A customer interview mentioning a constraint that affects an architectural decision. A competitive analysis that validates an assumption from a different PRD. The system's value is in connecting things that don't look related. This is the accelerator lens — help the PM see what they wouldn't have found on their own.

**Falsification Check** — For each key assumption in the proposal, state what evidence would disprove it and whether that evidence exists in the corpus.

## Output Format

Start with:
- **Verdict:** proceed / revise / pause / insufficient
- **Confidence:** high / medium / low
- **Summary:** 2-3 sentences

Then the full analysis with all sections above. Every cited record must include its Notion URL. If a record has no URL, note "(no source link)".

**Alternatives** — What nearby options exist? Scope down, defer, experiment first, solve with process instead, do nothing. Compare against the evidence — does the corpus favor one path over another?

**What would change this verdict?** — Name the evidence that would reverse the decision. What would make you stop? What would make you accelerate? Include thresholds if the corpus has them.

**Recommended next step** — One concrete action. Not prescriptive strategy — just the single most useful thing to do next based on what the evidence shows.

End with:
- **Records retrieved:** X of Y available
- **Records below threshold (dropped):** Z
- **Corpus freshness:** last sync time from sync_status

## Follow-Up Escalation

After delivering the verdict, ask:

"Want me to go deeper? I can remove the result cap, pull everything the corpus has on this, and give you the full picture."

If the user says yes:
1. Re-run retrieve_evidence with top_k=0 (unlimited)
2. Re-apply the full evaluation framework with all results
3. Add a **Source Map** — group all evidence by source page, show which Notion pages contributed the most signal
4. Add **Evidence Timeline** — when was this evidence created? Is the signal recent or aged?
5. Deliver the expanded verdict with full citations
