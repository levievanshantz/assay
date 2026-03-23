#!/usr/bin/env node

/**
 * Apply a named preset to the Assay feature toggles.
 *
 * Usage:
 *   node scripts/assay-preset.mjs minimal    # sync only
 *   node scripts/assay-preset.mjs standard   # sync + extraction (ollama) + accumulation
 *   node scripts/assay-preset.mjs full       # everything on, hygiene at 8 AM
 */

import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __scripts_dirname = dirname(__filename);
const CONFIG_PATH = resolve(__scripts_dirname, "../.assay.config.json");

const PRESETS = {
  minimal: {
    sync: { enabled: true },
    extraction: { enabled: false, mode: "ollama" },
    accumulation: { enabled: false },
    hygiene: { schedule: "off" },
  },
  standard: {
    sync: { enabled: true },
    extraction: { enabled: true, mode: "ollama" },
    accumulation: { enabled: true },
    hygiene: { schedule: "off" },
  },
  full: {
    sync: { enabled: true },
    extraction: { enabled: true, mode: "anthropic" },
    accumulation: { enabled: true },
    hygiene: { schedule: "0 8 * * *" },
  },
};

// ─── Main ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length !== 1 || !PRESETS[args[0]]) {
  console.error(`Usage: node scripts/assay-preset.mjs <preset>`);
  console.error(`Available presets: ${Object.keys(PRESETS).join(", ")}`);
  process.exit(1);
}

const presetName = args[0];
const config = JSON.parse(JSON.stringify(PRESETS[presetName]));

writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
console.log(`Applied preset: ${presetName}`);
console.log(JSON.stringify(config, null, 2));
