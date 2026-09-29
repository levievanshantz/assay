// Shared eval harness. Each capability eval imports `defineEval` and
// returns a result object that run-all.mjs aggregates.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

export const MODES = {
  VERIFY: "verify",
  ADVERSARIAL: "adversarial",
};

export class Sandbox {
  constructor(dir, dbPath) {
    this.dir = dir;
    this.dbPath = dbPath;
    this.priorEnv = {};
  }

  setEnv(key, value) {
    this.priorEnv[key] = process.env[key];
    if (value === null || value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  async cleanup() {
    for (const [k, v] of Object.entries(this.priorEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { await rm(this.dir, { recursive: true, force: true }); } catch {}
  }
}

export async function makeSandbox(prefix = "assay-eval-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const dbPath = join(dir, "decisions.db");
  const sandbox = new Sandbox(dir, dbPath);
  sandbox.setEnv("ASSAY_DB_PATH", dbPath);
  return sandbox;
}

/**
 * defineEval(opts) — declarative eval shape.
 *
 * opts = {
 *   id: 'C1', name: 'tag capture',
 *   verify: async ({ sandbox }) => { ... return { pass, details } },
 *   adversarial: async ({ sandbox }) => { ... return { pass, details } },
 * }
 *
 * Each phase MUST return { pass: bool, details: string|object }.
 * `details` is shown on failure.
 */
export function defineEval(opts) {
  return {
    id: opts.id,
    name: opts.name,
    capability: opts.capability ?? opts.id,
    async run({ mode }) {
      const phase = mode === MODES.VERIFY ? opts.verify : opts.adversarial;
      if (!phase) {
        return { id: opts.id, mode, skipped: true, reason: `no ${mode} phase` };
      }
      const sandbox = await makeSandbox(`assay-eval-${opts.id.toLowerCase()}-`);
      const started = Date.now();
      try {
        const result = await phase({ sandbox });
        return {
          id: opts.id,
          name: opts.name,
          mode,
          pass: !!result.pass,
          duration_ms: Date.now() - started,
          details: result.details,
        };
      } catch (err) {
        return {
          id: opts.id,
          name: opts.name,
          mode,
          pass: false,
          duration_ms: Date.now() - started,
          details: { error: err.message, stack: err.stack },
        };
      } finally {
        await sandbox.cleanup();
      }
    },
  };
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
