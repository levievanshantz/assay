/**
 * Ingestion Pipeline — PRD 9: Data Hygiene & Ingestion Pipeline Foundation
 *
 * Core functions for content hashing, dedup checking, tombstoning,
 * and version-aware claim superseding. Source-agnostic — all ingestion
 * routes (Notion, CSV, manual, future connectors) use these primitives.
 */

import crypto from "crypto";
import { query } from "./db";

// ─── Content Hashing ────────────────────────────────────────────

/**
 * Compute MD5 hash of content string.
 * Used at ingestion time and for freshness comparison.
 */
export function computeContentHash(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex");
}

// ─── Duplicate Check ────────────────────────────────────────────

export interface ExistingEvidence {
  id: string;
  title: string;
  content_hash: string;
  source_version: number;
}

/**
 * Check if evidence with the same content hash already exists for a product.
 * Returns the existing record if found, null if no match.
 */
export async function checkDuplicate(
  productId: string,
  contentHash: string
): Promise<ExistingEvidence | null> {
  const { rows } = await query(
    `SELECT id, title, content_hash, source_version FROM evidence_records
     WHERE product_id = $1 AND content_hash = $2 AND is_tombstoned = false LIMIT 1`,
    [productId, contentHash]
  );
  return rows[0] ?? null;
}

/**
 * Check duplicates for a batch of content hashes.
 * Returns a Set of hashes that already exist.
 */
export async function checkDuplicateBatch(
  productId: string,
  contentHashes: string[]
): Promise<Set<string>> {
  const { rows } = await query(
    `SELECT content_hash FROM evidence_records
     WHERE product_id = $1 AND is_tombstoned = false AND content_hash = ANY($2)`,
    [productId, contentHashes]
  );
  return new Set(rows.map((r: { content_hash: string }) => r.content_hash));
}

// ─── Tombstoning ────────────────────────────────────────────────

export type TombstoneReason = "source_deleted" | "superseded" | "manual";

/**
 * Tombstone an evidence record (soft delete).
 * Record stays in DB for audit but is excluded from retrieval RPCs.
 */
export async function tombstoneEvidence(
  evidenceId: string,
  reason: TombstoneReason
): Promise<void> {
  const { rowCount } = await query(
    "UPDATE evidence_records SET is_tombstoned = true, tombstone_reason = $1 WHERE id = $2",
    [reason, evidenceId]
  );
  if (rowCount === 0) {
    console.error(`Failed to tombstone evidence ${evidenceId}: no rows updated`);
  }
}

/**
 * Tombstone all evidence records for a given source.
 * Returns count of tombstoned records.
 */
export async function tombstoneEvidenceBySource(
  sourceType: string,
  sourceExternalId: string,
  reason: TombstoneReason
): Promise<number> {
  const { rowCount } = await query(
    `UPDATE evidence_records SET is_tombstoned = true, tombstone_reason = $1
     WHERE source_type = $2 AND source_external_id = $3 AND is_tombstoned = false`,
    [reason, sourceType, sourceExternalId]
  );
  return rowCount ?? 0;
}

// ─── Claim Superseding ──────────────────────────────────────────

/**
 * Mark all current claims for a source as superseded.
 * Called BEFORE new claims are inserted during re-extraction.
 * Returns count of superseded claims.
 */
export async function supersedeClaimsForSource(
  sourceType: string,
  sourceId: string
): Promise<number> {
  const { rowCount } = await query(
    `UPDATE claims SET superseded_at = $1
     WHERE source_type = $2 AND source_id = $3 AND superseded_at IS NULL`,
    [new Date().toISOString(), sourceType, sourceId]
  );
  return rowCount ?? 0;
}

// ─── Ingestion Result Types ─────────────────────────────────────

export interface IngestionResult {
  imported: number;
  skipped: number;
  updated: number;
  tombstoned: number;
  total: number;
  details: {
    importedIds: string[];
    skippedHashes: string[];
    updatedIds: string[];
    tombstonedIds: string[];
  };
}

export function emptyIngestionResult(): IngestionResult {
  return {
    imported: 0,
    skipped: 0,
    updated: 0,
    tombstoned: 0,
    total: 0,
    details: {
      importedIds: [],
      skippedHashes: [],
      updatedIds: [],
      tombstonedIds: [],
    },
  };
}
