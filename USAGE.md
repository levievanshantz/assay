# Usage

## Tag attributes

```
<assay-decision
  kind="decision"           required: "decision" or "conflict"
  confidence="0.0..1.0"     optional: how sure you are
  supersedes="abc12345"     optional: 8-char prefix of prior decision id
  layer="storage"           optional: freeform label for organization
>
One sentence stating what was decided.
</assay-decision>
```

- **Kinds.** Write `decision` or `conflict`. Tags written with the older kinds `constraint`, `trade-off`, `scope-change`, `open-question` or `finding` are accepted and stored as `decision`. Any other kind is rejected and logged.
- **Confidence.** A value outside 0 to 1 is stored as empty, and the error is logged.
- **Supersedes.** Stored as written, in `supersedes_raw`. It is not resolved to a decision yet (see Recipe 4).
- **Layer.** Free text. The Librarian treats `layer="ruling"` with a body that starts `flag #N:` as your ruling on flag N.
- **Body.** One sentence, 2,000 characters at most. A body that contains tag syntax (for example, a decision that names the `<assay-decision>` tag) is rejected and logged, not stored. An unclosed opener in an earlier transcript record, such as a grep result, does not block a real tag written later.

**Dedupe.** A tag with the same kind and body as one already stored is skipped, whether it repeats in the same transcript or was stored in an earlier turn. The Stop hook runs at the end of every turn, so this is what keeps each decision to one row.

**Body discipline.** Make the body a complete decision statement, not a paraphrase. Future-you reading it should understand the decision without the surrounding context.

**Where tags are read from.** The Stop hook reads the whole transcript file, not only the agent's replies. A complete tag in tool output, such as a file the agent read, is captured too. The plugin's own capture protocol and skill write their example tags with ‹ › so reading them never stores a decision.

## Slash commands

### `/assay-decision <question>`
Calls `assay_decision_recall`. Returns your most recent decisions (10 by default), newest first, each with its id. The question is not used to select or rank decisions yet; it is used only to look up related claude-mem context.

```
You: /assay-decision what did we decide about the export worker
Claude: [calls assay_decision_recall, shows your recent decisions with ids]
```

### `/assay-brief <topic>`
Calls `assay_brief_render`. Takes the words of 3 or more letters in your topic, finds recent decisions whose body or layer contains any of them, and returns up to five as a numbered list with their ids. It does not write a summary. If nothing matches, it returns a refusal instead of guessing.

```
You: /assay-brief export worker design
Claude: [calls assay_brief_render, shows numbered decisions and citations]
```

### `/assay-decision-deposit`
Tag a decision explicitly in the current response. The plugin tells agents to stay silent by default, so this is the direct way to save something. Also useful when:
- Running `ECC_HOOK_PROFILE=minimal` (ambient capture disabled)
- Retroactively capturing something that should have been tagged earlier

## Recipes

### Recipe 1: Capture during work
You and the agent settle something worth keeping. Ask the agent to save it, or write the tag yourself. At the end of the turn, the Stop hook stores it. The plugin's instruction to agents is to tag only when you ask, when a decision replaces an earlier one, or to record a Librarian ruling.

### Recipe 2: Recall before re-deriving
You hit a question you suspect you've answered before.
```
/assay-decision should the export worker keep state between runs
```
Recall returns your recent decisions. Scan them for the one you need. If it is not there, derive the answer and tag the result.

### Recipe 3: Brief at session start
First message of a new session, on a topic you've worked on before:
```
/assay-brief export worker
```
You get the recent decisions that mention the topic, numbered, each with its id.

### Recipe 4: Supersede a stale decision
You've decided to change a prior call.
```
/assay-decision export worker
# (find the prior decision's id, copy the first 8 chars, e.g. "a3f7c1d9")

<assay-decision kind="decision" confidence="0.9" supersedes="a3f7c1d9" layer="storage">
Revised: the export worker keeps a cursor between runs, so a restart resumes instead of rescanning.
</assay-decision>
```
The new decision is stored with `supersedes_raw="a3f7c1d9"`. Recall does not resolve that link yet, so each result's supersession chain holds only the decision itself. If you run the Librarian, its flag and ruling loop is where supersession is recorded today.

### Recipe 5: Flag a conflict
Two decisions you can't reconcile yet.
```
<assay-decision kind="conflict" layer="storage">
Conflict: decision a3f7c1d9 keeps the export worker stateless, decision b8c2d5e0 gives it a cursor. Pick one before the next release.
</assay-decision>
```
With `ECC_HOOK_PROFILE=strict`, the Stop hook also prints a conflict count to stderr.

## Output interpretation

### `context_tier` field
On recall responses:
- `"full"`: claude-mem reachable, enrichment included
- `"degraded"`: claude-mem reachable but slow, or a mid-request error
- `"unavailable"`: claude-mem offline; only decision data returned

Decisions come back at every tier. Only the claude-mem context is affected. When it is present, the first three results each get one claude-mem observation, attached by position, not matched to that decision.

### `cold_start` field
On recall: the database has fewer than 5 decisions. Results are empty until it has 5. Brief refuses below 5 as well.

### `refusal` field
On brief: fewer than 5 decisions, a topic with no word of 3 or more letters, or no recent decision that mentions the topic. Fall back to `/assay-decision` for raw recall.

## Troubleshooting

### "Stop hook doesn't seem to fire"
1. Check that `assay@assaylabs` is installed and enabled in Claude Code's `/plugin` menu.
2. Check that `node --version` prints v22. The plugin's SQLite driver loads only on Node 22.x on Apple Silicon.
3. Check `~/.assay/analytics/tool-usage.jsonl`. It should have entries with `tool: "stop-drain"`.
4. Check `~/.assay/errors.jsonl`. Fatal failures land here.

### "/assay-decision returns nothing"
1. Count the decisions:
   ```bash
   sqlite3 ~/.assay/decisions.db "SELECT COUNT(*) FROM decisions"
   ```
2. If the count is 0, the Stop hook isn't capturing. See above.
3. If the count is below 5, recall returns `cold_start` by design.

### "claude-mem worker not reachable"
claude-mem is optional. Without it, `context_tier` is `"unavailable"` and your decisions still come back. The plugin looks for the worker on port `37700 + uid % 100`; set `CLAUDE_MEM_WORKER_PORT` to override. See claude-mem's own docs to start its worker.

### "Recall is slow"
- Recall probes claude-mem's health, and when it is reachable, makes a search call (limit 3) and fetches those observations. With claude-mem offline, only the probe runs.
- Recall reads the most recent rows through an index on `created_at`, so it does not scan the whole table. Semantic recall over the decisions table is on the [roadmap](ROADMAP.md).

### "I want to start over"
```bash
rm ~/.assay/decisions.db
# Tags from future sessions will populate fresh.
```
If you run the Librarian, it reads this file too. See `librarian/SETUP.md` before removing it.

### "I want to uninstall"
Remove `assay@assaylabs` from Claude Code's `/plugin` menu. Your decisions stay in `~/.assay/decisions.db` until you delete that file. If you also run the Librarian, do not delete all of `~/.assay`: its journal lives there too. `librarian/SETUP.md` lists exactly which files are the Librarian's.
