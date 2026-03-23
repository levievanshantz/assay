#!/usr/bin/env node

/**
 * Notion Ingest — PRD 16
 *
 * Takes the JSON output of notion-crawl.mjs and:
 *   1. Deduplicates against existing evidence_records (by content_hash)
 *   2. Inserts new chunks as evidence_records with source_type='notion'
 *   3. Embeds via OpenAI text-embedding-3-small
 *   4. Optionally extracts claims (--extract-claims flag)
 *
 * Usage:
 *   node scripts/notion-ingest.mjs scripts/output/notion-crawl-<timestamp>.json
 *   node scripts/notion-ingest.mjs scripts/output/notion-crawl-<timestamp>.json --extract-claims
 *   node scripts/notion-ingest.mjs --latest                    # pick most recent crawl file
 *   node scripts/notion-ingest.mjs --latest --extract-claims   # + claims extraction
 *
 * Env vars (reads from .env.local):
 *   DATABASE_URL   — PostgreSQL connection string
 *   OPENAI_API_KEY — for embeddings
 *   PRODUCT_ID     — default product UUID
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { readFileSync, readdirSync } from "fs";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
config({ path: resolve(PROJECT_ROOT, ".env.local") });

const DATABASE_URL = process.env.DATABASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PRODUCT_ID = process.env.PRODUCT_ID || "default";
const EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 20; // embed 20 texts at once

// ─── CLI Args ────────────────────────────────────────────────
const args = process.argv.slice(2);
const FLAG_EXTRACT_CLAIMS = args.includes("--extract-claims");
const FLAG_LATEST = args.includes("--latest");
let inputFile = args.find((a) => !a.startsWith("--"));

if (FLAG_LATEST) {
  const outputDir = resolve(__dirname, "output");
  const files = readdirSync(outputDir)
    .filter((f) => f.startsWith("notion-crawl-") && f.endsWith(".json") && !f.includes("state"))
    .sort()
    .reverse();
  if (files.length === 0) {
    console.error("❌ No crawl output files found in scripts/output/");
    process.exit(1);
  }
  inputFile = resolve(outputDir, files[0]);
  console.log(`📂 Using latest crawl: ${files[0]}`);
}

if (!inputFile) {
  console.error("Usage: node scripts/notion-ingest.mjs <crawl-output.json> [--extract-claims]");
  console.error("   or: node scripts/notion-ingest.mjs --latest [--extract-claims]");
  process.exit(1);
}

// ─── DB + Embedding Helpers ─────────────────────────────────
const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function embedTexts(texts) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts.map((t) => t.slice(0, 8000)) }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.data.map((d) => d.embedding);
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  if (!DATABASE_URL) {
    console.error("❌ DATABASE_URL not set. Add it to .env.local");
    process.exit(1);
  }
  if (!OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY not set");
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════════════════");
  console.log("  NOTION INGEST → EVIDENCE RECORDS");
  console.log("═══════════════════════════════════════════════════════");

  const crawlData = JSON.parse(readFileSync(inputFile, "utf-8"));
  console.log(`  Source: ${inputFile}`);
  console.log(`  Pages: ${crawlData.pages.length}`);
  console.log(`  Total chunks: ${crawlData.metadata.totalChunks}`);
  console.log(`  Extract claims: ${FLAG_EXTRACT_CLAIMS}`);
  console.log("");

  // Collect all chunks with page metadata
  const allChunks = [];
  for (const page of crawlData.pages) {
    for (const chunk of page.chunks) {
      allChunks.push({
        ...chunk,
        pageId: page.pageId,
        pageTitle: page.title,
        pageUrl: page.url,
        lastEditedTime: page.lastEditedTime,
      });
    }
  }

  console.log(`📦 ${allChunks.length} total chunks to process\n`);

  // Step 1: Dedup — check which content hashes already exist
  console.log("Step 1: Deduplicating against existing records...");
  const { rows: existingHashes } = await pool.query(
    `SELECT content_hash FROM evidence_records WHERE product_id = $1 AND content_hash IS NOT NULL`,
    [PRODUCT_ID]
  );
  const existingHashSet = new Set(existingHashes.map((r) => r.content_hash));

  const newChunks = allChunks.filter((c) => !existingHashSet.has(c.contentHash));
  const skipped = allChunks.length - newChunks.length;
  console.log(`  ${skipped} chunks already exist (skipped)`);
  console.log(`  ${newChunks.length} new chunks to insert\n`);

  if (newChunks.length === 0) {
    console.log("✅ Nothing new to ingest. Corpus is up to date.");
    await pool.end();
    return;
  }

  // Step 2: Insert + embed in batches
  console.log(`Step 2: Inserting and embedding ${newChunks.length} chunks...`);
  let inserted = 0;
  let embedded = 0;
  let errors = 0;
  const now = new Date().toISOString();

  for (let i = 0; i < newChunks.length; i += BATCH_SIZE) {
    const batch = newChunks.slice(i, i + BATCH_SIZE);
    const progress = `[${Math.min(i + BATCH_SIZE, newChunks.length)}/${newChunks.length}]`;

    try {
      // Insert records
      const insertedIds = [];
      for (const chunk of batch) {
        const { rows } = await pool.query(
          `INSERT INTO evidence_records
           (type, product_id, title, summary, content, source_ref, source_type, source_external_id, content_hash, source_version, state, is_enabled, is_tombstoned, last_synced_at)
           VALUES ('strategy', $1, $2, $3, $4, $5, 'notion', $6, $7, 1, 'current', true, false, $8)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            PRODUCT_ID,
            chunk.title,
            chunk.text.slice(0, 500),
            chunk.text,
            chunk.pageUrl,
            chunk.pageId,
            chunk.contentHash,
            now,
          ]
        );
        if (rows.length > 0) {
          insertedIds.push({ id: rows[0].id, text: chunk.text });
          inserted++;
        }
      }

      // Embed batch
      if (insertedIds.length > 0) {
        const texts = insertedIds.map((r) => r.text);
        const embeddings = await embedTexts(texts);

        for (let j = 0; j < insertedIds.length; j++) {
          await pool.query(
            `UPDATE evidence_records SET embedding = $1, embedding_model = $2, embedded_at = $3 WHERE id = $4`,
            [`[${embeddings[j].join(",")}]`, EMBEDDING_MODEL, now, insertedIds[j].id]
          );
          embedded++;
        }
      }

      process.stdout.write(`  ${progress} inserted: ${inserted}, embedded: ${embedded}\r`);
    } catch (err) {
      console.error(`\n  ❌ Batch error: ${err.message.slice(0, 100)}`);
      errors++;
    }
  }

  console.log(`\n\nStep 3: Summary`);
  console.log(`  Inserted: ${inserted} evidence records`);
  console.log(`  Embedded: ${embedded} records`);
  console.log(`  Skipped (dedup): ${skipped}`);
  console.log(`  Errors: ${errors}`);

  // Step 3: Verify
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) as total, COUNT(embedding) as with_embedding
     FROM evidence_records WHERE source_type = 'notion' AND is_tombstoned = false AND product_id = $1`,
    [PRODUCT_ID]
  );
  console.log(`\n  DB totals (notion source): ${countRows[0].total} records, ${countRows[0].with_embedding} with embeddings`);

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  INGEST COMPLETE ✅");
  console.log("═══════════════════════════════════════════════════════");

  await pool.end();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
