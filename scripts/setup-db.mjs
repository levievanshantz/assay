#!/usr/bin/env node

/**
 * setup-db.mjs — One-command database setup for Assay.
 *
 * Usage: npm run setup-db
 *
 * Steps:
 *   1. Read DATABASE_URL from .env.local / .env
 *   2. Connect to PostgreSQL
 *   3. Create extensions (pgvector, uuid-ossp)
 *   4. Run all migrations in order
 *   5. Generate PRODUCT_ID if not set
 *   6. Insert default product
 *   7. Report success with counts
 */

import pg from "pg";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../.env.local") });
config({ path: path.resolve(__dirname, "../.env") });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    "ERROR: DATABASE_URL is not set.\n" +
      "Add it to .env.local, e.g.:\n" +
      "  DATABASE_URL=postgresql://localhost:5432/assay"
  );
  process.exit(1);
}

const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("supabase.co")
    ? { rejectUnauthorized: false }
    : undefined,
});

async function run() {
  console.log("=== Assay Database Setup ===\n");

  // 1. Connect
  console.log(`Connecting to ${DATABASE_URL.replace(/\/\/.*@/, "//***@")}...`);
  await client.connect();
  console.log("Connected.\n");

  // 2. Create extensions
  console.log("Creating extensions...");
  await client.query("CREATE EXTENSION IF NOT EXISTS vector;");
  console.log("  pgvector ✓");
  await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
  console.log("  uuid-ossp ✓\n");

  // 3. Run migrations
  const migrationsDir = path.resolve(__dirname, "../migrations");
  if (!fs.existsSync(migrationsDir)) {
    console.error("ERROR: migrations/ directory not found.");
    process.exit(1);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  console.log(`Running ${files.length} migrations...`);
  let applied = 0;
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    try {
      await client.query(sql);
      console.log(`  ✓ ${file}`);
      applied++;
    } catch (err) {
      // Many migrations use IF NOT EXISTS, so some errors are expected for
      // re-runs. Log the error but try to continue.
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("already exists") ||
        msg.includes("duplicate key") ||
        msg.includes("does not exist") // e.g. DROP IF EXISTS on missing column
      ) {
        console.log(`  ~ ${file} (already applied or benign: ${msg.slice(0, 80)})`);
        applied++;
      } else {
        console.error(`  ✗ ${file}: ${msg}`);
        console.error("    Stopping migration run.");
        process.exit(1);
      }
    }
  }
  console.log(`\n${applied}/${files.length} migrations applied.\n`);

  // 4. Generate PRODUCT_ID if not set
  let productId = process.env.PRODUCT_ID;
  if (!productId) {
    productId = crypto.randomUUID();
    console.log(`Generated PRODUCT_ID: ${productId}`);
    console.log("Add this to your .env.local:\n");
    console.log(`  PRODUCT_ID=${productId}\n`);
  } else {
    console.log(`Using existing PRODUCT_ID: ${productId}`);
  }

  // 5. Insert default product
  try {
    await client.query(
      "INSERT INTO products (id, name) VALUES ($1, 'Default') ON CONFLICT DO NOTHING",
      [productId]
    );
    console.log("Default product ensured.\n");
  } catch (err) {
    // products table may not exist in minimal setups — warn but don't fail
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: Could not insert default product: ${msg}\n`);
  }

  // 6. Report counts
  try {
    const { rows: evRows } = await client.query(
      "SELECT count(*)::int AS c FROM evidence_records"
    );
    const { rows: clRows } = await client.query(
      "SELECT count(*)::int AS c FROM claims"
    );
    console.log("Current data:");
    console.log(`  Evidence records: ${evRows[0]?.c ?? 0}`);
    console.log(`  Claims:           ${clRows[0]?.c ?? 0}`);
  } catch {
    // Tables may not exist yet if migrations were partial
    console.log("(Could not count records — tables may not exist yet.)");
  }

  console.log("\n=== Setup complete ===");
  await client.end();
}

run().catch(async (err) => {
  console.error("Setup failed:", err.message || err);
  await client.end().catch(() => {});
  process.exit(1);
});
