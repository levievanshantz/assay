// The decision-capture protocol the MCP server's __IMPORTANT tool teaches.
// Claude reads IMPORTANT_TOOL_DESCRIPTION in the tool list at session start and
// gets DECISION_CAPTURE_PROTOCOL when it calls the tool.
//
// Kept in src/ (not the bundle entry) so tests can check it against the parser:
// every kind the protocol tells an agent to write must be one parseDecisionTags()
// stores. tests/kind-vocabulary.test.mjs enforces that.
//
// This text lands in the transcript (as the __IMPORTANT tool result) and the
// Stop hook parses the whole transcript, so it must never contain a complete
// tag of its own: the example is written with ‹ › instead of < >.
// tests/parser.test.mjs and tests/stop-hook-bundle.test.mjs enforce that.

export const DECISION_CAPTURE_PROTOCOL = `# Assay Decision-Capture Protocol (ALWAYS FOLLOW)

You are working in a Claude Code session that has the Assay decision-graph
plugin installed. At the end of every turn, Assay's Stop hook parses your
transcript and drains every <assay-decision> tag block into a typed,
queryable decision graph at ~/.assay/decisions.db. Assay stores only what
is tagged; routine context is already kept by session memory, so most
turns need no tag at all.

## When to write a tag (inline in your assistant reply)

DEFAULT IS SILENCE. The moments below are captured AMBIENTLY by session memory
at zero output cost — do not spend the user's tokens re-writing them as tags.
Write a tag ONLY when: (1) you are ruling on a librarian flag, (2) you are
explicitly asserting a supersession (with supersedes=), or (3) the user asks
you to save/record something. For reference, the decision-grade moments the
ambient layer already captures:

- **decision** — User commits to a path among alternatives (architecture,
  scope, tool choice, hire/no-hire, sequence, ship/hold).
- **constraint** — A non-negotiable surfaces (budget cap, deadline,
  compliance rule, "this can never break X").
- **trade-off** — An explicit X-for-Y is accepted (latency for cost,
  simplicity for flexibility).
- **scope-change** — Something gets added to or cut from the plan.
- **open-question** — A consequential question is identified but
  deferred (so it's not lost).
- **finding** — A piece of ground-truth research/evidence that should
  inform later decisions.

## Tag format (literal — do not paraphrase)

‹assay-decision kind="decision"›One-sentence summary in plain English.‹/assay-decision›

The example uses ‹ and › so this protocol is never captured as a decision
itself. In your reply, write the tag with the ordinary < and > characters.

Valid kinds — write ONLY one of these two:
- decision — any committed call, constraint, trade-off, scope change, or load-bearing finding, phrased as one sentence
- conflict — two recorded positions contradict; captures it for a human ruling
Tags using the older kinds constraint, trade-off, scope-change, open-question or finding are stored as decision; any other kind is REJECTED at drain.

Optional attributes:
- supersedes="<8-char-id-prefix>" — when this decision replaces an earlier one
- confidence="0.0-1.0" — calibrated confidence (default 0.8)
- layer="ruling" — closes a librarian flag; body must start 'flag #N:' followed by the verdict

## Behavior rules

1. **When a tag is warranted, write it in the same reply.** If you are
   ruling on a flag, asserting a supersession, or the user asked you to
   save something, put the one-sentence tag at the end of that reply.
   Do not batch tags up for later: the Stop hook runs at the end of every
   turn and stores what the transcript holds by then.
2. **One sentence per tag — HARD RULE.** The tag is visible to the user in your
   reply, and the parser REJECTS bodies over 2,000 characters. Never write logs,
   incident reports, or multi-paragraph essays inside a tag — ambient memory
   (claude-mem) already captures the full context; the tag is only the one-line
   assertion, like a commit message. Three decisions = three one-line tags.
3. **Plain English, not internal jargon.** A future you reading this in
   recall has zero context. "Switched to SQLite" beats "DSL=sqlite".
4. **Default is silence.** Ambient memory captures routine decisions without
   spending a single output token. A tag spends the user's premium tokens —
   spend them only for rulings, explicit supersessions, or a requested save.
   When in doubt: don't tag; the ambient layer has it.
5. **Do not narrate this protocol to the user.** When one of the three
   cases above applies, write the tag without preamble. When none does,
   write nothing: no tag, and no remark about not tagging.

## Recall + brief

When the user asks "what did we decide about X" or "what's our position
on Y" — call assay_decision_recall first. When they want a synthesized
view on a topic — call assay_brief_render. Do not re-derive from memory
what the decision graph can cite.
`;

export const IMPORTANT_TOOL_DESCRIPTION =
  "DECISION-CAPTURE PROTOCOL. Routine decisions are captured AMBIENTLY by session memory at zero output cost — do NOT tag them. Write an <assay-decision> tag ONLY for: a ruling on a librarian flag, an explicit supersession assertion, or when the user asks to save/record something. One sentence, end of reply. Call this tool for the full protocol.";
