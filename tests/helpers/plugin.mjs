// Paths and loaders for the BUILT plugin (plugin/scripts/*.cjs plus the
// vendored plugin/node_modules). Uses only node: builtins, so the bundle tests
// can run on a machine that never ran `npm install` (see the plugin-bundle CI job).

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PLUGIN_DIR = join(REPO_ROOT, "plugin");
export const STOP_HOOK = join(PLUGIN_DIR, "scripts", "stop-hook.cjs");
export const MCP_SERVER = join(PLUGIN_DIR, "scripts", "mcp-server.cjs");

/** require() resolving from plugin/scripts/, i.e. against the vendored node_modules. */
export const pluginRequire = createRequire(STOP_HOOK);

// The vendored better-sqlite3 binary is prebuilt for one platform and Node ABI.
export const VENDORED_TARGET = { platform: "darwin", arch: "arm64", abi: "127" };

/**
 * Whether the vendored native module loads under this Node, checked in a child
 * process so a failed dlopen cannot poison the test process.
 * Returns { ok, reason }.
 */
export function vendoredSqliteStatus() {
  const scratch = mkdtempSync(join(tmpdir(), "assay-probe-"));
  try {
    const r = spawnSync(
      process.execPath,
      [
        "-e",
        `const D = require(${JSON.stringify(join(PLUGIN_DIR, "node_modules", "better-sqlite3"))});` +
          `const db = new D(":memory:"); db.prepare("select 1").get(); db.close();`,
      ],
      { encoding: "utf8", env: { ...process.env, HOME: scratch } },
    );
    if (r.status === 0) return { ok: true, reason: "" };
    return { ok: false, reason: (r.stderr || "").split("\n").find((l) => l.trim()) ?? "load failed" };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function runtimeTarget() {
  return { platform: process.platform, arch: process.arch, abi: process.versions.modules };
}

export function isVendoredTarget() {
  const t = runtimeTarget();
  return (
    t.platform === VENDORED_TARGET.platform &&
    t.arch === VENDORED_TARGET.arch &&
    t.abi === VENDORED_TARGET.abi
  );
}

/**
 * node:test `skip` value for tests that execute the built bundle: false when
 * the vendored binary loads; a reason string when it cannot load because this
 * runner is not the platform it was built for. On the vendored platform a load
 * failure is NOT skipped — it throws, so the test fails.
 */
export function bundleSkipReason() {
  const status = vendoredSqliteStatus();
  if (status.ok) return false;
  if (isVendoredTarget()) {
    throw new Error(`vendored better-sqlite3 failed to load on its own target platform: ${status.reason}`);
  }
  if (process.env.ASSAY_BUNDLE_TESTS_REQUIRED === "1") {
    // Set by the plugin-bundle CI job: skipping there would hide the failure.
    throw new Error(`bundle tests required but the vendored better-sqlite3 cannot load here: ${status.reason}`);
  }
  const t = runtimeTarget();
  return (
    `vendored better-sqlite3 is ${VENDORED_TARGET.platform}-${VENDORED_TARGET.arch} ` +
    `Node ABI ${VENDORED_TARGET.abi}; this runner is ${t.platform}-${t.arch} ABI ${t.abi}`
  );
}

/** Open a decisions.db with the vendored better-sqlite3 (read-only). */
export function openDb(path) {
  const Database = pluginRequire("better-sqlite3");
  return new Database(path, { readonly: true, fileMustExist: true });
}

/** Rows in a stable order, with the fields the equivalence check compares. */
export function readDecisionRows(dbPath) {
  const db = openDb(dbPath);
  try {
    return db
      .prepare(
        `SELECT kind, confidence, supersedes_raw, layer, body
           FROM decisions ORDER BY created_at, rowid`,
      )
      .all();
  } finally {
    db.close();
  }
}

/**
 * Run the built Stop hook exactly as Claude Code does: `node stop-hook.cjs`
 * with the hook input JSON on stdin. Returns the parsed stdout line.
 */
export function runStopHook({ script = STOP_HOOK, env, input }) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  const line = (r.stdout || "").trim().split("\n").pop() ?? "";
  let parsed = null;
  try {
    parsed = JSON.parse(line);
  } catch {
    // leave null; caller asserts
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, result: parsed };
}
