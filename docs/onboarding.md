# Onboarding — Your First 30 Days With Assay

This is the operator's manual for the first 30 days. If you're testing Assay, follow this in order.

## Day 0 — Install (10 minutes)

You need macOS on Apple Silicon and Node 22.x as the `node` on your PATH. claude-mem is optional; see its own docs if you want its session context in recall.

In Claude Code:

```
/plugin marketplace add levievanshantz/assay
/plugin install assay@assaylabs
```

Optional but recommended, run the proof from a clone:

```bash
git clone https://github.com/levievanshantz/assay
cd assay
npm ci
npm test          # 44 tests
npm run smoke     # 19 integration cases
npm run demo      # end-to-end sandbox demo
```

## Day 1 — Your first tag

In any Claude Code session, when you make a real decision worth remembering, tag it inline (or ask Claude to tag it for you; by default the plugin tells agents to tag only when asked):

```
<assay-decision kind="decision" confidence="0.8" layer="storage">
Keep the export worker stateless between runs, so a crash never leaves a half-written cursor.
</assay-decision>
```

**Finish the turn.** The Stop hook runs at the end of every turn and persists the tag to `~/.assay/decisions.db`.

**Verify it landed:**
```bash
sqlite3 ~/.assay/decisions.db "SELECT id, kind, substr(body,1,60) FROM decisions ORDER BY created_at DESC LIMIT 5"
```

If you see your decision, capture works.

## Day 2-7 — Tagging discipline

Every time you make a real product/eng decision in an agent session, tag it. Don't tag conversational turns. Don't tag exploratory back-and-forth. Tag the **commits** — moments where you decide and would otherwise need to re-derive later.

**Good tags:**
```
<assay-decision kind="decision" confidence="0.7">
Move auth migration to v2.1 — keep v2.0 scope tight.
</assay-decision>

<assay-decision kind="decision" confidence="0.9" layer="positioning">
Describe the product to individual builders first; drop the "for teams" framing until a team asks.
</assay-decision>
```

**Bad tags (don't do these):**
```
<assay-decision kind="decision">Talking to the design team about pricing.</assay-decision>
<!-- ↑ this is a status update, not a decision -->

<assay-decision kind="decision">Yes, that sounds good.</assay-decision>
<!-- ↑ no concrete decision content -->
```

By end of week 1: 5-15 tags is healthy. <3 means you're not tagging enough (or not making decisions in agent sessions). >30 means you're tagging conversation, not decisions.

## Day 7 — First recall

In a new Claude Code session, ask:

```
/assay-decision what did we decide about the export worker
```

Claude calls the MCP tool and presents what comes back. Recall returns your most recent decisions (10 by default), newest first; your question does not rank them yet. Each result includes:
- The decision body (verbatim) and its id
- Confidence + layer (if set)
- Enrichment context from claude-mem (when available)

Below 5 stored decisions, recall returns a cold-start message instead.

**The trust contract:** if Assay tells you something, the id lets you verify it's a real decision you made.

## Day 14 — First brief

When you want a synthesis (not raw recall):

```
/assay-brief export worker design
```

Returns up to five recent decisions that mention a word from your topic, numbered, each with its decision id. It lists your decisions; it does not write a summary.

If the brief comes back as a refusal ("no decisions match topic"), that's the contract being honest — either the topic doesn't match anything you've tagged, or you need to use `/assay-decision` for raw recall instead.

## Day 21 — Supersession

You change your mind about a past decision. Look it up first:

```
/assay-decision export worker
```

Note the 8-char prefix of the decision id (e.g., `a3f7c1d9`). Then in your next tag:

```
<assay-decision kind="decision" confidence="0.9" supersedes="a3f7c1d9" layer="storage">
Revised: the export worker keeps a cursor between runs, so a restart resumes instead of rescanning.
</assay-decision>
```

The new decision is stored with the id prefix in `supersedes_raw`, and both decisions stay in the database. Recall does not resolve the link yet, so its supersession chain shows only the decision itself. If you run the Librarian, its flag and ruling loop records supersessions today.

## Day 30 — Honest signal check

Three weekly questions you've been answering:

1. **Time saved this week:** name one moment Assay gave you a cited answer in seconds that would otherwise have taken minutes of re-reading. Estimate minutes saved.
2. **Drift avoided this week:** name one decision that surfaced as superseded or in conflict — that you didn't know was outdated. What would you have done without that surface?
3. **Verdict trust:** did you act on what Assay told you without re-verifying? Why / why not?

If by day 30 you can answer YES with specifics to 2 of 3 questions in most weeks → the value prop holds for you.

If you can't → the value prop doesn't hold for you specifically (or you didn't tag enough decisions to populate the corpus). Either way, tell us what didn't land.

## Troubleshooting

| Symptom | Check |
|---|---|
| Stop hook not firing | `tail -f ~/.assay/analytics/tool-usage.jsonl` while you end a session — should see entries with `tool:"stop-drain"` |
| `/assay-decision` returns nothing | `sqlite3 ~/.assay/decisions.db "SELECT COUNT(*) FROM decisions"` — if 0, hook isn't capturing |
| claude-mem worker not reachable | claude-mem is optional; decisions still come back with `context_tier: "unavailable"`. See claude-mem's docs to start its worker. |
| Want to start over | `rm ~/.assay/decisions.db` (if you run the Librarian, read `librarian/SETUP.md` first) |
| Want to silence Assay for one session | `ECC_HOOK_PROFILE=minimal claude` |
| Want to uninstall | Remove `assay@assaylabs` in Claude Code's `/plugin` menu, then delete `~/.assay/decisions.db` if you want the data gone. Don't delete all of `~/.assay` if you run the Librarian. |

## Eval gate as confidence anchor

If anything feels broken, run the eval gate from a clone before reporting a bug:
```bash
HOME=$(mktemp -d) npm run eval:verify
HOME=$(mktemp -d) npm run eval:adversarial
```

Today verify mode and adversarial mode each pass 16 of 16. If that still holds, the system is honoring its contract, and your symptom is either:
- A contract gap (the issue isn't covered by an eval — file a feature request)
- An environment issue (different from the eval sandbox; file a bug with your macOS version, `node --version` and the last lines of `~/.assay/errors.jsonl`)
- A misunderstanding of what Assay claims to do (re-read CAPABILITIES.md)
