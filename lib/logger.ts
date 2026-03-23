/**
 * Activity Logging System for Assay MCP Server
 *
 * Writes human-readable logs to logs/assay-YYYY-MM-DD.log
 * and structured JSON logs to logs/assay-YYYY-MM-DD.jsonl.
 * Also maintains logs/latest.log as a copy of the current session's log.
 *
 * Log levels: debug, info, warn, error
 * Components: mcp, sync, ingest, extract, brief, stress_test, health, setup, claims
 */

import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = resolve(__dirname, "../logs");

// Ensure logs directory exists
if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true });
}

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

function getDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function getTimestamp(): string {
  return new Date().toISOString();
}

function logFilePath(): string {
  return resolve(LOGS_DIR, `assay-${getDateStr()}.log`);
}

function jsonlFilePath(): string {
  return resolve(LOGS_DIR, `assay-${getDateStr()}.jsonl`);
}

function latestLogPath(): string {
  return resolve(LOGS_DIR, "latest.log");
}

function writeLog(
  level: LogLevel,
  component: string,
  message: string,
  data?: Record<string, unknown>
): void {
  const ts = getTimestamp();
  const label = LEVEL_LABELS[level];

  // Human-readable line
  const dataSuffix = data ? ` ${JSON.stringify(data)}` : "";
  const humanLine = `[${ts}] [${label}] [${component}] ${message}${dataSuffix}\n`;

  // Structured JSON line
  const jsonLine: Record<string, unknown> = {
    timestamp: ts,
    level,
    component,
    message,
  };
  if (data) jsonLine.data = data;
  const jsonStr = JSON.stringify(jsonLine) + "\n";

  try {
    appendFileSync(logFilePath(), humanLine);
    appendFileSync(jsonlFilePath(), jsonStr);
    appendFileSync(latestLogPath(), humanLine);
  } catch {
    // If logging itself fails, write to stderr and move on
    process.stderr.write(`[logger-error] Failed to write log: ${humanLine}`);
  }
}

/**
 * Initialize latest.log for a new session by clearing it.
 * Called once at server startup.
 */
export function initSessionLog(): void {
  try {
    writeFileSync(latestLogPath(), "");
  } catch {
    // best-effort
  }
}

export const logger = {
  debug: (component: string, message: string, data?: Record<string, unknown>): void =>
    writeLog("debug", component, message, data),
  info: (component: string, message: string, data?: Record<string, unknown>): void =>
    writeLog("info", component, message, data),
  warn: (component: string, message: string, data?: Record<string, unknown>): void =>
    writeLog("warn", component, message, data),
  error: (component: string, message: string, data?: Record<string, unknown>): void =>
    writeLog("error", component, message, data),
};
