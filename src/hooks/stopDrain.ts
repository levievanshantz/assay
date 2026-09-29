// Stop hook for AssayLabs decision-tag drain.
// Registered in ECC's hooks/hooks.json as `stop:zz-assay-decision-drain`
// so lexicographic ordering puts it after ECC's stop:session-end and
// after claude-mem's summarize hook.
//
// Three-tier rescue spec (per CEO review F6):
//   Tier 1 (transient: SQLITE_BUSY, network timeout) → retry with backoff
//   Tier 2 (recoverable: malformed XML, missing attr, EACCES) → log + skip + continue
//   Tier 3 (fatal: disk full, schema mismatch) → write errors.jsonl + stderr "AssayLabs hook degraded"
//
// Profile matrix (per eng review F2):
//   minimal: noop (skip entirely)
//   standard (default): capture + parse + persist
//   strict: capture + parse + persist + immediate conflict notification

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

import { parseDecisionTags } from "../parser/decisionTagParser.js";
import { DecisionStore } from "../decisions/store.js";

type Profile = "minimal" | "standard" | "strict";

export interface StopHookInput {
  /** Hook input shape from Claude Code Stop event. */
  transcript_path?: string;
  transcriptPath?: string;
  session_id?: string;
  stopHookActive?: boolean;
}

export interface StopHookResult {
  ok: boolean;
  profile: Profile;
  decisions_captured?: number;
  parse_errors?: number;
  reason?: string;
}

function profile(): Profile {
  const p = process.env.ECC_HOOK_PROFILE;
  if (p === "minimal" || p === "strict") return p;
  return "standard";
}

function isDisabled(): boolean {
  const disabled = process.env.ECC_DISABLED_HOOKS ?? "";
  return disabled.split(",").map((s) => s.trim()).includes("stop:zz-assay-decision-drain");
}

async function appendJsonl(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n", "utf8");
}

function logPath(name: string): string {
  return join(homedir(), ".assay", name);
}

export async function runStopDrain(input: StopHookInput): Promise<StopHookResult> {
  const prof = profile();

  if (isDisabled()) {
    return { ok: true, profile: prof, reason: "disabled via ECC_DISABLED_HOOKS" };
  }
  if (prof === "minimal") {
    return { ok: true, profile: prof, reason: "minimal profile: hook noop" };
  }
  if (input.stopHookActive === true) {
    // Re-entry guard: another Stop hook is already in flight.
    return { ok: true, profile: prof, reason: "stop hook re-entry guard" };
  }

  const transcriptPath = input.transcript_path ?? input.transcriptPath;
  if (!transcriptPath) {
    await appendJsonl(logPath("analytics/tool-usage.jsonl"), {
      ts: Date.now(),
      tool: "stop-drain",
      outcome: "parse-failed",
      reason: "missing transcriptPath",
    });
    return { ok: false, profile: prof, reason: "missing transcriptPath" };
  }

  let transcript: string;
  try {
    transcript = await readFile(transcriptPath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Tier 2: log + skip
    await appendJsonl(logPath("analytics/tool-usage.jsonl"), {
      ts: Date.now(),
      tool: "stop-drain",
      outcome: "parse-failed",
      reason: `read failed: ${msg}`,
    });
    return { ok: false, profile: prof, reason: `read failed: ${msg}` };
  }

  // Per F4 smoke pack: handle transcript >8KB (does NOT truncate inside hook;
  // the 8KB cap is on what gets injected via SessionStart, not what's parsed).
  const { decisions, errors } = parseDecisionTags(transcript);

  for (const e of errors) {
    // Tier 2: log each parse error, skip the offending tag, continue.
    await appendJsonl(logPath("analytics/tool-usage.jsonl"), {
      ts: Date.now(),
      tool: "stop-drain",
      outcome: "parse-failed",
      reason: e.message,
      span: e.span,
    });
  }

  if (decisions.length === 0) {
    await appendJsonl(logPath("analytics/tool-usage.jsonl"), {
      ts: Date.now(),
      tool: "stop-drain",
      outcome: "no-decisions",
      profile: prof,
    });
    return { ok: true, profile: prof, decisions_captured: 0, parse_errors: errors.length };
  }

  let store: DecisionStore | null = null;
  try {
    store = new DecisionStore();
    let depositedIds: string[] = [];
    let lastErr: unknown = null;
    // Tier 1: retry transient SQLITE_BUSY with exponential backoff.
    // 6 attempts with a wait before each retry: 100/200/400/800/1600 ms, 3.1 s
    // of backoff in total. Each attempt also blocks up to 5 s inside SQLite
    // first (better-sqlite3's default busy timeout) before it throws
    // SQLITE_BUSY. A lock held through all of that escalates to tier 3.
    const RETRY_WAITS_MS = [100, 200, 400, 800, 1600];
    const MAX_ATTEMPTS = RETRY_WAITS_MS.length + 1;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        depositedIds = store.depositBatch(decisions, {
          session_id: input.session_id,
          transcript_path: transcriptPath,
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (/SQLITE_BUSY|database is locked/i.test(msg)) {
          if (attempt === MAX_ATTEMPTS - 1) break; // bail to tier 3
          await new Promise((r) => setTimeout(r, RETRY_WAITS_MS[attempt]));
          continue;
        }
        // Non-transient: bail to tier 3 immediately
        throw err;
      }
    }
    if (lastErr) throw lastErr;

    await appendJsonl(logPath("analytics/tool-usage.jsonl"), {
      ts: Date.now(),
      tool: "stop-drain",
      outcome: "ok",
      profile: prof,
      decisions_captured: depositedIds.length,
      parse_errors: errors.length,
    });

    if (prof === "strict") {
      const conflicts = decisions.filter((d) => d.kind === "conflict");
      if (conflicts.length > 0) {
        process.stderr.write(
          `[assay] strict mode: ${conflicts.length} conflict(s) captured this session\n`,
        );
      }
    }

    return {
      ok: true,
      profile: prof,
      decisions_captured: depositedIds.length,
      parse_errors: errors.length,
    };
  } catch (err) {
    // Tier 3: fatal — log to errors.jsonl AND stderr
    const msg = err instanceof Error ? err.message : String(err);
    await appendJsonl(logPath("errors.jsonl"), {
      ts: Date.now(),
      source: "stop-drain",
      reason: msg,
      transcript_path: transcriptPath,
    });
    process.stderr.write(`[assay] hook degraded: ${msg}\n`);
    return { ok: false, profile: prof, reason: msg };
  } finally {
    store?.close();
  }
}
