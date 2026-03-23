#!/usr/bin/env node

/**
 * verify-setup.mjs — Post-install health check for Assay.
 *
 * Usage: npm run verify
 *
 * Checks:
 *   1. Database connection + tables
 *   2. pgvector extension
 *   3. RPC functions
 *   4. OpenAI embedding test
 *   5. Extraction mode availability
 *
 * Exits 0 if all critical checks pass, 1 otherwise.
 */

import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../.env.local") });
config({ path: path.resolve(__dirname, "../.env") });

const DATABASE_URL = process.env.DATABASE_URL;

let passed = 0;
let failed = 0;
let warnings = 0;

function pass(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label, msg) {
  console.error(`  ✗ ${label}: ${msg}`);
  failed++;
}

function warn(label, msg) {
  console.log(`  ⚠ ${label}: ${msg}`);
  warnings++;
}

async function run() {
  console.log("=== Assay Verification ===\n");

  // ── 1. Database connection ──────────────────────────────────────
  console.log("Database:");
  if (!DATABASE_URL) {
    fail("CONNECTION", "DATABASE_URL is not set");
    printSummary();
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("supabase.co")
      ? { rejectUnauthorized: false }
      : undefined,
  });

  try {
    await client.connect();
    pass("CONNECTION");
  } catch (err) {
    fail("CONNECTION", err.message);
    printSummary();
    process.exit(1);
  }

  // ── 2. Core tables ──────────────────────────────────────────────
  console.log("\nTables:");
  const requiredTables = [
    "evidence_records",
    "claims",
    "products",
  ];
  for (const table of requiredTables) {
    try {
      const { rows } = await client.query(
        `SELECT count(*)::int AS c FROM ${table}`
      );
      pass(`${table} (${rows[0].c} rows)`);
    } catch (err) {
      fail(table, err.message);
    }
  }

  // ── 3. pgvector extension ───────────────────────────────────────
  console.log("\nExtensions:");
  try {
    const { rows } = await client.query(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
    );
    if (rows.length > 0) {
      pass(`pgvector v${rows[0].extversion}`);
    } else {
      fail("pgvector", "Extension not installed");
    }
  } catch (err) {
    fail("pgvector", err.message);
  }

  // ── 4. RPC functions ────────────────────────────────────────────
  console.log("\nRPC Functions:");
  const requiredFunctions = [
    "match_evidence_by_embedding",
    "match_claims_by_embedding",
    "match_evidence_by_fts",
    "match_claims_by_fts",
  ];
  for (const fn of requiredFunctions) {
    try {
      const { rows } = await client.query(
        "SELECT proname FROM pg_proc WHERE proname = $1",
        [fn]
      );
      if (rows.length > 0) {
        pass(fn);
      } else {
        fail(fn, "Function not found");
      }
    } catch (err) {
      fail(fn, err.message);
    }
  }

  // ── 5. OpenAI embedding test ────────────────────────────────────
  console.log("\nEmbeddings:");
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    fail("OPENAI_API_KEY", "Not set — embeddings will not work");
  } else {
    try {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: "test",
        }),
      });
      if (response.ok) {
        const body = await response.json();
        const dims = body.data?.[0]?.embedding?.length;
        pass(`text-embedding-3-small (${dims} dims)`);
      } else {
        const body = await response.json().catch(() => ({}));
        fail("embedding_test", body.error?.message || `HTTP ${response.status}`);
      }
    } catch (err) {
      fail("embedding_test", err.message);
    }
  }

  // ── 6. Extraction mode ──────────────────────────────────────────
  console.log("\nExtraction:");
  const extractionMode = process.env.EXTRACTION_MODE || "anthropic";
  console.log(`  Mode: ${extractionMode}`);

  if (extractionMode === "ollama") {
    const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
    try {
      const response = await fetch(`${ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        pass(`Ollama reachable at ${ollamaUrl}`);
      } else {
        warn("ollama", `HTTP ${response.status} from ${ollamaUrl}`);
      }
    } catch {
      warn("ollama", `Cannot reach ${ollamaUrl}`);
    }
  } else if (extractionMode === "anthropic") {
    if (process.env.ANTHROPIC_API_KEY) {
      pass("ANTHROPIC_API_KEY set");
    } else {
      warn("ANTHROPIC_API_KEY", "Not set — claim extraction via Anthropic will fail");
    }
  } else if (extractionMode === "subagent") {
    pass("subagent mode — claims submitted via submit_extracted_claims tool");
  } else {
    warn("EXTRACTION_MODE", `Unknown mode: ${extractionMode}`);
  }

  // ── 7. Notion ───────────────────────────────────────────────────
  console.log("\nNotion:");
  if (process.env.NOTION_API_KEY) {
    pass("NOTION_API_KEY set");
  } else {
    warn("NOTION_API_KEY", "Not set — Notion ingestion unavailable");
  }

  // ── 8. Synthesis ────────────────────────────────────────────────
  console.log("\nSynthesis:");
  if (process.env.ANTHROPIC_API_KEY) {
    pass("ANTHROPIC_API_KEY set for synthesis");
  } else {
    warn("synthesis", "ANTHROPIC_API_KEY not set — brief/stress_test may fail");
  }

  await client.end();
  printSummary();
  process.exit(failed > 0 ? 1 : 0);
}

function printSummary() {
  console.log("\n=== Summary ===");
  console.log(`  Passed:   ${passed}`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Warnings: ${warnings}`);
  if (failed > 0) {
    console.log("\nResult: FAIL — critical checks did not pass.");
  } else if (warnings > 0) {
    console.log("\nResult: PASS with warnings — core is functional but some features may be unavailable.");
  } else {
    console.log("\nResult: PASS — all checks passed.");
  }
}

run().catch(async (err) => {
  console.error("Verification failed:", err.message || err);
  process.exit(1);
});
