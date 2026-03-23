/**
 * Feature toggle system for Assay.
 *
 * Configuration is stored in `.assay.config.json` at the project root.
 * If the file is missing, sensible defaults are returned.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Types ──────────────────────────────────────────────────────────

export interface AssayConfig {
  sync: { enabled: boolean };
  extraction: { enabled: boolean; mode: "ollama" | "anthropic" | "subagent" };
  embedding: { provider: "openai" | "local" };
  accumulation: { enabled: boolean };
  hygiene: { schedule: string }; // cron expression or "off"
}

// ─── Defaults ───────────────────────────────────────────────────────

export const DEFAULT_CONFIG: AssayConfig = {
  sync: { enabled: true },
  extraction: { enabled: true, mode: "ollama" },
  embedding: { provider: "openai" },
  accumulation: { enabled: true },
  hygiene: { schedule: "off" },
};

// ─── Helpers ────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __lib_dirname = dirname(__filename);
const CONFIG_PATH = resolve(__lib_dirname, "../.assay.config.json");

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/** Recursively get a nested value by dot-separated path. */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Recursively set a nested value by dot-separated path. */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || current[key] === null || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Load config from `.assay.config.json`.
 * Returns DEFAULT_CONFIG (deep-cloned) if the file is missing or invalid.
 */
export function loadConfig(): AssayConfig {
  if (!existsSync(CONFIG_PATH)) {
    return deepClone(DEFAULT_CONFIG);
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AssayConfig>;
    // Merge with defaults so missing keys get filled in
    const merged = deepClone(DEFAULT_CONFIG);
    if (parsed.sync) Object.assign(merged.sync, parsed.sync);
    if (parsed.extraction) Object.assign(merged.extraction, parsed.extraction);
    if (parsed.embedding) Object.assign(merged.embedding, parsed.embedding);
    if (parsed.accumulation) Object.assign(merged.accumulation, parsed.accumulation);
    if (parsed.hygiene) Object.assign(merged.hygiene, parsed.hygiene);
    return merged;
  } catch {
    return deepClone(DEFAULT_CONFIG);
  }
}

/** Persist the full config to `.assay.config.json`. */
export function saveConfig(config: AssayConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/** Get a single value by dot-path (e.g. "sync.enabled"). */
export function getConfigValue(path: string): unknown {
  const config = loadConfig();
  return getNestedValue(config as unknown as Record<string, unknown>, path);
}

/** Set a single value by dot-path and persist (e.g. "hygiene.schedule", "0 8 * * *"). */
export function setConfigValue(path: string, value: unknown): void {
  const config = loadConfig();
  setNestedValue(config as unknown as Record<string, unknown>, path, value);
  saveConfig(config);
}
