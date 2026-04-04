/**
 * PRD 13 — Briefing-First Evaluation Core
 *
 * Shared retrieval pipeline for brief, scan, and stress_test modes.
 * Uses the same hybrid search (vector + FTS + RRF) as evaluateProposal().
 * Returns evidence + prompt material for the calling LLM to synthesize.
 */

import { embedTexts, hybridClaimSearch, hybridEvidenceSearch } from "./claims";
import type { ClaimSearchResult } from "./claims";
import { query } from "./db";
import {
  BRIEF_SYSTEM_PROMPT,
  SCAN_SYSTEM_PROMPT,
  STRESS_TEST_SYSTEM_PROMPT,
  buildBriefingPayload,
} from "./briefingPrompts";
import { inferAuthority, inferCustomerVsInternal, batchFetchClaims } from "./evidenceEnrichment";

// ─── Types ───────────────────────────────────────────────────────

export type BriefingMode = "brief" | "scan" | "stress_test";
export type BriefDepth = "quick" | "standard" | "deep";

export interface BriefingInput {
  /** The topic (brief) or proposal text (stress_test) */
  text: string;
  mode: BriefingMode;
  product_id?: string | null;
  /** Only applies to brief mode */
  depth?: BriefDepth;
}

export interface BriefingResult {
  mode: BriefingMode;
  systemPrompt: string;
  userContent: string;
  evidence: Array<{
    id: string;
    type: string;
    title: string;
    summary: string;
    source_ref: string | null;
    state: string;
    source_date?: string | null;
    source_type?: string;
    authority?: string;
    customer_vs_internal?: string;
    claims?: Array<{ claim_text: string; claim_type: string; stance: string; stance_signal: number | null; claim_layer: string; claim_origin: string | null; extraction_confidence: string | null; source_excerpt: string | null }> | null;
  }>;
  evidence_count: number;
  depth?: BriefDepth;
}

// ─── Depth → Top-K mapping ───────────────────────────────────────

const DEPTH_TO_TOP_K: Record<BriefDepth, number> = {
  quick: 5,
  standard: 15,
  deep: 30,
};

// ─── Helpers ─────────────────────────────────────────────────────

function truncateForPrompt(content: string, maxChars: number = 3200): string {
  if (content.length <= maxChars) return content;
  const truncated = content.substring(0, maxChars);
  const lastPeriod = truncated.lastIndexOf(".");
  return lastPeriod > maxChars * 0.5
    ? truncated.substring(0, lastPeriod + 1) + " [truncated]"
    : truncated + "... [truncated]";
}

// ─── Core Pipeline ───────────────────────────────────────────────

/**
 * Run the briefing pipeline: retrieve evidence, then synthesize with
 * the appropriate prompt for the given mode.
 */
export async function runBriefing(input: BriefingInput): Promise<BriefingResult> {
  const { text, mode, product_id } = input;
  const depth = input.depth ?? "standard";
  // Top-K: how many evidence records end up in the context window after RRF merge.
  // Scan=40, stress_test=80, brief=depth-dependent.
  // TODO: make scan/stress_test K configurable via provider_settings
  const topK = mode === "brief" ? DEPTH_TO_TOP_K[depth] : mode === "scan" ? 40 : 80;

  // ── 1. Embed query ──
  const queryEmbedding = await embedTexts([text]).then((r) => r[0]);

  // ── 2. Parallel hybrid retrieval ──
  let allEvidence: Array<{
    id: string;
    type: string;
    title: string;
    summary: string;
    source_ref: string | null;
    state: string;
    source_date: string | null;
    source_type: string;
    authority: string;
    customer_vs_internal: string;
    claims: Array<{ claim_text: string; claim_type: string; stance: string; stance_signal: number | null; claim_layer: string; claim_origin: string | null; extraction_confidence: string | null; source_excerpt: string | null }> | null;
  }> = [];

  try {
    const [claimResults, evidenceResults] = await Promise.all([
      hybridClaimSearch(text, {
        productId: product_id,
        limit: topK * 2,
        mode: "test_eval",
        queryEmbedding,
      }).catch((err) => {
        console.warn("Claim search failed:", err);
        return [] as ClaimSearchResult[];
      }),
      hybridEvidenceSearch(text, {
        productId: product_id,
        limit: topK,
        queryEmbedding,
      }).catch((err) => {
        console.warn("Evidence search failed:", err);
        return [] as Array<{ id: string; [key: string]: unknown }>;
      }),
    ]);

    // Merge evidence IDs with RRF scores preserved for ranking
    const scoreMap = new Map<string, number>();
    for (const cr of claimResults) {
      if (cr.claim.source_id) {
        const prev = scoreMap.get(cr.claim.source_id) ?? 0;
        scoreMap.set(cr.claim.source_id, prev + (cr.rrf_score ?? 0));
      }
    }
    for (const er of evidenceResults) {
      const prev = scoreMap.get(er.id) ?? 0;
      scoreMap.set(er.id, prev + ((er as Record<string, unknown>).rrf_score as number ?? 0));
    }
    const evidenceIds = new Set<string>(scoreMap.keys());

    if (evidenceIds.size > 0) {
      const { rows: fullEvidence } = await query(
        `SELECT id, title, summary, content, source_ref, state, type, source_date, source_type
         FROM evidence_records WHERE id = ANY($1) AND is_enabled = true`,
        [Array.from(evidenceIds)]
      );

      allEvidence = (fullEvidence || []).map((er: Record<string, unknown>) => ({
        id: er.id as string,
        type: er.type as string,
        title: er.title as string,
        summary: er.content
          ? truncateForPrompt(er.content as string, 3200)
          : (er.summary as string) || "",
        source_ref: er.source_ref as string | null,
        state: er.state as string,
        source_date: (er.source_date as string) ?? null,
        source_type: (er.source_type as string) ?? "unknown",
        authority: inferAuthority(er.type as string, er.title as string),
        customer_vs_internal: inferCustomerVsInternal(er.type as string, er.title as string),
        claims: null,
      }));

      // Enrich evidence with claims
      const enrichIds = allEvidence.map(e => e.id);
      const claimsMap = await batchFetchClaims(enrichIds);
      allEvidence = allEvidence.map(e => ({
        ...e,
        claims: claimsMap.get(e.id) ?? null,
      }));

      // Sort by RRF score (highest first)
      allEvidence.sort((a, b) => (scoreMap.get(b.id) ?? 0) - (scoreMap.get(a.id) ?? 0));

      // Cap at top-K
      if (allEvidence.length > topK) {
        allEvidence = allEvidence.slice(0, topK);
      }
    }
  } catch (err) {
    console.warn("Retrieval failed:", err);
  }

  // ── 3. ILIKE fallback ──
  if (allEvidence.length === 0) {
    const keywords = text
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9]/g, ""))
      .filter((w) => w.length > 3)
      .slice(0, 5);

    if (keywords.length > 0) {
      const params: (string | number)[] = [];
      let paramIdx = 1;

      // Optional product_id filter
      let productFilter = "";
      if (product_id) {
        productFilter = `product_id = $${paramIdx} AND `;
        params.push(product_id);
        paramIdx++;
      }

      // LIKE conditions for keywords
      const likeConditions = keywords.map((k) => {
        const idx = paramIdx;
        params.push(`%${k}%`);
        paramIdx++;
        return `(LOWER(title) LIKE $${idx} OR LOWER(summary) LIKE $${idx})`;
      });

      // LIMIT param
      params.push(topK);
      const limitIdx = paramIdx;

      const { rows } = await query(
        `SELECT id, type, title, summary, source_ref, state, source_date, source_type FROM evidence_records WHERE ${productFilter}is_enabled = true AND (${likeConditions.join(" OR ")}) LIMIT $${limitIdx}`,
        params
      );

      allEvidence = (rows || []).map((r: Record<string, unknown>) => ({
        id: r.id as string,
        type: r.type as string,
        title: r.title as string,
        summary: (r.summary as string) || "",
        source_ref: r.source_ref as string | null,
        state: r.state as string,
        source_date: (r.source_date as string) ?? null,
        source_type: (r.source_type as string) ?? "unknown",
        authority: inferAuthority(r.type as string, r.title as string),
        customer_vs_internal: inferCustomerVsInternal(r.type as string, r.title as string),
        claims: null,
      }));

      // Enrich fallback evidence with claims
      const fallbackIds = allEvidence.map(e => e.id);
      const fallbackClaimsMap = await batchFetchClaims(fallbackIds);
      allEvidence = allEvidence.map(e => ({
        ...e,
        claims: fallbackClaimsMap.get(e.id) ?? null,
      }));
    }
  }

  // ── 4. Return evidence + prompt material ──
  // The calling LLM (Claude Code / Cursor) does synthesis
  const systemPrompt = mode === "brief" ? BRIEF_SYSTEM_PROMPT : mode === "scan" ? SCAN_SYSTEM_PROMPT : STRESS_TEST_SYSTEM_PROMPT;
  const userContent = buildBriefingPayload(text, allEvidence, mode);

  return {
    mode,
    systemPrompt,
    userContent,
    evidence: allEvidence,
    evidence_count: allEvidence.length,
    ...(mode === "brief" ? { depth } : {}),
  };
}
