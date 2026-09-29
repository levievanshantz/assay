// Assay Stop hook bundle entry. esbuild bundles this file (+ all imports
// except better-sqlite3, which is external and resolved at runtime from
// plugin/node_modules/) into plugin/scripts/stop-hook.cjs.
//
// Reads the Stop hook input JSON from stdin, invokes runStopDrain(), writes
// a single-line JSON result to stdout. Exits 0 on success, 1 on tier-3 failure.
//
// Run as a script (node stop-hook.cjs) it does the above. require()d, it only
// exports runStopDrain / parseDecisionTags / main, so tests can load the built
// bundle and exercise its code without it reading stdin or exiting.

import { runStopDrain } from "../dist/hooks/stopDrain.js";
import { parseDecisionTags } from "../dist/parser/decisionTagParser.js";

export { runStopDrain, parseDecisionTags };

async function readStdin() {
  return new Promise((resolveP) => {
    let buf = "";
    if (process.stdin.isTTY) return resolveP("{}");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => resolveP(buf || "{}"));
    setTimeout(() => resolveP(buf || "{}"), 5_000);
  });
}

export async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch {
    // Hook input parse failure is non-fatal; we'll just have empty input.
  }

  try {
    const result = await runStopDrain(input);
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true, assay: result }) + "\n");
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[assay] hook crashed: ${err.message}\n`);
    process.stdout.write('{"continue":true,"suppressOutput":true}\n');
    process.exit(1);
  }
}

if (typeof require !== "undefined" && require.main === module) main();
