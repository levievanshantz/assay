// Synthetic Claude Code session transcript (JSONL), for tests and for the
// cached-vs-rebuilt equivalence run. Content is invented; the SHAPE follows
// what Claude Code writes: one JSON object per line, `type` user|assistant,
// `message.content` as a string or an array of text / tool_use / tool_result
// blocks. Because every line is JSON.stringify'd, each tag's quotes land in the
// file as \" and newlines as \n, exactly as in a real transcript.
//
// The session has three turns. The Stop hook fires after each one, reading the
// whole (growing) file each time.

export const SESSION_ID = "5f0c2a1e-7d3b-4c1a-9e2f-00000000abcd";
const CWD = "/work/example-project";

class TranscriptBuilder {
  constructor() {
    this.lines = [];
    this.n = 0;
    this.parent = null;
    this.pending = [];
  }

  #base(type) {
    this.n += 1;
    const uuid = `00000000-0000-4000-8000-${String(this.n).padStart(12, "0")}`;
    const line = {
      parentUuid: this.parent,
      isSidechain: false,
      userType: "external",
      cwd: CWD,
      sessionId: SESSION_ID,
      version: "2.1.0",
      gitBranch: "main",
      type,
      uuid,
      timestamp: new Date(Date.UTC(2026, 8, 1, 12, 0, this.n)).toISOString(),
    };
    this.parent = uuid;
    return line;
  }

  user(text) {
    this.pending.push({ ...this.#base("user"), message: { role: "user", content: text } });
  }

  #assistant(block) {
    this.pending.push({
      ...this.#base("assistant"),
      message: {
        id: `msg_fixture${String(this.n).padStart(4, "0")}`,
        type: "message",
        role: "assistant",
        model: "claude-fixture",
        content: [block],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      },
      requestId: `req_fixture${String(this.n).padStart(4, "0")}`,
    });
  }

  assistantText(text) {
    this.#assistant({ type: "text", text });
  }

  assistantToolUse(name, input) {
    const id = `toolu_fixture${String(this.n + 1).padStart(4, "0")}`;
    this.#assistant({ type: "tool_use", id, name, input });
    return id;
  }

  toolResult(toolUseId, text) {
    this.pending.push({
      ...this.#base("user"),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }] }],
      },
    });
  }

  /** JSONL text of the lines added since the last flush. */
  flush() {
    const out = this.pending.map((l) => JSON.stringify(l)).join("\n") + "\n";
    this.lines.push(...this.pending);
    this.pending = [];
    return out;
  }
}

// Stand-in for the capture protocol when a caller does not supply the real
// text. Tests that check stored rows pass the real DECISION_CAPTURE_PROTOCOL
// (from dist/ or from the built bundle), so the fixture exercises exactly what
// an agent reads when it calls __IMPORTANT.
const PROTOCOL_PLACEHOLDER = "(capture protocol text not supplied)";

const LOG_DUMP =
  '<assay-decision kind="decision">' + "export batch ok\n".repeat(180) + "</assay-decision>";

/**
 * JSONL chunks, one per turn. Append them in order to grow the transcript.
 * `protocolText` is what the __IMPORTANT tool returns in turn 3.
 */
export function sessionTurns(protocolText = PROTOCOL_PLACEHOLDER) {
  const t = new TranscriptBuilder();

  // Turn 1: three ordinary tags.
  t.user("Should the exporter keep its state in SQLite or in flat files?");
  t.assistantText(
    'SQLite gives us transactions for free.\n\n<assay-decision kind="decision" confidence="0.9">Store exporter state in SQLite, not flat files.</assay-decision>',
  );
  t.assistantText(
    '<assay-decision kind="decision" layer="architecture" confidence="0.7">\nKeep the export worker stateless between runs.\n</assay-decision>',
  );
  t.assistantText(
    '<assay-decision kind="decision">Name the export setting "Archive", not "Backup".</assay-decision>',
  );
  const turn1 = t.flush();

  // Turn 2: a grep result leaves two unpaired openers in the transcript right
  // before a real conflict tag; then a ruling, a legacy kind, an unknown kind,
  // and a body that contains the two characters backslash + n.
  t.user("Check the notes for earlier calls, then record the cache conflict.");
  const grepId = t.assistantToolUse("Bash", {
    command: "grep -n '<assay-decision kind=' docs/notes.md",
    description: "Find tagged notes",
  });
  t.toolResult(grepId, '12:<assay-decision kind="decision" confidence="0.8">\n40:<assay-decision kind="conflict">');
  t.assistantText(
    '<assay-decision kind="conflict" supersedes="abcd1234">The 24-hour cache TTL contradicts the one-hour freshness target.</assay-decision>',
  );
  t.assistantText(
    '<assay-decision kind="decision" layer="ruling">flag #12: confirmed, the batch importer replaces the manual CSV export.</assay-decision>',
  );
  t.assistantText('<assay-decision kind="constraint">Recall must stay under 50 ms at p95.</assay-decision>');
  t.assistantText('<assay-decision kind="banana">Not a real kind.</assay-decision>');
  t.assistantText(
    '<assay-decision kind="decision">Split log records on the literal \\n token, not on real line breaks.</assay-decision>',
  );
  const turn2 = t.flush();

  // Turn 3: the agent reads the full capture protocol (it mentions the tag and
  // shows an example, all in one tool_result record), restates a turn-1
  // decision word for word, supersedes it, a log dump opens a tag and closes it
  // 2,700 characters later, and one body holds a real tab character.
  t.user("Pull up the capture protocol, then revisit the storage call.");
  const protoId = t.assistantToolUse("mcp__plugin_assay_assay____IMPORTANT", {});
  t.toolResult(protoId, protocolText);
  t.assistantText(
    'As decided earlier: <assay-decision kind="decision" confidence="0.9">Store exporter state in SQLite, not flat files.</assay-decision>',
  );
  t.assistantText(
    '<assay-decision kind="decision" supersedes="1a2b3c4d" confidence="0.6">Move exporter state from SQLite to Postgres once there are two writers.</assay-decision>',
  );
  const logId = t.assistantToolUse("Bash", { command: "tail -n 180 export.log", description: "Show export log" });
  t.toolResult(logId, LOG_DUMP);
  t.assistantText(
    '<assay-decision kind="decision">Separate export columns with a tab (\t) character.</assay-decision>',
  );
  const turn3 = t.flush();

  return [turn1, turn2, turn3];
}

/** Stop hook input as Claude Code sends it. */
export function stopInput(transcriptPath) {
  return {
    session_id: SESSION_ID,
    transcript_path: transcriptPath,
    cwd: CWD,
    hook_event_name: "Stop",
    stop_hook_active: false,
  };
}

// What the rebuilt hook stores, cumulatively, after each Stop.
// Fields: [kind, confidence, supersedes_raw, layer, body]
const R1 = [
  ["decision", 0.9, null, null, "Store exporter state in SQLite, not flat files."],
  ["decision", 0.7, null, "architecture", "Keep the export worker stateless between runs."],
  ["decision", null, null, null, 'Name the export setting "Archive", not "Backup".'],
];
const R2 = [
  ...R1,
  ["conflict", null, "abcd1234", null, "The 24-hour cache TTL contradicts the one-hour freshness target."],
  ["decision", null, null, "ruling", "flag #12: confirmed, the batch importer replaces the manual CSV export."],
  ["decision", null, null, null, "Recall must stay under 50 ms at p95."],
  ["decision", null, null, null, "Split log records on the literal \\n token, not on real line breaks."],
];
const R3 = [
  ...R2,
  ["decision", 0.6, "1a2b3c4d", null, "Move exporter state from SQLite to Postgres once there are two writers."],
  ["decision", null, null, null, "Separate export columns with a tab (\t) character."],
];
export const EXPECTED_ROWS_AFTER_EACH_STOP = [R1, R2, R3];

export function rowTuple(r) {
  return [r.kind, r.confidence, r.supersedes_raw, r.layer, r.body];
}
