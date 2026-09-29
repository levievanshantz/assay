// The BUILT MCP server (plugin/scripts/mcp-server.cjs) over stdio, the way
// Claude Code talks to it. Also pins down what recall / brief actually do,
// so the docs can describe them exactly:
//   - recall ignores the query and returns the most recent decisions
//   - brief keeps decisions whose body or layer contains a topic word (3+ chars)
// Uses only node: builtins and the vendored plugin/node_modules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { makeSandbox } from "./helpers/sandbox.mjs";
import { MCP_SERVER, REPO_ROOT, STOP_HOOK, bundleSkipReason, pluginRequire } from "./helpers/plugin.mjs";
import { startMcpServer } from "./helpers/mcp-stdio.mjs";

const skip = bundleSkipReason();

const SEED = [
  // [id, body, layer, created_at]
  ["d0000001-0000-4000-8000-000000000001", "Keep decision storage on the user's machine.", "storage", 1000],
  ["d0000002-0000-4000-8000-000000000002", "Store exporter state in SQLite.", "architecture", 2000],
  ["d0000003-0000-4000-8000-000000000003", "Ship the importer before the export UI.", null, 3000],
  ["d0000004-0000-4000-8000-000000000004", "Keep the worker stateless between runs.", null, 4000],
  ["d0000005-0000-4000-8000-000000000005", "Drop the CSV export once the importer ships.", null, 5000],
  ["d0000006-0000-4000-8000-000000000006", "Recall must stay under 50 ms at p95.", null, 6000],
];

function seed(home) {
  const Database = pluginRequire("better-sqlite3");
  // Same columns as src/decisions/schema.ts; rows get fixed timestamps so the
  // recency order is deterministic.
  mkdirSync(join(home, ".assay"), { recursive: true });
  const path = join(home, ".assay", "decisions.db");
  const db = new Database(path);
  db.exec(`CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('decision', 'conflict')), body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'tentative', confidence REAL, layer TEXT, supersedes_raw TEXT,
    supersedes_resolved_id TEXT, supersedes_unresolved_reason TEXT, source_session_id TEXT,
    source_transcript_path TEXT, source_span_start INTEGER, source_span_end INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, embedding_model TEXT, embedded_at INTEGER)`);
  const ins = db.prepare(
    `INSERT INTO decisions (id, kind, body, status, layer, created_at, updated_at)
     VALUES (?, 'decision', ?, 'tentative', ?, ?, ?)`,
  );
  for (const [id, body, layer, at] of SEED) ins.run(id, body, layer, at, at);
  db.close();
}

test("MCP over stdio: initialize, list tools, protocol, recall, expand, brief", { skip }, async (t) => {
  const sb = makeSandbox("assay-mcp");
  t.after(() => sb.cleanup());
  seed(sb.home);

  const server = startMcpServer(MCP_SERVER, sb.env());
  t.after(() => server.close());

  const init = await server.initialize();
  assert.equal(init.serverInfo.name, "assay");
  const pkgVersion = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
  assert.equal(init.serverInfo.version, pkgVersion);

  const { tools } = await server.listTools();
  assert.deepEqual(tools.map((x) => x.name), [
    "__IMPORTANT",
    "assay_decision_recall",
    "assay_decision_expand",
    "assay_brief_render",
  ]);

  const important = await server.callTool("__IMPORTANT");
  assert.match(important.text, /Valid kinds — write ONLY one of these two/);
  // The protocol lands in the transcript as this tool's result; the built Stop
  // hook must not store its example as a decision.
  const { parseDecisionTags } = pluginRequire(STOP_HOOK);
  const asRecord = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: important.text }] }] } });
  assert.deepEqual(parseDecisionTags(asRecord).decisions, [], "__IMPORTANT's own text is not captured");

  // recall: the query is not used to select rows — newest first, capped at limit.
  const recall = await server.callTool("assay_decision_recall", { query: "storage", limit: 3 });
  assert.equal(recall.isError, false);
  assert.deepEqual(
    recall.json.results.map((r) => r.decision.body),
    [SEED[5][1], SEED[4][1], SEED[3][1]],
    "recall returns the 3 most recent decisions, not the storage one",
  );
  assert.equal(recall.json.context_tier, "unavailable"); // claude-mem is offline in the sandbox
  assert.ok(recall.json.results.every((r) => r.supersession_chain.length === 1));

  // expand: needs claude-mem; offline -> nothing.
  const expand = await server.callTool("assay_decision_expand", { query: "storage", decision_ids: [SEED[0][0]] });
  assert.deepEqual(expand.json, { query: "storage", expanded_results: [], context_tier: "unavailable" });

  // brief: substring match of topic words (3+ chars) against body or layer.
  const brief = await server.callTool("assay_brief_render", { topic: "storage" });
  assert.deepEqual(brief.json.citations.map((c) => c.decision_id), [SEED[0][0]], "matched via layer=storage");
  const miss = await server.callTool("assay_brief_render", { topic: "monetization" });
  assert.match(miss.json.refusal.reason, /No decisions in corpus match topic/);
});

test("MCP over stdio: fewer than 5 decisions returns the cold-start envelope", { skip }, async (t) => {
  const sb = makeSandbox("assay-mcp-cold");
  t.after(() => sb.cleanup());
  const server = startMcpServer(MCP_SERVER, sb.env());
  t.after(() => server.close());
  await server.initialize();
  const recall = await server.callTool("assay_decision_recall", { query: "anything" });
  assert.deepEqual(recall.json.results, []);
  assert.equal(recall.json.cold_start.corpus_size, 0);
});
