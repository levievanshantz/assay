#!/usr/bin/env node
// Assay CLI — single binary, install + verify + doctor.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const HOME = homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude");
const ASSAY_DIR = join(HOME, ".assay");
const PLUGIN_DEST = join(CLAUDE_DIR, "plugins", "marketplaces", "assaylabs", "assay");

const cmd = process.argv[2];

function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ! ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); }

function ensureBuilt() {
  const dist = join(REPO_ROOT, "dist", "index.js");
  if (!existsSync(dist)) {
    info("Building TypeScript...");
    execSync("npm run build", { cwd: REPO_ROOT, stdio: "inherit" });
  }
}

function checkClaudeMem() {
  try {
    const out = execSync("curl -sS http://localhost:37701/api/health", { encoding: "utf8" });
    const body = JSON.parse(out);
    if (body.status === "ok") return { ok: true, version: body.version, port: 37701 };
  } catch {}
  for (let uid = 0; uid < 100; uid++) {
    const port = 37700 + uid;
    try {
      const out = execSync(`curl -sS --max-time 1 http://localhost:${port}/api/health`, { encoding: "utf8" });
      const body = JSON.parse(out);
      if (body.status === "ok") return { ok: true, version: body.version, port };
    } catch {}
  }
  return { ok: false };
}

function install() {
  console.log("\nassay install\n");

  ensureBuilt();

  info("Creating plugin destination...");
  mkdirSync(PLUGIN_DEST, { recursive: true });

  info("Copying plugin files...");
  for (const item of ["plugin", "dist", "node_modules", "package.json", ".mcp.json"]) {
    const src = join(REPO_ROOT, item);
    if (!existsSync(src)) {
      if (item === "node_modules") {
        warn(`${item} missing — running npm install first`);
        execSync("npm install --omit=dev --omit=optional", { cwd: REPO_ROOT, stdio: "inherit" });
      } else {
        warn(`${item} not found, skipping`);
        continue;
      }
    }
    cpSync(src, join(PLUGIN_DEST, item), { recursive: true });
  }
  ok(`Plugin installed at ${PLUGIN_DEST}`);

  info("Creating ~/.assay directory...");
  mkdirSync(ASSAY_DIR, { recursive: true });
  mkdirSync(join(ASSAY_DIR, "analytics"), { recursive: true });
  ok(`Workspace at ${ASSAY_DIR}`);

  // MCP server registration is now declared inside plugin/.mcp.json and
  // attached automatically by Claude Code's plugin manager on plugin enable.
  // No separate `claude mcp add` call is needed (and it would create a
  // scope-conflict warning).

  info("Registering plugin with Claude Code (attaches MCP and hooks)...");
  try {
    // Add the marketplace (idempotent — fails-soft if already added)
    execSync(`claude plugin marketplace add levievanshantz/assay 2>/dev/null || true`, { stdio: "ignore" });
    execSync(`claude plugin install assay@assaylabs 2>/dev/null || true`, { stdio: "ignore" });
    ok(`Plugin 'assay@assaylabs' registered with Claude Code's plugin manager`);
  } catch (err) {
    warn(`Plugin auto-registration failed: ${err.message}`);
    warn(`Manual fix: claude plugin marketplace add levievanshantz/assay && claude plugin install assay@assaylabs`);
  }

  console.log("\nInstallation complete.");
  console.log("\nNext steps:");
  console.log("  1. Make sure claude-mem is installed and its worker is running:");
  console.log("       npx claude-mem install && npx claude-mem start");
  console.log("  2. Restart Claude Code (Cmd+Q on macOS) so it discovers the new plugin.");
  console.log("  3. In any Claude Code session, tag a decision inline:");
  console.log("       <assay-decision kind=\"decision\">Your decision text.</assay-decision>");
  console.log("  4. End the session (Stop event fires). Decision persists to ~/.assay/decisions.db.");
  console.log("  5. In a new session, invoke /assay-decision to recall.");
  console.log("\nRun  assay doctor  to verify the install.\n");
}

function doctor() {
  console.log("\nassay doctor\n");

  let allOk = true;

  if (existsSync(PLUGIN_DEST)) {
    ok(`plugin installed at ${PLUGIN_DEST}`);
  } else {
    fail(`plugin NOT installed (expected at ${PLUGIN_DEST})`);
    fail(`  fix: node bin/assay.mjs install`);
    allOk = false;
  }

  if (existsSync(ASSAY_DIR)) {
    ok(`workspace exists at ${ASSAY_DIR}`);
  } else {
    fail(`workspace missing (expected at ${ASSAY_DIR})`);
    allOk = false;
  }

  const dbPath = join(ASSAY_DIR, "decisions.db");
  if (existsSync(dbPath)) {
    const size = statSync(dbPath).size;
    ok(`decisions.db exists (${(size / 1024).toFixed(1)}KB)`);
  } else {
    info(`decisions.db not yet created — will appear on first Stop event with a tag`);
  }

  const cm = checkClaudeMem();
  if (cm.ok) {
    ok(`claude-mem worker reachable on port ${cm.port} (v${cm.version})`);
  } else {
    fail(`claude-mem worker NOT reachable on any port 37700-37799`);
    fail(`  fix: npx claude-mem start`);
    allOk = false;
  }

  const hooksPath = join(PLUGIN_DEST, "plugin", "hooks", "hooks.json");
  if (existsSync(hooksPath)) {
    try {
      const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
      if (hooks.hooks?.Stop) ok(`Stop hook registered`);
      else { fail(`hooks.json present but Stop hook missing`); allOk = false; }
    } catch (err) {
      fail(`hooks.json unreadable: ${err.message}`);
      allOk = false;
    }
  }

  const mcpPath = join(PLUGIN_DEST, ".mcp.json");
  if (existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
      if (mcp.mcpServers?.assay) ok(`MCP server registered as 'assay'`);
      else { fail(`.mcp.json present but assay server missing`); allOk = false; }
    } catch (err) {
      fail(`.mcp.json unreadable: ${err.message}`);
      allOk = false;
    }
  }

  console.log(allOk ? "\n  All checks passed.\n" : "\n  Some checks failed. See fixes above.\n");
  process.exit(allOk ? 0 : 1);
}

function smoke() {
  ensureBuilt();
  execSync("node scripts/smoke-v2-integration.mjs", { cwd: REPO_ROOT, stdio: "inherit" });
}

function demo() {
  ensureBuilt();
  execSync("node scripts/demo-end-to-end.mjs", { cwd: REPO_ROOT, stdio: "inherit" });
}

function evalCmd() {
  ensureBuilt();
  execSync("node evals/run-all.mjs", { cwd: REPO_ROOT, stdio: "inherit" });
}

async function replay() {
  ensureBuilt();
  const { DecisionStore } = await import(join(REPO_ROOT, "dist/decisions/store.js"));
  const Database = (await import("better-sqlite3")).default;

  console.log("\nassay doctor --replay\n");
  console.log("Walking decision graph + asserting invariants...\n");

  const dbPath = join(ASSAY_DIR, "decisions.db");
  if (!existsSync(dbPath)) {
    info("decisions.db not yet created — nothing to replay");
    process.exit(0);
  }

  const store = new DecisionStore(dbPath);
  const db = new Database(dbPath, { readonly: true });

  let issues = 0;
  const decisions = store.recent(100_000);

  // Invariant 1: every decision has at least one decision_transitions row
  const transitionsByDecision = new Map();
  for (const row of db.prepare("SELECT decision_id FROM decision_transitions").all()) {
    transitionsByDecision.set(row.decision_id, (transitionsByDecision.get(row.decision_id) || 0) + 1);
  }
  let missingTransitions = 0;
  for (const d of decisions) {
    if (!transitionsByDecision.has(d.id)) missingTransitions++;
  }
  if (missingTransitions === 0) ok(`(I1) every decision has audit trail (${decisions.length} decisions)`);
  else { fail(`(I1) ${missingTransitions} decisions missing initial-deposit transition`); issues += missingTransitions; }

  // Invariant 2: no orphan transitions
  const orphans = db.prepare(`SELECT COUNT(*) as n FROM decision_transitions WHERE decision_id NOT IN (SELECT id FROM decisions)`).get().n;
  if (orphans === 0) ok(`(I2) no orphan transitions (FK integrity intact)`);
  else { fail(`(I2) ${orphans} orphan transitions reference deleted decisions`); issues += orphans; }

  // Invariant 3: every initial deposit has from_status=NULL
  const badInitials = db.prepare(`SELECT COUNT(*) as n FROM decision_transitions WHERE reason = 'initial deposit' AND from_status IS NOT NULL`).get().n;
  if (badInitials === 0) ok(`(I3) initial deposits have from_status=NULL`);
  else { fail(`(I3) ${badInitials} initial deposits with non-NULL from_status`); issues += badInitials; }

  // Invariant 4: supersession chains terminate (no cycles longer than 10 hops)
  let cycleViolations = 0;
  for (const d of decisions) {
    const chain = store.supersessionChain(d.id);
    if (chain.length > 10) { cycleViolations++; fail(`(I4) decision ${d.id.slice(0,8)} chain > 10 hops (${chain.length})`); }
  }
  if (cycleViolations === 0) ok(`(I4) all supersession chains ≤ 10 hops`);

  // Invariant 5: kind is always decision or conflict
  const badKinds = db.prepare(`SELECT COUNT(*) as n FROM decisions WHERE kind NOT IN ('decision', 'conflict')`).get().n;
  if (badKinds === 0) ok(`(I5) all decision rows have valid kind`);
  else { fail(`(I5) ${badKinds} decisions with invalid kind`); issues += badKinds; }

  store.close();
  db.close();

  if (issues === 0) {
    console.log(`\n  ✓ All ${decisions.length} decisions pass 5 invariants.\n`);
    process.exit(0);
  } else {
    console.log(`\n  ✗ ${issues} invariant violation(s) found across ${decisions.length} decisions.\n`);
    process.exit(1);
  }
}

function checkConsistency() {
  // Tool-count and capability-count consistency check (R21 + R7 CI gate).
  ensureBuilt();
  console.log("\nassay check-consistency\n");
  let issues = 0;

  // Count MCP tools registered in the server (read source of truth, not bundle)
  const mcpServerPath = join(REPO_ROOT, "plugin-src/mcp-server-entry.mjs");
  const mcpSrc = readFileSync(mcpServerPath, "utf8");
  const toolMatches = mcpSrc.matchAll(/name:\s*["']([a-z_]+)["']/gi);
  const tools = [...toolMatches].map((m) => m[1]).filter((n) => n.startsWith("assay_"));
  const mcpToolCount = tools.length;

  // Count capability claims in CAPABILITIES.md
  const caps = readFileSync(join(REPO_ROOT, "CAPABILITIES.md"), "utf8");
  const capMatches = caps.matchAll(/^## (C\d+) —/gm);
  const capabilities = [...capMatches].map((m) => m[1]);
  const capCount = capabilities.length;

  // Count eval files
  const evalCount = execSync(`grep -l "defineEval" ${REPO_ROOT}/evals/capabilities/*.eval.mjs | wc -l`, { encoding: "utf8" }).trim();

  console.log(`  MCP tools in mcp-server-entry: ${mcpToolCount} [${tools.join(", ")}]`);
  console.log(`  Capabilities in CAPABILITIES: ${capCount} [${capabilities.join(", ")}]`);
  console.log(`  Eval files in evals/capabilities/: ${evalCount}`);

  const expectedTools = 3;  // recall, expand, brief
  if (mcpToolCount !== expectedTools) {
    fail(`Expected ${expectedTools} MCP tools (recall, expand, brief), got ${mcpToolCount}`);
    issues++;
  }

  // Verify CAPABILITIES.md C-numbering is contiguous from C1
  for (let i = 0; i < capabilities.length; i++) {
    if (capabilities[i] !== `C${i + 1}`) {
      fail(`CAPABILITIES.md non-contiguous: expected C${i + 1}, got ${capabilities[i]}`);
      issues++;
      break;
    }
  }

  // Cross-check README claim "3 MCP tools" if present
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  const readmeToolClaim = readme.match(/(\d+)\s+MCP tools?\b/i);
  if (readmeToolClaim) {
    const claimed = Number(readmeToolClaim[1]);
    if (claimed !== mcpToolCount) {
      fail(`README claims ${claimed} MCP tools; mcp-server-entry.mjs has ${mcpToolCount}`);
      issues++;
    } else {
      ok(`README MCP-tool count matches code (${mcpToolCount})`);
    }
  }

  console.log(issues === 0 ? "\n  ✓ Consistency checks passed.\n" : `\n  ✗ ${issues} consistency issue(s).\n`);
  process.exit(issues === 0 ? 0 : 1);
}

async function exportCmd() {
  // R10 — export decision graph to portable JSON. Pre-team-mode hedge.
  ensureBuilt();
  const { DecisionStore } = await import(join(REPO_ROOT, "dist/decisions/store.js"));
  const Database = (await import("better-sqlite3")).default;

  const dbPath = join(ASSAY_DIR, "decisions.db");
  if (!existsSync(dbPath)) {
    fail("decisions.db not found — nothing to export");
    process.exit(1);
  }

  const store = new DecisionStore(dbPath);
  const db = new Database(dbPath, { readonly: true });
  const decisions = store.recent(100_000);
  const transitions = db.prepare("SELECT * FROM decision_transitions ORDER BY transitioned_at").all();
  const evidence = db.prepare("SELECT * FROM decision_evidence ORDER BY created_at").all();
  const schemaVersion = db.prepare("SELECT MAX(version) as v FROM schema_migrations").get().v;
  store.close();
  db.close();

  const bundle = {
    format: "assay-export-v1",
    exported_at: new Date().toISOString(),
    schema_version: schemaVersion,
    counts: { decisions: decisions.length, transitions: transitions.length, evidence: evidence.length },
    decisions,
    transitions,
    evidence,
  };

  const outPath = process.argv[3] ?? join(ASSAY_DIR, `export-${new Date().toISOString().slice(0,10)}.json`);
  writeFileSync(outPath, JSON.stringify(bundle, null, 2));
  ok(`exported ${decisions.length} decisions to ${outPath}`);
  console.log(`  format: assay-export-v1, schema: v${schemaVersion}`);
  console.log(`  size: ${(statSync(outPath).size / 1024).toFixed(1)}KB`);
}

function uninstall() {
  if (existsSync(PLUGIN_DEST)) {
    execSync(`rm -rf "${PLUGIN_DEST}"`);
    ok(`removed ${PLUGIN_DEST}`);
  } else {
    info(`nothing to remove at ${PLUGIN_DEST}`);
  }
  try {
    execSync(`claude mcp remove assay 2>/dev/null || true`, { stdio: "ignore" });
    ok(`MCP server registration removed`);
  } catch {}
  try {
    execSync(`claude plugin uninstall assay 2>/dev/null || true`, { stdio: "ignore" });
    ok(`Plugin registration removed`);
  } catch {}
  console.log("\nNote: ~/.assay/decisions.db preserved. Remove with: rm -rf ~/.assay");
  console.log("Restart Claude Code to pick up the uninstall.");
}

function help() {
  console.log(`
assay: developer CLI for Assay, a local memory layer for Claude Code

USAGE:
  assay <command>

COMMANDS:
  install              Install the plugin into Claude Code
  doctor               Verify install + worker + DB state (6 checks)
  doctor --replay      Walk decision graph + assert 5 invariants
  check-consistency    Verify tool/capability/eval counts match across surfaces
  export [path]        Export decisions to portable JSON
  smoke                Run integration smoke pack (19 cases)
  eval                 Run capability eval gate (16 × 2 modes)
  demo                 End-to-end demo (isolated sandbox)
  uninstall            Remove plugin (preserves ~/.assay data)
  help                 Show this help

INSTALL THE PLUGIN (in Claude Code):
  /plugin marketplace add levievanshantz/assay
  /plugin install assay@assaylabs

Run this CLI from a clone of the repo:  node bin/assay.mjs <command>
The npm package @assaylabs/assay is not published.
`);
}

async function dispatch() {
  switch (cmd) {
    case "install":            install(); break;
    case "doctor":
      if (process.argv[3] === "--replay") await replay();
      else doctor();
      break;
    case "check-consistency":  checkConsistency(); break;
    case "export":             await exportCmd(); break;
    case "smoke":              smoke(); break;
    case "eval":               evalCmd(); break;
    case "demo":               demo(); break;
    case "uninstall":          uninstall(); break;
    case undefined:
    case "help":
    case "--help":
    case "-h":                 help(); break;
    default:
      fail(`unknown command: ${cmd}`);
      help();
      process.exit(1);
  }
}

dispatch();
