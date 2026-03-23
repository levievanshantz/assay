#!/usr/bin/env node

/**
 * seed-demo.mjs — Seed the Assay database with the demo corpus.
 *
 * Usage: npm run seed-demo
 *
 * Steps:
 *   1. Read corpus/demo-seed.json
 *   2. Connect to DATABASE_URL
 *   3. Get or create PRODUCT_ID
 *   4. For each section: insert (dedup by content_hash), then embed via OpenAI
 *   5. Report results
 *
 * Idempotent: re-running skips records whose content_hash already exists.
 * Graceful: if OPENAI_API_KEY is missing, inserts records without embeddings.
 */

import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../.env.local") });
config({ path: path.resolve(__dirname, "../.env") });

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    "ERROR: DATABASE_URL is not set.\n" +
      "Run `npm run setup-db` first, then add DATABASE_URL to .env.local."
  );
  process.exit(1);
}

const PRODUCT_ID = process.env.PRODUCT_ID;
if (!PRODUCT_ID) {
  console.error(
    "ERROR: PRODUCT_ID is not set.\n" +
      "Run `npm run setup-db` to generate one, then add it to .env.local."
  );
  process.exit(1);
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;
const EMBEDDING_BATCH_SIZE = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Call OpenAI embeddings API for a batch of texts.
 * Returns an array of float arrays in the same order as the input.
 */
async function embedBatch(texts) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
      dimensions: EMBEDDING_DIMS,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embeddings API error ${res.status}: ${body}`);
  }

  const json = await res.json();
  // API returns objects sorted by index; sort to be safe
  const sorted = json.data.sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  console.log("=== Assay Demo Seed ===\n");

  // 1. Load corpus
  const corpusPath = path.resolve(__dirname, "../corpus/demo-seed.json");
  if (!fs.existsSync(corpusPath)) {
    console.error("ERROR: corpus/demo-seed.json not found.");
    process.exit(1);
  }
  const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf-8"));
  console.log(`Loaded ${corpus.length} sections from demo corpus.\n`);

  // 2. Connect to DB
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("supabase.co")
      ? { rejectUnauthorized: false }
      : undefined,
  });
  await client.connect();
  console.log("Connected to database.\n");

  // 3. Ensure product exists
  await client.query(
    "INSERT INTO products (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [PRODUCT_ID, "Demo Product"]
  );

  // 4. Insert records (dedup by content_hash)
  let inserted = 0;
  let skipped = 0;
  const recordsToEmbed = []; // { id, content }

  for (const section of corpus) {
    const contentHash = sha256(section.content);

    // Check for existing record with same hash
    const { rows: existing } = await client.query(
      "SELECT id FROM evidence_records WHERE content_hash = $1 AND product_id = $2",
      [contentHash, PRODUCT_ID]
    );

    if (existing.length > 0) {
      skipped++;
      console.log(`  ~ Skipped (duplicate): ${section.title}`);
      continue;
    }

    const summary = section.content.slice(0, 500);
    const now = new Date().toISOString();

    const { rows: insertRows } = await client.query(
      `INSERT INTO evidence_records
        (type, product_id, title, summary, content, source_ref, source_type, content_hash, source_version, state, is_enabled, is_tombstoned)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        section.type,
        PRODUCT_ID,
        section.title,
        summary,
        section.content,
        section.source_ref,
        "demo",
        contentHash,
        1,
        "current",
        true,
        false,
      ]
    );

    if (insertRows.length > 0) {
      inserted++;
      recordsToEmbed.push({ id: insertRows[0].id, content: section.content });
      console.log(`  + Inserted: ${section.title}`);
    }
  }

  console.log(
    `\nInserted ${inserted} records, skipped ${skipped} duplicates.\n`
  );

  // 5. Embed records
  if (recordsToEmbed.length === 0) {
    console.log("No new records to embed.");
  } else if (!OPENAI_API_KEY) {
    console.warn(
      "WARNING: OPENAI_API_KEY is not set. Records were inserted WITHOUT embeddings.\n" +
        "Add OPENAI_API_KEY to .env.local and re-run to embed them.\n" +
        "Retrieval tools (brief, stress_test, retrieve_evidence) require embeddings to function."
    );
  } else {
    console.log(
      `Embedding ${recordsToEmbed.length} records (batch size ${EMBEDDING_BATCH_SIZE})...\n`
    );
    let embedded = 0;

    for (let i = 0; i < recordsToEmbed.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = recordsToEmbed.slice(i, i + EMBEDDING_BATCH_SIZE);
      const texts = batch.map((r) => r.content);

      try {
        const embeddings = await embedBatch(texts);
        const now = new Date().toISOString();

        for (let j = 0; j < batch.length; j++) {
          const vecStr = `[${embeddings[j].join(",")}]`;
          await client.query(
            `UPDATE evidence_records
             SET embedding = $1, embedding_model = $2, embedded_at = $3, last_synced_at = $4
             WHERE id = $5`,
            [vecStr, EMBEDDING_MODEL, now, now, batch[j].id]
          );
          embedded++;
        }

        console.log(
          `  Embedded batch ${Math.floor(i / EMBEDDING_BATCH_SIZE) + 1}: ${batch.length} records`
        );
      } catch (err) {
        console.error(`  ERROR embedding batch: ${err.message}`);
        console.error(
          "  Remaining records were inserted without embeddings."
        );
        break;
      }
    }

    console.log(`\nEmbedded ${embedded}/${recordsToEmbed.length} records.`);
  }

  // 6. Summary
  const { rows: countRows } = await client.query(
    "SELECT count(*)::int AS total, count(embedding)::int AS with_embedding FROM evidence_records WHERE product_id = $1",
    [PRODUCT_ID]
  );
  const stats = countRows[0] || { total: 0, with_embedding: 0 };
  console.log(
    `\nProduct ${PRODUCT_ID} now has ${stats.total} evidence records (${stats.with_embedding} with embeddings).`
  );

  console.log("\n=== Seed complete ===");
  await client.end();
}

run().catch(async (err) => {
  console.error("Seed failed:", err.message || err);
  process.exit(1);
});
