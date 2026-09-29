# Tagging Guide

The 5-minute version of "what makes a good `<assay-decision>` tag."

## The principle

Tag **commits**, not conversations. A commit is a moment where:
1. You decided something concrete
2. Future-you would otherwise need to re-derive it
3. The decision has an evidence trail (you can cite the reasoning)

If any of those three is missing, don't tag.

## The shape

```
<assay-decision
  kind="decision"                  required: "decision" or "conflict"
  confidence="0.0..1.0"            optional: how sure you are at decision time
  supersedes="abc12345"            optional: 8-char prefix of prior decision id
  layer="pricing"                  optional: freeform tag for grouping
>
Decision body text. Multi-line OK. Markdown OK.
Make this a complete statement future-you understands without context.
</assay-decision>
```

## 5 good examples

### 1. Clear product call
```
<assay-decision kind="decision" confidence="0.8" layer="storage">
Retain exported files for 30 days, then delete them; audit logs keep only the file hash.
</assay-decision>
```
✓ Concrete (a number, a rule, what is kept)
✓ Future-you understands without re-reading the chat

### 2. Architectural call
```
<assay-decision kind="decision" confidence="0.9" layer="architecture">
Use claude-mem as the memory substrate (not Mem0 or QMD). Reason: claude-mem
ships hooks-driven capture natively, owns the Stop event we depend on, and
keeps the local-first contract (no API key). QMD swap deferred to v3.
</assay-decision>
```
✓ Names the alternatives explicitly
✓ States the reasoning + the deferred decision

### 3. Confidence-flagged uncertainty
```
<assay-decision kind="decision" confidence="0.4" layer="positioning">
Provisional: lead the launch page with the local-first angle. Low confidence; revisit if the first three testers don't mention it unprompted.
</assay-decision>
```
✓ Honest confidence (0.4 means "I might change this")
✓ Explicit revisit-trigger

### 4. Supersession
```
<assay-decision kind="decision" confidence="0.9" supersedes="a3f7c1d9" layer="storage">
Revised retention: 90 days, not 30. Three weeks of support tickets showed users re-requesting exports after a month.
</assay-decision>
```
✓ Supersedes attribute set (stored as `supersedes_raw`; recall does not resolve it yet)
✓ Explains WHY this supersedes, not just THAT it does

### 5. Conflict marker
```
<assay-decision kind="conflict" layer="positioning">
Conflict: "individual builders" framing (decision a3f7c1d9) vs "team product" framing (decision b8c2d5e0); pick one before the day-30 gate so it doesn't drift.
</assay-decision>
```
✓ Uses kind="conflict" so the system flags it differently
✓ Names the conflicting decisions by ID prefix
✓ Has a resolve-by trigger

## 5 bad examples (don't do these)

### 1. Conversational
```
<assay-decision kind="decision">Talking to the design team about pricing today.</assay-decision>
```
✗ Not a decision, a status update.

### 2. Empty agreement
```
<assay-decision kind="decision">Sure, that works.</assay-decision>
```
✗ No content. Future-you has no idea what "that" was.

### 3. Pure speculation
```
<assay-decision kind="decision">Maybe we should think about pricing eventually.</assay-decision>
```
✗ A thought, not a decision. Tag it when you actually decide.

### 4. Tagging the whole agent's turn
```
<assay-decision kind="decision">
I'll first investigate the user's question, then implement the feature,
then write tests, then ship. The feature should handle edge case X by
doing Y, and edge case Z by doing W...
</assay-decision>
```
✗ Multiple decisions bundled in one tag. Tag each separately so recall can surface them individually.

### 5. Paraphrased instead of verbatim
```
<assay-decision kind="decision">User wants the pricing thing done.</assay-decision>
```
✗ Loses the actual decision. Tag what was decided in clear terms, not a meta-summary.

## How often?

**Healthy rates by role:**

| Activity | Tags per week (typical) |
|---|---|
| Active scoping / strategy work | 8–20 |
| Heads-down execution week | 3–8 |
| Reactive / interrupt-driven week | 1–4 |

**Under 3/week** for 2 consecutive weeks = either you're not making decisions in agent sessions (the tool can't help) OR you're forgetting to tag (set a reminder in your agent's system prompt to tag decisions).

**Over 30/week** = you're tagging conversation. Recall quality drops as signal-to-noise degrades. Audit what you've been tagging.

## Asking Claude to tag for you

The plugin's built-in instruction tells agents to stay silent by default: tag only when you ask, when a decision replaces an earlier one, or to record a Librarian ruling. If you want routine decisions tagged too, say so in CLAUDE.md (project or user level):

```markdown
## Decision tagging

When the user and I make a concrete decision in this session — pricing, architecture,
scope, naming, positioning — I will tag it inline using the AssayLabs format:

<assay-decision kind="decision" confidence="0.X" layer="..."> ... </assay-decision>

I will NOT tag: status updates, exploratory questions, partial reasoning, or anything
the user hasn't agreed to.
```

This shifts tagging from a discipline you maintain to a discipline the agent maintains for you.

## Tag attribute reference

| Attribute | Type | Required | Notes |
|---|---|---|---|
| `kind` | `"decision"` or `"conflict"` | ✓ | The older kinds constraint, trade-off, scope-change, open-question and finding are stored as decision. Other kinds are skipped + logged as parse errors |
| `confidence` | 0.0..1.0 | optional | Out-of-range values are logged as parse errors; the tag is still ingested with no confidence |
| `supersedes` | 8-char id prefix | optional | Stored as written in `supersedes_raw`. Not resolved to a decision yet |
| `layer` | string | optional | Freeform. Common: pricing, positioning, architecture, methodology |

## What the system does with your tag

1. **Parse.** At the end of every turn, the Stop hook reads the raw transcript file (all of it, including tool output) and parses complete tags.
2. **Validate.** Kind, confidence range, body non-empty, at most 2,000 characters, no tag syntax inside (a body that names the `<assay-decision>` tag is rejected, not split). An unclosed opener in an earlier transcript record, such as a grep result, does not block a later real tag. Failures logged to `~/.assay/analytics/tool-usage.jsonl` with reason.
3. **Dedupe.** A tag with the same kind and body as one already stored, in this transcript or an earlier turn, is skipped. `supersedes` is stored as written and not resolved yet.
4. **Persist.** Atomic transaction into `~/.assay/decisions.db` with audit-trail row in `decision_transitions`.
5. **Recall-ready.** `/assay-decision` and `/assay-brief` can now surface it.
