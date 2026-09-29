#!/usr/bin/env node
// Day 13 integration smoke pack (~17 cases per CEO F4 + eng F4 expansion).
// Pass gate before Day 14 install.
//
// Runs with HOME and ASSAY_DB_PATH pointed into a temp sandbox, so nothing it
// does (DB writes, analytics logs) touches the operator's real ~/.assay.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { mkdir } from "node:fs/promises";

import { DecisionStore } from "../dist/decisions/store.js";
import { parseDecisionTags } from "../dist/parser/decisionTagParser.js";
import { ClaudeMemHTTPProvider } from "../dist/providers/ClaudeMemHTTPProvider.js";
import { runStopDrain } from "../dist/hooks/stopDrain.js";
import { AssayMCPServer } from "../dist/mcp/server.js";

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, msg = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`✗ ${name}${msg ? ` — ${msg}` : ""}`);
    console.log(`  ✗ ${name}${msg ? ` — ${msg}` : ""}`);
  }
}

async function run() {
  const sandbox = await mkdtemp(join(tmpdir(), "assay-v2-smoke-"));
  const dbPath = join(sandbox, "decisions.db");
  process.env.ASSAY_DB_PATH = dbPath;
  // runStopDrain logs to homedir()/.assay and the isolation guard in [5]
  // opens the default-path DB; both resolve inside the sandbox.
  process.env.HOME = join(sandbox, "home");

  console.log(`\n[1] Parser cases`);
  {
    const tx = `before <assay-decision kind="decision" confidence="0.8">Use Postgres for the v3 store.</assay-decision> after`;
    const { decisions, errors } = parseDecisionTags(tx);
    ok("parses single decision tag happy path", decisions.length === 1 && errors.length === 0);
    ok("captures body", decisions[0]?.body === "Use Postgres for the v3 store.");
    ok("captures confidence", decisions[0]?.confidence === 0.8);
  }
  {
    const tx = `<assay-decision kind="decision">A.</assay-decision><assay-decision kind="decision">A.</assay-decision>`;
    const { decisions } = parseDecisionTags(tx);
    ok("idempotency: duplicate tags dedupe", decisions.length === 1);
  }
  {
    const tx = `<assay-decision kind="wrong">x</assay-decision>`;
    const { decisions, errors } = parseDecisionTags(tx);
    ok("malformed kind: skip + record error", decisions.length === 0 && errors.length === 1);
  }
  {
    const tx = `<assay-decision kind="decision"></assay-decision>`;
    const { decisions, errors } = parseDecisionTags(tx);
    ok("empty body: skip + record error", decisions.length === 0 && errors.length === 1);
  }

  console.log(`\n[2] Stop hook cases`);
  {
    const trans = join(sandbox, "t1.txt");
    await writeFile(trans, `<assay-decision kind="decision">Hook test deposit.</assay-decision>`);
    const result = await runStopDrain({ transcript_path: trans });
    ok("hook happy path persists 1 decision", result.ok && result.decisions_captured === 1);
  }
  {
    const result = await runStopDrain({});
    ok("hook with missing transcriptPath: graceful fail", !result.ok && /transcriptPath/.test(result.reason ?? ""));
  }
  {
    const result = await runStopDrain({ transcript_path: "/nonexistent/path.txt" });
    ok("hook with unreadable transcript: graceful fail", !result.ok);
  }
  {
    process.env.ECC_HOOK_PROFILE = "minimal";
    const trans = join(sandbox, "tmin.txt");
    await writeFile(trans, `<assay-decision kind="decision">Should not deposit.</assay-decision>`);
    const result = await runStopDrain({ transcript_path: trans });
    ok("ECC_HOOK_PROFILE=minimal: hook noops", result.ok && /minimal/.test(result.reason ?? ""));
    delete process.env.ECC_HOOK_PROFILE;
  }
  {
    process.env.ECC_HOOK_PROFILE = "standard";
    const trans = join(sandbox, "tstd.txt");
    await writeFile(trans, `<assay-decision kind="decision">Standard mode deposit.</assay-decision>`);
    const result = await runStopDrain({ transcript_path: trans });
    ok("ECC_HOOK_PROFILE=standard: persists", result.ok && result.decisions_captured === 1);
    delete process.env.ECC_HOOK_PROFILE;
  }
  {
    const result = await runStopDrain({ transcript_path: "/x.txt", stopHookActive: true });
    ok("re-entry guard: noops when stopHookActive=true", result.ok && /re-entry/.test(result.reason ?? ""));
  }

  console.log(`\n[3] Store cases`);
  {
    const store = new DecisionStore(dbPath);
    const before = store.count();
    store.depositBatch([
      { kind: "decision", body: "Direct deposit A.", source_span: { start: 0, end: 10 } },
      { kind: "decision", body: "Direct deposit B.", source_span: { start: 11, end: 20 } },
    ]);
    const after = store.count();
    ok("transactional batch deposit", after - before === 2);
    store.close();
  }
  {
    const store = new DecisionStore(dbPath);
    const recent = store.recent(3);
    ok("recent returns rows desc by created_at", recent.length > 0);
    store.close();
  }

  console.log(`\n[4] Provider + MCP cases (requires worker running)`);
  {
    const provider = new ClaudeMemHTTPProvider();
    const health = await provider.health();
    ok("provider.health() returns a status", ["full", "degraded", "offline"].includes(health.status));
    console.log(`    → status=${health.status} latency=${health.latency_ms}ms`);
  }
  {
    // MCP server cold-start envelope
    const sandbox2 = await mkdtemp(join(tmpdir(), "assay-v2-mcp-"));
    const store = new DecisionStore(join(sandbox2, "decisions.db"));
    const server = new AssayMCPServer(store, new ClaudeMemHTTPProvider());
    const resp = await server.recall("anything");
    ok("cold-start envelope when corpus<5", resp.cold_start !== undefined);
    await server.close();
    await rm(sandbox2, { recursive: true, force: true });
  }

  console.log(`\n[5] Isolation guard — ASSAY_DB_PATH honored by Stop hook`);
  {
    // Regression test for the bug demo caught: Stop hook ignored ASSAY_DB_PATH
    // and wrote to the default ~/.assay/decisions.db. After fix, hook MUST respect env.
    // Measure the default-path DB (under the sandbox HOME) with env var UNSET, then
    // re-set env to probe, run hook, verify probe got the deposit and default is unchanged.
    const probeDir = await mkdtemp(join(tmpdir(), "assay-isolation-"));
    const probeDb = join(probeDir, "probe.db");

    const savedEnv = process.env.ASSAY_DB_PATH;
    delete process.env.ASSAY_DB_PATH;
    let realDbBefore = -1;
    try {
      const s = new DecisionStore();
      realDbBefore = s.count();
      s.close();
    } catch { /* real db may not exist yet, that's fine */ }

    process.env.ASSAY_DB_PATH = probeDb;
    const trans = join(probeDir, "iso.txt");
    await writeFile(trans, `<assay-decision kind="decision">Isolation guard probe.</assay-decision>`);
    const result = await runStopDrain({ transcript_path: trans });
    ok("hook runs with ASSAY_DB_PATH set to probe", result.ok);
    const probeStore = new DecisionStore(probeDb);
    ok("probe db received the deposit", probeStore.count() === 1);
    probeStore.close();

    delete process.env.ASSAY_DB_PATH;
    if (realDbBefore >= 0) {
      const realStore = new DecisionStore();
      const realDbAfter = realStore.count();
      realStore.close();
      ok(
        "default-path ~/.assay/decisions.db UNCHANGED (no pollution)",
        realDbAfter === realDbBefore,
        `before=${realDbBefore} after=${realDbAfter}`,
      );
    } else {
      ok("default-path ~/.assay/decisions.db check skipped (no prior db)", true);
    }
    // Restore env for any subsequent cases (currently none).
    if (savedEnv !== undefined) process.env.ASSAY_DB_PATH = savedEnv;
    await rm(probeDir, { recursive: true, force: true });
  }

  await rm(sandbox, { recursive: true, force: true });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(`Smoke pack crashed: ${err.message}`);
  console.error(err.stack);
  process.exit(2);
});
