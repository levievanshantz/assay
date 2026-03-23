/**
 * Notion Sync — PRD 9.1: Detect changes in tracked Notion pages and re-process.
 *
 * Flow:
 * 1. Get all tracked Notion pages (distinct source_external_id where source_type='notion')
 * 2. For each page: check last_edited_time via Notion API
 * 3. If page was edited after our last_synced_at: re-fetch, re-chunk, compare hashes
 * 4. For changed chunks: update content, re-embed, re-extract claims (supersede old)
 * 5. For deleted pages: tombstone evidence records
 *
 * Similarity threshold: 0.95 (cosmetic changes skipped, meaningful changes re-extracted)
 */

import { query } from "./db";
import {
  fetchNotionBlocks,
  fetchNotionPageMeta,
  blocksToText,
  chunkAtHeadings,
} from "./notionClient";
import {
  computeContentHash,
  tombstoneEvidenceBySource,
  supersedeClaimsForSource,
} from "./ingestionPipeline";
import { embedTexts, processSourceClaims } from "./claims";
import { getProviderSettings } from "./storage";

const SIMILARITY_THRESHOLD = 0.95;

// ─── Types ──────────────────────────────────────────────────────

export interface TrackedPage {
  sourceExternalId: string;
  lastSyncedAt: string | null;
  sectionCount: number;
}

export interface SyncResult {
  pagesChecked: number;
  pagesChanged: number;
  pagesDeleted: number;
  pagesUnchanged: number;
  sectionsUpdated: number;
  sectionsSkipped: number;
  sectionsNew: number;
  claimsSuperseded: number;
  errors: string[];
}

// ─── Get Tracked Pages ──────────────────────────────────────────

/**
 * Get all Notion pages that have been ingested into the corpus.
 * Groups by source_external_id (page ID) and returns the most recent last_synced_at.
 */
export async function getTrackedNotionPages(): Promise<TrackedPage[]> {
  const { rows } = await query(
    `SELECT source_external_id, last_synced_at FROM evidence_records
     WHERE source_type = 'notion' AND is_tombstoned = false AND source_external_id IS NOT NULL`
  );

  if (!rows || rows.length === 0) return [];

  // Group by page ID, get latest last_synced_at and count
  const pageMap = new Map<
    string,
    { lastSyncedAt: string | null; count: number }
  >();

  for (const row of rows) {
    const pageId = row.source_external_id;
    const existing = pageMap.get(pageId);
    if (!existing) {
      pageMap.set(pageId, { lastSyncedAt: row.last_synced_at, count: 1 });
    } else {
      existing.count++;
      if (
        row.last_synced_at &&
        (!existing.lastSyncedAt || row.last_synced_at > existing.lastSyncedAt)
      ) {
        existing.lastSyncedAt = row.last_synced_at;
      }
    }
  }

  return Array.from(pageMap.entries()).map(([pageId, info]) => ({
    sourceExternalId: pageId,
    lastSyncedAt: info.lastSyncedAt,
    sectionCount: info.count,
  }));
}

// ─── Sync Single Page ───────────────────────────────────────────

async function syncSinglePage(
  pageId: string,
  notionApiKey: string,
  productId: string,
  extractClaims: boolean
): Promise<{
  status: "unchanged" | "updated" | "deleted" | "error";
  sectionsUpdated: number;
  sectionsSkipped: number;
  sectionsNew: number;
  claimsSuperseded: number;
  error?: string;
}> {
  // 1. Check page status in Notion
  let pageMeta;
  try {
    pageMeta = await fetchNotionPageMeta(pageId, notionApiKey);
  } catch (err: any) {
    if (err.message?.includes("404") || err.message?.includes("not found")) {
      await tombstoneEvidenceBySource("notion", pageId, "source_deleted");
      return {
        status: "deleted",
        sectionsUpdated: 0,
        sectionsSkipped: 0,
        sectionsNew: 0,
        claimsSuperseded: 0,
      };
    }
    return {
      status: "error",
      sectionsUpdated: 0,
      sectionsSkipped: 0,
      sectionsNew: 0,
      claimsSuperseded: 0,
      error: err.message,
    };
  }

  // 2. If page is in trash, tombstone it
  if (pageMeta.inTrash) {
    await tombstoneEvidenceBySource("notion", pageId, "source_deleted");
    return {
      status: "deleted",
      sectionsUpdated: 0,
      sectionsSkipped: 0,
      sectionsNew: 0,
      claimsSuperseded: 0,
    };
  }

  // 3. Check if page was edited after our last sync
  const { rows: existingRecords } = await query(
    `SELECT id, content_hash, last_synced_at, title, source_version, embedding
     FROM evidence_records
     WHERE source_type = 'notion' AND source_external_id = $1 AND is_tombstoned = false`,
    [pageId]
  );

  if (!existingRecords || existingRecords.length === 0) {
    return {
      status: "unchanged",
      sectionsUpdated: 0,
      sectionsSkipped: 0,
      sectionsNew: 0,
      claimsSuperseded: 0,
    };
  }

  // Find the latest last_synced_at across all sections
  const latestSync = existingRecords
    .map((r) => r.last_synced_at)
    .filter(Boolean)
    .sort()
    .pop();

  const notionEditTime = new Date(pageMeta.lastEditedTime).getTime();
  const ourSyncTime = latestSync ? new Date(latestSync).getTime() : 0;

  if (notionEditTime <= ourSyncTime) {
    return {
      status: "unchanged",
      sectionsUpdated: 0,
      sectionsSkipped: 0,
      sectionsNew: 0,
      claimsSuperseded: 0,
    };
  }

  // Fetch API key for claims extraction if needed
  let anthropicApiKey: string | undefined;
  if (extractClaims) {
    const settings = await getProviderSettings();
    anthropicApiKey = settings?.api_key_hash ?? undefined;
  }

  // 4. Page changed — re-fetch and compare
  const blocks = await fetchNotionBlocks(pageId, notionApiKey);
  const textLines = blocksToText(blocks);
  const fullText = textLines.join("\n");
  const chunks = chunkAtHeadings(fullText, pageMeta.title);

  // Build hash map of existing sections
  const existingByHash = new Map<string, (typeof existingRecords)[0]>();
  for (const record of existingRecords) {
    if (record.content_hash) {
      existingByHash.set(record.content_hash, record);
    }
  }

  let sectionsUpdated = 0;
  let sectionsSkipped = 0;
  let sectionsNew = 0;
  let totalClaimsSuperseded = 0;

  const notionUrl = `https://www.notion.so/${pageId}`;
  const now = new Date().toISOString();
  const newHashes = new Set<string>();

  for (const chunk of chunks) {
    const contentHash = computeContentHash(chunk.text);
    newHashes.add(contentHash);

    if (existingByHash.has(contentHash)) {
      // Exact hash match — content unchanged, skip
      sectionsSkipped++;

      // Update last_synced_at to show we checked
      const record = existingByHash.get(contentHash)!;
      await query(
        "UPDATE evidence_records SET last_synced_at = $1 WHERE id = $2",
        [now, record.id]
      );

      continue;
    }

    // Try to find a matching section by title prefix
    const matchingRecord = existingRecords.find(
      (r) => r.title && chunk.title && r.title === chunk.title
    );

    if (matchingRecord && matchingRecord.embedding) {
      // Check embedding similarity to decide if this is a meaningful change
      const [newEmbedding] = await embedTexts([chunk.text]);
      const similarity = cosineSimilarity(
        matchingRecord.embedding,
        newEmbedding
      );

      if (similarity >= SIMILARITY_THRESHOLD) {
        // Cosmetic change — update content and hash but don't re-extract claims
        await query(
          `UPDATE evidence_records SET content = $1, summary = $2, content_hash = $3, embedding = $4, embedded_at = $5, last_synced_at = $6
           WHERE id = $7`,
          [chunk.text, chunk.text.slice(0, 500), contentHash, `[${newEmbedding.join(",")}]`, now, now, matchingRecord.id]
        );

        sectionsSkipped++;
        continue;
      }

      // Meaningful change — update and re-extract
      const newVersion = (matchingRecord.source_version ?? 1) + 1;

      await query(
        `UPDATE evidence_records SET title = $1, content = $2, summary = $3, content_hash = $4, embedding = $5, embedded_at = $6, last_synced_at = $7, source_version = $8
         WHERE id = $9`,
        [chunk.title, chunk.text, chunk.text.slice(0, 500), contentHash, `[${newEmbedding.join(",")}]`, now, now, newVersion, matchingRecord.id]
      );

      if (extractClaims) {
        const superseded = await supersedeClaimsForSource(
          "evidence",
          matchingRecord.id
        );
        totalClaimsSuperseded += superseded;

        await processSourceClaims({
          sourceType: "evidence",
          sourceId: matchingRecord.id,
          sourceText: chunk.text,
          productId,
          sourceKind: "document",
          sourceVersion: newVersion,
          anthropicApiKey: anthropicApiKey!,
        });
      }

      sectionsUpdated++;
    } else {
      // New section — insert fresh
      const { rows: newRecordRows } = await query(
        `INSERT INTO evidence_records (type, product_id, title, summary, content, source_ref, source_type, source_external_id, content_hash, source_version, state, is_enabled, is_tombstoned)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        ["strategy", productId, chunk.title, chunk.text.slice(0, 500), chunk.text, notionUrl, "notion", pageId, contentHash, 1, "current", true, false]
      );

      if (newRecordRows.length === 0) continue;
      const newRecord = newRecordRows[0];

      // Embed
      const [embedding] = await embedTexts([chunk.text]);
      await query(
        `UPDATE evidence_records SET embedding = $1, embedding_model = $2, embedded_at = $3, last_synced_at = $4
         WHERE id = $5`,
        [`[${embedding.join(",")}]`, "text-embedding-3-small", now, now, newRecord.id]
      );

      if (extractClaims) {
        await processSourceClaims({
          sourceType: "evidence",
          sourceId: newRecord.id,
          sourceText: chunk.text,
          productId,
          sourceKind: "document",
          sourceVersion: 1,
          anthropicApiKey: anthropicApiKey!,
        });
      }

      sectionsNew++;
    }
  }

  // Check for sections that were removed from the page
  for (const record of existingRecords) {
    if (record.content_hash && !newHashes.has(record.content_hash)) {
      const wasHandled =
        chunks.some((c) => c.title === record.title) ||
        sectionsUpdated > 0 ||
        sectionsNew > 0;

      if (!wasHandled) {
        await query(
          "UPDATE evidence_records SET is_tombstoned = true, tombstone_reason = 'superseded', last_synced_at = $1 WHERE id = $2",
          [now, record.id]
        );
      }
    }
  }

  return {
    status: sectionsUpdated > 0 || sectionsNew > 0 ? "updated" : "unchanged",
    sectionsUpdated,
    sectionsSkipped,
    sectionsNew,
    claimsSuperseded: totalClaimsSuperseded,
  };
}

// ─── Full Sync Cycle ────────────────────────────────────────────

export async function syncAllNotionPages(opts: {
  notionApiKey: string;
  productId: string;
  extractClaims?: boolean;
  maxPages?: number;
}): Promise<SyncResult> {
  const {
    notionApiKey,
    productId,
    extractClaims = true,
    maxPages,
  } = opts;

  const trackedPages = await getTrackedNotionPages();
  const pagesToSync = maxPages
    ? trackedPages.slice(0, maxPages)
    : trackedPages;

  const result: SyncResult = {
    pagesChecked: pagesToSync.length,
    pagesChanged: 0,
    pagesDeleted: 0,
    pagesUnchanged: 0,
    sectionsUpdated: 0,
    sectionsSkipped: 0,
    sectionsNew: 0,
    claimsSuperseded: 0,
    errors: [],
  };

  // Circuit breaker
  let changedCount = 0;
  const circuitBreakerThreshold = Math.max(
    Math.ceil(pagesToSync.length * 0.2),
    5
  );

  for (let i = 0; i < pagesToSync.length; i++) {
    const page = pagesToSync[i];

    try {
      const pageResult = await syncSinglePage(
        page.sourceExternalId,
        notionApiKey,
        productId,
        extractClaims
      );

      switch (pageResult.status) {
        case "unchanged":
          result.pagesUnchanged++;
          break;
        case "updated":
          result.pagesChanged++;
          changedCount++;
          break;
        case "deleted":
          result.pagesDeleted++;
          break;
        case "error":
          result.errors.push(
            `Page ${page.sourceExternalId}: ${pageResult.error}`
          );
          break;
      }

      result.sectionsUpdated += pageResult.sectionsUpdated;
      result.sectionsSkipped += pageResult.sectionsSkipped;
      result.sectionsNew += pageResult.sectionsNew;
      result.claimsSuperseded += pageResult.claimsSuperseded;

      // Circuit breaker check
      if (i >= 9 && changedCount >= circuitBreakerThreshold) {
        result.errors.push(
          `CIRCUIT BREAKER: ${changedCount} of ${i + 1} pages changed (>${circuitBreakerThreshold} threshold). ` +
            `Halting sync to prevent runaway re-extraction. Review manually.`
        );
        break;
      }

      // Rate limiting
      if (i < pagesToSync.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (err: any) {
      result.errors.push(
        `Page ${page.sourceExternalId}: ${err.message}`
      );
    }
  }

  return result;
}

// ─── Cosine Similarity ──────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  return magnitude === 0 ? 0 : dot / magnitude;
}
