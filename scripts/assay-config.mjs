#!/usr/bin/env node

/**
 * CLI for reading/writing Assay feature toggles.
 *
 * Usage:
 *   node scripts/assay-config.mjs                        # print full config
 *   node scripts/assay-config.mjs sync.enabled            # print one value
 *   node scripts/assay-config.mjs sync.enabled true       # set a value
 *   node scripts/assay-config.mjs extraction.mode anthropic
 *   node scripts/assay-config.mjs hygiene.schedule "0 8 * * *"
 *   node scripts/assay-config.mjs hygiene.schedule off
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __scripts_dirname = dirname(__filename);
const CONFIG_PATH = resolve(__scripts_dirname, "../.assay.config.json");

const DEFAULT_CONFIG = {
  sync: { enabled: true },
  extraction: { enabled: true, mode: "ollama" },
  accumulation: { enabled: true },
  hygiene: { schedule: "off" },
};

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return deepClone(DEFAULT_CONFIG);
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const merged = deepClone(DEFAULT_CONFIG);
    if (parsed.sync) Object.assign(merged.sync, parsed.sync);
    if (parsed.extraction) Object.assign(merged.extraction, parsed.extraction);
    if (parsed.accumulation) Object.assign(merged.accumulation, parsed.accumulation);
    if (parsed.hygiene) Object.assign(merged.hygiene, parsed.hygiene);
    return merged;
  } catch {
    return deepClone(DEFAULT_CONFIG);
  }
}

function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function getNestedValue(obj, path) {
  const keys = path.split(".");
  let current = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function setNestedValue(obj, path, value) {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || current[key] === null || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}

/** Coerce CLI string values to appropriate JS types. */
function coerceValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Keep numeric-looking strings as numbers
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

// ─── Main ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0) {
  // Print full config
  const config = loadConfig();
  console.log(JSON.stringify(config, null, 2));
  process.exit(0);
}

if (args.length === 1) {
  // Print a single value
  const config = loadConfig();
  const val = getNestedValue(config, args[0]);
  if (val === undefined) {
    console.error(`Unknown config key: ${args[0]}`);
    process.exit(1);
  }
  console.log(typeof val === "object" ? JSON.stringify(val, null, 2) : val);
  process.exit(0);
}

if (args.length === 2) {
  const [key, rawValue] = args;
  const value = coerceValue(rawValue);
  const config = loadConfig();
  setNestedValue(config, key, value);
  saveConfig(config);
  console.log(`Set ${key} = ${JSON.stringify(value)}`);
  console.log(JSON.stringify(config, null, 2));
  process.exit(0);
}

console.error("Usage: node scripts/assay-config.mjs [key] [value]");
process.exit(1);
