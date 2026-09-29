#!/usr/bin/env node
// Performance benchmarks at realistic corpus sizes.
// Measures p50/p95/p99 latency for recall + brief at 100, 1000, 10000 decisions.
// Runs in an isolated sandbox — does NOT touch ~/.assay/decisions.db.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DecisionStore } from "../dist/decisions/store.js";
import { ClaudeMemHTTPProvider } from "../dist/providers/ClaudeMemHTTPProvider.js";
import { AssayMCPServer } from "../dist/mcp/server.js";

const ITERATIONS = 100;  // queries per measurement
const QUERIES = [
  "topic X",
  "pricing strategy",
  "architecture decision",
  "what did we ship last week",
  "auth migration",
];

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function fmt(ms) { return `${ms.toFixed(1)}ms`; }

async function populate(store, n) {
  // Insert N decisions in batches of 500 for speed
  const batch = 500;
  for (let i = 0; i < n; i += batch) {
    const chunk = [];
    for (let j = i; j < Math.min(i + batch, n); j++) {
      chunk.push({
        kind: "decision",
        body: `Decision ${j}: ${["pricing", "architecture", "auth", "topic X", "deploy"][j % 5]} call ${j}. Relevant to multiple topics including the j-th hypothesis.`,
        confidence: 0.5 + (j % 5) / 10,
        layer: ["pricing", "architecture", "auth", "naming", "deploy"][j % 5],
        source_span: { start: j, end: j + 1 },
      });
    }
    store.depositBatch(chunk);
  }
}

async function benchAt(size) {
  const sandbox = await mkdtemp(join(tmpdir(), `assay-bench-${size}-`));
  const dbPath = join(sandbox, "decisions.db");
  process.env.ASSAY_DB_PATH = dbPath;

  console.log(`\n  Populating ${size} decisions...`);
  const populateStart = Date.now();
  const store = new DecisionStore(dbPath);
  await populate(store, size);
  store.close();
  console.log(`    populate took ${Date.now() - populateStart}ms`);

  // Force claude-mem to look offline so we measure the local decision-graph path,
  // not noisy network-bound enrichment. Realistic baseline.
  const provider = new ClaudeMemHTTPProvider({ port: 65535, timeoutMs: 50 });
  const server = new AssayMCPServer(new DecisionStore(dbPath), provider);

  const recallTimes = [];
  const briefTimes = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const q = QUERIES[i % QUERIES.length];

    const r0 = Date.now();
    await server.recall(q);
    recallTimes.push(Date.now() - r0);

    const b0 = Date.now();
    await server.brief(q);
    briefTimes.push(Date.now() - b0);
  }

  await server.close();
  await rm(sandbox, { recursive: true, force: true });

  return {
    size,
    recall: {
      p50: percentile(recallTimes, 50),
      p95: percentile(recallTimes, 95),
      p99: percentile(recallTimes, 99),
      max: Math.max(...recallTimes),
    },
    brief: {
      p50: percentile(briefTimes, 50),
      p95: percentile(briefTimes, 95),
      p99: percentile(briefTimes, 99),
      max: Math.max(...briefTimes),
    },
  };
}

async function main() {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`Assay performance benchmarks — ${ITERATIONS} iterations per size`);
  console.log(`Substrate forced offline (port=65535) — local path only`);
  console.log("═".repeat(70));

  const sizes = [100, 1000, 10000];
  const results = [];
  for (const size of sizes) {
    const r = await benchAt(size);
    results.push(r);
  }

  console.log(`\n┌──────────┬─────────────────────────────┬─────────────────────────────┐`);
  console.log(`│  corpus  │  assay_decision_recall      │  assay_brief_render         │`);
  console.log(`│  size    │  p50     p95     p99   max  │  p50     p95     p99   max  │`);
  console.log(`├──────────┼─────────────────────────────┼─────────────────────────────┤`);
  for (const r of results) {
    const rc = r.recall;
    const br = r.brief;
    console.log(
      `│  ${String(r.size).padStart(6)}  │` +
      `  ${fmt(rc.p50).padStart(6)}  ${fmt(rc.p95).padStart(6)}  ${fmt(rc.p99).padStart(6)}  ${fmt(rc.max).padStart(5)} │` +
      `  ${fmt(br.p50).padStart(6)}  ${fmt(br.p95).padStart(6)}  ${fmt(br.p99).padStart(6)}  ${fmt(br.max).padStart(5)} │`
    );
  }
  console.log(`└──────────┴─────────────────────────────┴─────────────────────────────┘\n`);

  // Acceptance: p95 recall < 1000ms at 10k. brief is more expensive (filter pass).
  const big = results[results.length - 1];
  const recallOk = big.recall.p95 < 1000;
  const briefOk = big.brief.p95 < 3000;
  console.log(`  Acceptance @ 10k:`);
  console.log(`    recall p95 < 1000ms: ${recallOk ? "✓" : "✗"} (${fmt(big.recall.p95)})`);
  console.log(`    brief  p95 < 3000ms: ${briefOk ? "✓" : "✗"} (${fmt(big.brief.p95)})`);

  if (!recallOk || !briefOk) {
    console.log(`\n  ⚠ Performance regression vs target. Consider:`);
    console.log(`    - Add index on decisions.created_at DESC (likely the recall bottleneck)`);
    console.log(`    - Cap brief's topic-relevance scan to recent N decisions instead of full pool`);
    process.exit(1);
  }
  console.log(`\n  ✓ All performance targets met.\n`);
}

main().catch((err) => {
  console.error(`\nBenchmark crashed: ${err.message}`);
  console.error(err.stack);
  process.exit(2);
});
