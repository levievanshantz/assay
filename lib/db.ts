/**
 * Direct PostgreSQL connection pool via `pg` (node-postgres).
 *
 * Replaces the Supabase JS client for all server-side queries.
 * Uses DATABASE_URL from environment — works with both local PostgreSQL
 * and Supabase connection strings.
 *
 * PRD 15 — Local-first deployment.
 */

import { Pool, QueryResultRow } from "pg";

let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set. Add it to .env.local (e.g. postgresql://localhost:5432/assay)"
      );
    }
    _pool = new Pool({
      connectionString,
      // Supabase cloud requires SSL; local does not
      ssl: connectionString.includes("supabase.co")
        ? { rejectUnauthorized: false }
        : undefined,
      max: 10,
      idleTimeoutMillis: 30000,
    });
  }
  return _pool;
}

/**
 * Execute a parameterized SQL query.
 *
 * Usage:
 *   const { rows } = await query('SELECT * FROM evidence_records WHERE id = $1', [id]);
 *   const { rows } = await query('SELECT * FROM match_evidence_by_embedding($1, $2, $3)', [embedding, 0.25, 30]);
 */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<{ rows: T[]; rowCount: number | null }> {
  const pool = getPool();
  const result = await pool.query<T>(text, params);
  return { rows: result.rows, rowCount: result.rowCount };
}

/**
 * Get the raw Pool instance for advanced use cases (transactions, etc.).
 */
export { getPool };
