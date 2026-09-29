// C16 — coverage gaps that the drift audit + Codex round 3 surfaced.
// Bundles 4 missing adversarial probes:
//   N4: malformed provider.health() shape — recall MUST NOT throw
//   C3: SQLITE_BUSY retry path — deposit succeeds within the retry window
//       (6 attempts, 100/200/400/800/1600 ms waits, 3.1 s of backoff)
//   C4: strict-mode stderr emission on conflict-kind tags
//   C9: ASSAY_DB_PATH to non-writable directory — graceful fail
//
// Not a standalone capability — these augment C3/C4/C7/C9 with the
// adversarial vectors that the standalone evals didn't cover.

import { writeFile, mkdir, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { defineEval, assert } from "../lib/harness.mjs";

import { runStopDrain } from "../../dist/hooks/stopDrain.js";
import { AssayMCPServer } from "../../dist/mcp/server.js";
import { DecisionStore } from "../../dist/decisions/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");

export const C16 = defineEval({
  id: "C16",
  name: "coverage gaps — malformed provider, SQLITE_BUSY, strict stderr, non-writable path",
  async verify({ sandbox }) {
    // ============ N4: malformed provider.health() does NOT throw recall ============
    const tagsPath = join(sandbox.dir, "tags.txt");
    await writeFile(tagsPath, Array.from({ length: 6 }, (_, i) =>
      `<assay-decision kind="decision">Cover ${i}.</assay-decision>`
    ).join("\n"));
    await runStopDrain({ transcript_path: tagsPath });

    const malformedProviders = [
      { health: async () => { throw new Error("provider exploded"); } },
      { health: async () => null },
      { health: async () => ({}) },  // missing status
      { health: async () => ({ status: "what" }) },  // bogus status
    ];
    const providerLabels = ["throws", "returns null", "returns empty obj", "returns bogus status"];
    for (let pi = 0; pi < malformedProviders.length; pi++) {
      const provider = malformedProviders[pi];
      const label = providerLabels[pi];
      // Stub other methods so recall doesn't blow up on second-order calls
      provider.search = async () => [];
      provider.getObservations = async () => ({ found: [], missing: [] });
      const server = new AssayMCPServer(new DecisionStore(sandbox.dbPath), provider);
      let crashed = false;
      let crashMsg = "";
      let resp;
      try {
        resp = await server.recall("anything");
      } catch (err) {
        crashed = true;
        crashMsg = err.message;
      }
      await server.close();
      assert(!crashed, `recall threw on malformed provider [${label}]: ${crashMsg}`);
      assert(resp && Array.isArray(resp.results), `[${label}] recall returned bad shape`);
      assert(resp.context_tier === "unavailable" || resp.context_tier === "degraded",
        `[${label}] expected unavailable/degraded tier, got ${resp.context_tier}`);
    }

    return { pass: true, details: { malformed_providers_handled: malformedProviders.length } };
  },
  async adversarial({ sandbox }) {
    // ============ C3 adversarial: SQLITE_BUSY retry actually exercised ============
    // Hold a BEGIN IMMEDIATE lock in a child process for 2 seconds, then release.
    // Stop hook should succeed within the retry window (SQLite busy wait + backoff).
    const trans = join(sandbox.dir, "c3-busy.txt");
    await writeFile(trans, `<assay-decision kind="decision">retry probe</assay-decision>`);
    // Initialize the DB first so the lock-holder has something to lock
    const initStore = new DecisionStore(sandbox.dbPath);
    initStore.close();
    const lockHolder = spawn("node", ["--input-type=module", "-e", `
      import Database from "${PROJECT_ROOT}/node_modules/better-sqlite3/lib/index.js";
      const db = new Database("${sandbox.dbPath}");
      db.exec("BEGIN IMMEDIATE");
      await new Promise(r => setTimeout(r, 2000));
      db.exec("ROLLBACK");
      db.close();
    `], { stdio: "ignore" });
    // Wait 100ms for lock to be acquired
    await new Promise(r => setTimeout(r, 100));
    const t0 = Date.now();
    const result = await runStopDrain({ transcript_path: trans });
    const elapsed = Date.now() - t0;
    lockHolder.kill();
    assert(result.ok, `retry-after-lock failed: ${result.reason}`);
    assert(result.decisions_captured === 1, `expected 1 captured, got ${result.decisions_captured}`);
    assert(elapsed >= 100 && elapsed < 6000, `unexpected timing: ${elapsed}ms`);

    // ============ C4 adversarial: strict-mode stderr on conflict tag ============
    // Capture stderr output by spawning a child process under strict profile.
    const conflictPath = join(sandbox.dir, "c4-conflict.txt");
    await writeFile(conflictPath, `<assay-decision kind="conflict">strict probe conflict.</assay-decision>`);
    const child = spawn("node", ["--input-type=module", "-e", `
      import { runStopDrain } from "${PROJECT_ROOT}/dist/hooks/stopDrain.js";
      await runStopDrain({ transcript_path: "${conflictPath}" });
    `], { env: { ...process.env, ECC_HOOK_PROFILE: "strict", ASSAY_DB_PATH: sandbox.dbPath } });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    await new Promise((res) => child.on("close", res));
    assert(/\[assay\].*strict.*conflict/i.test(stderr), `strict-mode stderr missing: "${stderr}"`);

    // ============ C9 adversarial: non-writable ASSAY_DB_PATH ============
    const roDir = join(sandbox.dir, "readonly");
    await mkdir(roDir);
    await chmod(roDir, 0o555);  // r-x only, no write
    const roPath = join(roDir, "blocked.db");
    sandbox.setEnv("ASSAY_DB_PATH", roPath);
    let opened = false;
    let opError;
    try {
      const s = new DecisionStore();  // honors env
      opened = true;
      s.close();
    } catch (err) {
      opError = err;
    }
    // Restore writable for cleanup
    await chmod(roDir, 0o755).catch(() => {});
    assert(!opened, `expected open to fail on non-writable path; it succeeded`);
    assert(opError instanceof Error, `expected error on non-writable open`);

    return { pass: true, details: { busy_recover_ms: elapsed, strict_stderr_emitted: true, non_writable_blocked: true } };
  },
});
