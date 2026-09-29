// The BUILT Stop hook (plugin/scripts/stop-hook.cjs), run the way Claude Code
// runs it: `node stop-hook.cjs` with the hook input on stdin, once per turn,
// against a JSONL transcript that grows between runs.
// Uses only node: builtins and the vendored plugin/node_modules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeSandbox } from "./helpers/sandbox.mjs";
import {
  MCP_SERVER,
  REPO_ROOT,
  bundleSkipReason,
  pluginRequire,
  readDecisionRows,
  runStopHook,
} from "./helpers/plugin.mjs";
import {
  EXPECTED_ROWS_AFTER_EACH_STOP,
  rowTuple,
  sessionTurns,
  stopInput,
} from "./fixtures/session.mjs";

const skip = bundleSkipReason();

/** The capture protocol exactly as the built MCP server's __IMPORTANT tool returns it. */
function builtProtocol() {
  return pluginRequire(MCP_SERVER).DECISION_CAPTURE_PROTOCOL;
}

test("three Stops on a growing JSONL transcript: attributes parsed, nothing re-deposited", { skip }, (t) => {
  const sb = makeSandbox("assay-stop");
  t.after(() => sb.cleanup());
  const transcript = join(sb.dir, "session.jsonl");
  writeFileSync(transcript, "");

  const captured = [];
  sessionTurns(builtProtocol()).forEach((chunk, i) => {
    appendFileSync(transcript, chunk);
    const run = runStopHook({ env: sb.env(), input: stopInput(transcript) });
    assert.equal(run.status, 0, `Stop #${i + 1} exited ${run.status}: ${run.stderr}`);
    assert.equal(run.result?.continue, true);
    assert.equal(run.result?.assay?.ok, true, `Stop #${i + 1}: ${JSON.stringify(run.result)}`);
    captured.push(run.result.assay.decisions_captured);

    const rows = readDecisionRows(sb.dbPath).map(rowTuple);
    assert.deepEqual(rows, EXPECTED_ROWS_AFTER_EACH_STOP[i], `rows after Stop #${i + 1}`);
  });
  assert.deepEqual(captured, [3, 4, 2], "each Stop stores only what is new");

  // A fourth Stop with no new turn stores nothing.
  const again = runStopHook({ env: sb.env(), input: stopInput(transcript) });
  assert.equal(again.result.assay.decisions_captured, 0);
  assert.equal(readDecisionRows(sb.dbPath).length, EXPECTED_ROWS_AFTER_EACH_STOP[2].length);
});

test("stored rows carry session id and transcript path; logs stay in the sandbox HOME", { skip }, (t) => {
  const sb = makeSandbox("assay-stop-meta");
  t.after(() => sb.cleanup());
  const transcript = join(sb.dir, "session.jsonl");
  writeFileSync(transcript, sessionTurns()[0]);
  runStopHook({ env: sb.env(), input: stopInput(transcript) });

  const Database = pluginRequire("better-sqlite3");
  const db = new Database(sb.dbPath, { readonly: true });
  const row = db.prepare("SELECT source_session_id, source_transcript_path, status FROM decisions LIMIT 1").get();
  db.close();
  assert.equal(row.source_session_id, stopInput(transcript).session_id);
  assert.equal(row.source_transcript_path, transcript);
  assert.equal(row.status, "tentative");

  const log = join(sb.home, ".assay", "analytics", "tool-usage.jsonl");
  assert.ok(existsSync(log), "analytics log written under the sandbox HOME");
  const last = JSON.parse(readFileSync(log, "utf8").trim().split("\n").pop());
  assert.equal(last.outcome, "ok");
});

test("ECC_HOOK_PROFILE=minimal: the built hook stores nothing", { skip }, (t) => {
  const sb = makeSandbox("assay-stop-min");
  t.after(() => sb.cleanup());
  const transcript = join(sb.dir, "session.jsonl");
  writeFileSync(transcript, sessionTurns()[0]);
  const run = runStopHook({ env: sb.env({ ECC_HOOK_PROFILE: "minimal" }), input: stopInput(transcript) });
  assert.equal(run.status, 0);
  assert.match(run.result.assay.reason, /minimal/);
  assert.ok(!existsSync(sb.dbPath));
});

test("a drain table made first by the Librarian's init-journal DDL still captures", { skip }, (t) => {
  const sb = makeSandbox("assay-stop-lib");
  t.after(() => sb.cleanup());
  const Database = pluginRequire("better-sqlite3");
  mkdirSync(join(sb.home, ".assay"), { recursive: true });
  const db = new Database(sb.dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS decisions(
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'conflict')),
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'tentative',
    confidence REAL,
    layer TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL);`);
  db.close();

  const transcript = join(sb.dir, "session.jsonl");
  writeFileSync(transcript, sessionTurns()[0]);
  const run = runStopHook({ env: sb.env(), input: stopInput(transcript) });
  assert.equal(run.result?.assay?.ok, true, `hook failed: ${run.stderr} ${JSON.stringify(run.result)}`);
  assert.deepEqual(readDecisionRows(sb.dbPath).map(rowTuple), EXPECTED_ROWS_AFTER_EACH_STOP[0]);
});

test("the capture protocol, the deposit skill and a body that names the tag store nothing", { skip }, (t) => {
  const sb = makeSandbox("assay-stop-syntax");
  t.after(() => sb.cleanup());
  const transcript = join(sb.dir, "session.jsonl");
  const line = (o) => JSON.stringify(o) + "\n";
  const skill = readFileSync(join(REPO_ROOT, "plugin", "skills", "assay-decision-deposit", "SKILL.md"), "utf8");

  // One turn: the agent calls __IMPORTANT (the built server's own text comes
  // back as a tool_result), the deposit skill loads as a meta user message, and
  // a reply tags a decision whose body names the tag itself.
  writeFileSync(
    transcript,
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__plugin_assay_assay____IMPORTANT", input: {} }] } }) +
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: builtProtocol() }] }] } }) +
      line({ type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: skill }] } }) +
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: '<assay-decision kind="decision">Rename the <assay-decision> tag to <decision> in v3.</assay-decision>' }] } }),
  );
  const first = runStopHook({ env: sb.env(), input: stopInput(transcript) });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.result?.assay?.ok, true, JSON.stringify(first.result));
  assert.equal(first.result.assay.decisions_captured, 0);
  assert.equal(first.result.assay.parse_errors, 1, "the tag-naming body is rejected as tag syntax");
  assert.deepEqual(existsSync(sb.dbPath) ? readDecisionRows(sb.dbPath) : [], []);

  // Next turn: a real tag in a later record still lands, even though the
  // protocol and skill text above left unclosed openers in the transcript.
  appendFileSync(
    transcript,
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: '<assay-decision kind="decision">Keep the tag name as is.</assay-decision>' }] } }),
  );
  runStopHook({ env: sb.env(), input: stopInput(transcript) });
  assert.deepEqual(readDecisionRows(sb.dbPath).map((r) => r.body), ["Keep the tag name as is."]);
});
