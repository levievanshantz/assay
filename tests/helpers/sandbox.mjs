// Throwaway HOME directories. Everything the plugin writes (decisions.db,
// analytics logs, errors.jsonl) goes under homedir()/.assay, so every test
// that runs plugin code points HOME at one of these, never at the real one.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Nothing listens here: the claude-mem provider reports "offline" at once
// instead of reaching a real worker on this machine.
export const CLOSED_PORT = "1";

export function makeSandbox(label = "assay-test") {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  const home = join(dir, "home");
  return {
    dir,
    home,
    dbPath: join(home, ".assay", "decisions.db"),
    /** Env for a child process: sandboxed HOME, offline claude-mem, no DB override. */
    env(extra = {}) {
      const env = { ...process.env };
      delete env.ASSAY_DB_PATH;
      delete env.ECC_HOOK_PROFILE;
      delete env.ECC_DISABLED_HOOKS;
      Object.assign(env, { HOME: home, CLAUDE_MEM_WORKER_PORT: CLOSED_PORT }, extra);
      for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
      return env;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * For in-process tests: point this process's HOME at a sandbox before any
 * plugin code calls os.homedir(). Returns the sandbox.
 */
export function sandboxThisProcess(label) {
  const sb = makeSandbox(label);
  process.env.HOME = sb.home;
  process.env.CLAUDE_MEM_WORKER_PORT = CLOSED_PORT;
  delete process.env.ASSAY_DB_PATH;
  delete process.env.ECC_HOOK_PROFILE;
  delete process.env.ECC_DISABLED_HOOKS;
  return sb;
}
