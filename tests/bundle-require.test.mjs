// require() the BUILT bundles directly: they must load (vendored native
// module included), export their entry points, and do nothing on load — no
// database opened, no stdin read, no exit.
// Uses only node: builtins and the vendored plugin/node_modules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sandboxThisProcess } from "./helpers/sandbox.mjs";
import {
  MCP_SERVER,
  PLUGIN_DIR,
  REPO_ROOT,
  STOP_HOOK,
  bundleSkipReason,
  pluginRequire,
} from "./helpers/plugin.mjs";

const sb = sandboxThisProcess("assay-require");
const skip = bundleSkipReason();

function readJson(...parts) {
  return JSON.parse(readFileSync(join(REPO_ROOT, ...parts), "utf8"));
}

test("versions agree: package.json, plugin.json, marketplace.json", () => {
  const pkg = readJson("package.json").version;
  const plugin = readJson("plugin", ".claude-plugin", "plugin.json").version;
  const market = readJson(".claude-plugin", "marketplace.json").plugins.find((p) => p.name === "assay");
  assert.equal(plugin, pkg);
  assert.equal(market.version, pkg);
  assert.equal(market.source, "./plugin");
});

test("engines.node matches the Node ABI the vendored better-sqlite3 was built for (22.x)", () => {
  assert.equal(readJson("package.json").engines.node, ">=22.0.0 <23.0.0");
});

test("the vendored better-sqlite3 resolves from plugin/node_modules", () => {
  const resolved = pluginRequire.resolve("better-sqlite3");
  assert.ok(resolved.startsWith(join(PLUGIN_DIR, "node_modules", "better-sqlite3")), resolved);
});

test("require(stop-hook.cjs) loads and exports without running the hook", { skip }, () => {
  const hook = pluginRequire(STOP_HOOK);
  assert.equal(typeof hook.runStopDrain, "function");
  assert.equal(typeof hook.main, "function");
  const { decisions } = hook.parseDecisionTags(
    JSON.stringify({ text: '<assay-decision kind="finding" supersedes="abcd1234" layer="ruling" confidence="0.9">flag #2: confirmed.</assay-decision>' }),
  );
  assert.equal(decisions.length, 1);
  assert.deepEqual(
    [decisions[0].kind, decisions[0].kind_alias, decisions[0].supersedes_raw, decisions[0].layer, decisions[0].confidence],
    ["decision", "finding", "abcd1234", "ruling", 0.9],
  );
  assert.ok(!existsSync(join(sb.home, ".assay")), "requiring the hook must not create ~/.assay");
});

test("require(mcp-server.cjs) loads without opening a DB or serving stdio; its handlers work", { skip }, async () => {
  const mcp = pluginRequire(MCP_SERVER);
  assert.ok(!existsSync(join(sb.home, ".assay")), "requiring the server must not create ~/.assay");

  assert.equal(mcp.VERSION, readJson("package.json").version);
  assert.deepEqual(
    mcp.TOOLS.map((t) => t.name),
    ["__IMPORTANT", "assay_decision_recall", "assay_decision_expand", "assay_brief_render"],
  );

  const assay = new mcp.AssayMCPServer(); // opens ~/.assay/decisions.db under the sandbox HOME
  try {
    const important = await mcp.callTool(assay, "__IMPORTANT", {});
    assert.equal(important.content[0].text, mcp.DECISION_CAPTURE_PROTOCOL);
    const recall = await mcp.callTool(assay, "assay_decision_recall", { query: "anything" });
    const payload = JSON.parse(recall.content[0].text);
    assert.equal(payload.cold_start.corpus_size, 0);
    const unknown = await mcp.callTool(assay, "nope", {});
    assert.equal(unknown.isError, true);
  } finally {
    await assay.close();
  }
  assert.ok(existsSync(join(sb.home, ".assay", "decisions.db")));
});
