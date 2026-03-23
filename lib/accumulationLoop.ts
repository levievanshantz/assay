/**
 * Corpus Accumulation Loop — PRD 14
 *
 * Deposits brief and stress-test evaluation outputs back into the
 * evidence_records table so future queries can surface them. This closes
 * the compound interest loop — every interaction makes the next one better.
 *
 * Called from mcp-server/src/index.ts after brief or stress_test tool handlers
 * return their synthesis to the user. Fire-and-forget — don't block the response.
 */

import { v4 as uuidv4 } from "uuid";
import { query } from "./db";
import { computeContentHash, checkDuplicate } from "./ingestionPipeline";
import { embedTexts } from "./claims";

// ─── Types ──────────────────────────────────────────────────────

export interface DepositEvaluationParams {
  mode: "brief" | "stress_test";
  queryText: string;
  synthesisText: string;
  evidenceIds: string[];
  claimIds: string[];
  signalFlags: string[];
  productId: string;
}

interface DepositMetadata {
  queryText: string;
  evidenceIds: string[];
  claimIds: string[];
  signalFlags: string[];
  mode: "brief" | "stress_test";
  timestamp: string;
}

// ─── Deposit Function ───────────────────────────────────────────

/**
 * Deposit a brief or stress-test synthesis back into the corpus as an
 * evidence record. Returns the new evidence_record ID, or null if the
 * content is a duplicate (same product_id + content_hash).
 */
export async function depositEvaluation({
  mode,
  queryText,
  synthesisText,
  evidenceIds,
  claimIds,
  signalFlags,
  productId,
}: DepositEvaluationParams): Promise<string | null> {
  // 1. Compute content hash for dedup
  const contentHash = computeContentHash(synthesisText);

  // 2. Check for duplicate
  const existing = await checkDuplicate(productId, contentHash);
  if (existing) {
    return null; // skip — identical synthesis already deposited
  }

  // 3. Generate new record ID
  const id = uuidv4();

  // 4. Build title
  const modeLabel = mode === "brief" ? "Brief" : "Stress-test";
  const truncatedQuery = queryText.slice(0, 80);
  const title = `${modeLabel}: ${truncatedQuery}`;

  // 5. Embed synthesis text
  const [embedding] = await embedTexts([synthesisText]);

  // 6. Build metadata
  const metadata: DepositMetadata = {
    queryText,
    evidenceIds,
    claimIds,
    signalFlags,
    mode,
    timestamp: new Date().toISOString(),
  };

  // 7. Build summary — first 500 chars of synthesis + JSON metadata
  const summaryText = synthesisText.slice(0, 500);
  const summaryWithMeta = JSON.stringify({
    preview: summaryText,
    ...metadata,
  });

  // 8. INSERT into evidence_records
  await query(
    `INSERT INTO evidence_records (
      id, product_id, source_type, source_external_id,
      title, content, summary, content_hash,
      embedding, embedding_model, embedded_at,
      source_ref, is_tombstoned, source_version,
      type, state, is_enabled
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8,
      $9, $10, $11,
      $12, $13, $14,
      $15, $16, $17
    )`,
    [
      id,
      productId,
      "evaluation",
      id, // self-referencing
      title,
      synthesisText,
      summaryWithMeta,
      contentHash,
      `[${embedding.join(",")}]`,
      "text-embedding-3-small",
      new Date().toISOString(),
      `mcp://${mode}`,
      false,
      1,
      "evaluation", // type column
      "active", // state
      true, // is_enabled
    ]
  );

  return id;
}
