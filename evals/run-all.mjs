#!/usr/bin/env node
// Run all capability evals, both verify + adversarial mode by default.
//
// Usage:
//   node evals/run-all.mjs                # both modes
//   node evals/run-all.mjs --mode=verify  # verify only
//   node evals/run-all.mjs --mode=adversarial
//
// Reports land in evals/reports/<date>-claude-<mode>.json.

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MODES } from "./lib/harness.mjs";
import * as a from "./capabilities/c1-c5-capture-and-rescue.eval.mjs";
import * as b from "./capabilities/c6-c8-mcp-recall-and-brief.eval.mjs";
import * as c from "./capabilities/c9-c14-storage-and-isolation.eval.mjs";
import * as d from "./capabilities/c15-concurrent-deposits.eval.mjs";
import * as e from "./capabilities/c16-coverage-gaps.eval.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, "reports");

const ALL_EVALS = [
  a.C1, a.C2, a.C3, a.C4, a.C5,
  b.C6, b.C7, b.C8,
  c.C9, c.C10, c.C11, c.C12, c.C13, c.C14,
  d.C15,
  e.C16,
];

function parseMode() {
  const arg = process.argv.find(a => a.startsWith("--mode="));
  if (!arg) return null;
  const v = arg.split("=")[1];
  if (v === MODES.VERIFY || v === MODES.ADVERSARIAL) return v;
  throw new Error(`unknown mode: ${v}`);
}

async function runMode(mode) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`Running ${ALL_EVALS.length} evals in ${mode.toUpperCase()} mode`);
  console.log("═".repeat(70));

  const results = [];
  for (const ev of ALL_EVALS) {
    const r = await ev.run({ mode });
    results.push(r);
    if (r.skipped) {
      console.log(`  ⊖ ${r.id} ${ev.name} — skipped (${r.reason})`);
    } else if (r.pass) {
      console.log(`  ✓ ${r.id} ${ev.name} (${r.duration_ms}ms)`);
    } else {
      console.log(`  ✗ ${r.id} ${ev.name} (${r.duration_ms}ms)`);
      console.log(`      ${typeof r.details === "string" ? r.details : JSON.stringify(r.details)}`);
    }
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass && !r.skipped).length;
  const skipped = results.filter(r => r.skipped).length;
  console.log("─".repeat(70));
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log("─".repeat(70));

  return { mode, results, passed, failed, skipped };
}

async function writeReport(report, model = "claude") {
  await mkdir(REPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = join(REPORTS_DIR, `${ts}-${model}-${report.mode}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(`  → report: ${file}`);
  return file;
}

async function main() {
  const mode = parseMode();
  const modes = mode ? [mode] : [MODES.VERIFY, MODES.ADVERSARIAL];

  const allReports = [];
  for (const m of modes) {
    const r = await runMode(m);
    await writeReport(r);
    allReports.push(r);
  }

  // Composite gate: every capability must pass in every mode that ran.
  const totalFailed = allReports.reduce((a, r) => a + r.failed, 0);
  if (totalFailed > 0) {
    console.log(`\n  ✗ GATE FAILED — ${totalFailed} eval(s) failed.\n`);
    process.exit(1);
  } else {
    console.log(`\n  ✓ GATE PASSED — all evals green in ${modes.join(" + ")} mode${modes.length > 1 ? "s" : ""}.\n`);
  }
}

main().catch((err) => {
  console.error(`\nEVAL HARNESS CRASHED: ${err.message}`);
  console.error(err.stack);
  process.exit(2);
});
