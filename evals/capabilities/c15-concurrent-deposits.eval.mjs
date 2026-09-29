// C15 — concurrent deposit stress (Codex round 1 coverage gap).
// Multiple worker processes writing to the same decisions.db simultaneously
// must not corrupt the audit trail or lose decisions silently.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { defineEval, assert } from "../lib/harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");

// Spawn a child node process that ingests a single tag via runStopDrain.
function spawnDepositor(transcriptPath, dbPath) {
  return new Promise((res, rej) => {
    const child = spawn("node", ["--input-type=module", "-e", `
      import { runStopDrain } from "${PROJECT_ROOT}/dist/hooks/stopDrain.js";
      const result = await runStopDrain({ transcript_path: "${transcriptPath}" });
      process.stdout.write(JSON.stringify(result));
    `], { env: { ...process.env, ASSAY_DB_PATH: dbPath } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", (code) => {
      if (code !== 0) return rej(new Error(`child exited ${code}: ${err}`));
      try { res(JSON.parse(out)); }
      catch (e) { rej(new Error(`bad stdout: ${out} | err: ${err}`)); }
    });
  });
}

export const C15 = defineEval({
  id: "C15",
  name: "concurrent deposits don't corrupt or silently drop",
  async verify({ sandbox }) {
    // 10 parallel processes each depositing a unique decision
    const N = 10;
    const transcripts = [];
    for (let i = 0; i < N; i++) {
      const t = join(sandbox.dir, `c${i}.txt`);
      await writeFile(t, `<assay-decision kind="decision" confidence="0.5">Concurrent deposit ${i} from worker.</assay-decision>`);
      transcripts.push(t);
    }

    const results = await Promise.all(transcripts.map(t => spawnDepositor(t, sandbox.dbPath)));

    const okCount = results.filter(r => r.ok).length;
    const totalCaptured = results.reduce((a, r) => a + (r.decisions_captured ?? 0), 0);
    assert(okCount >= 8, `expected >=8 of 10 hook runs ok (allowing 2 SQLITE_BUSY retries to fail), got ${okCount}`);
    assert(totalCaptured >= 8, `expected >=8 decisions captured across workers, got ${totalCaptured}`);

    // DB integrity check: row count matches captured, audit trail intact
    const db = new Database(sandbox.dbPath);
    const decisionCount = db.prepare("SELECT COUNT(*) as n FROM decisions").get().n;
    const transitionCount = db.prepare("SELECT COUNT(*) as n FROM decision_transitions").get().n;
    const orphans = db.prepare("SELECT COUNT(*) as n FROM decision_transitions WHERE decision_id NOT IN (SELECT id FROM decisions)").get().n;
    db.close();

    assert(decisionCount === totalCaptured, `row count ${decisionCount} != captured ${totalCaptured}`);
    assert(transitionCount === totalCaptured, `transitions ${transitionCount} != captured ${totalCaptured}`);
    assert(orphans === 0, `found ${orphans} orphan transitions (FK violation)`);

    return { pass: true, details: { workers: N, ok: okCount, captured: totalCaptured, transitions: transitionCount, orphans: 0 } };
  },
  async adversarial({ sandbox }) {
    // 20 parallel processes, double the contention.
    const N = 20;
    const transcripts = [];
    for (let i = 0; i < N; i++) {
      const t = join(sandbox.dir, `a${i}.txt`);
      await writeFile(t, `<assay-decision kind="decision">Adversarial concurrent ${i}.</assay-decision>`);
      transcripts.push(t);
    }
    const results = await Promise.all(transcripts.map(t => spawnDepositor(t, sandbox.dbPath)));
    const okCount = results.filter(r => r.ok).length;
    const totalCaptured = results.reduce((a, r) => a + (r.decisions_captured ?? 0), 0);
    // With 20 parallel + 5s retry budget, expect at LEAST 15 to succeed
    assert(okCount >= 15, `at 20-way contention expected >=15 ok, got ${okCount} (likely SQLITE_BUSY exhaustion — retry window may need tuning)`);
    const db = new Database(sandbox.dbPath);
    const orphans = db.prepare("SELECT COUNT(*) as n FROM decision_transitions WHERE decision_id NOT IN (SELECT id FROM decisions)").get().n;
    db.close();
    assert(orphans === 0, `${orphans} orphan transitions under high contention — atomicity broken`);
    return { pass: true, details: { workers: N, ok: okCount, captured: totalCaptured, orphans: 0 } };
  },
});
