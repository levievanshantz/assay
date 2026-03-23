/**
 * PRD 13 — Briefing-First Evaluation Core
 *
 * Shared retrieval pipeline for brief and stress_test modes.
 * Uses the same hybrid search (vector + FTS + RRF) as evaluateProposal(),
 * but synthesizes with mode-specific prompts instead of the verdict prompt.
 */

import { embedTexts, hybridClaimSearch, hybridEvidenceSearch } from "./claims";
import type { ClaimSearchResult } from "./claims";
import { query } from "./db";
import {
  BRIEF_SYSTEM_PROMPT,
  STRESS_TEST_SYSTEM_PROMPT,
  buildBriefingPayload,
} from "./briefingPrompts";

// ─── Types ───────────────────────────────────────────────────────

export type BriefingMode = "brief" | "stress_test";
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
  result: Record<string, unknown>;
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

function tryParseJSON(text: string): unknown {
  const cleaned = text
    .replace(/^```json?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ─── Core Pipeline ───────────────────────────────────────────────

/**
 * Run the briefing pipeline: retrieve evidence, then synthesize with
 * the appropriate prompt for the given mode.
 */
export async function runBriefing(input: BriefingInput): Promise<BriefingResult> {
  const { text, mode, product_id } = input;
  const depth = input.depth ?? "standard";
  const stressTestK = Number(process.env.STRESS_TEST_MAX_EVIDENCE) || 100;
  const topK = mode === "brief" ? DEPTH_TO_TOP_K[depth] : stressTestK;

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

    // Merge evidence IDs from both sources
    const evidenceIds = new Set<string>();
    for (const cr of claimResults) {
      if (cr.claim.source_id) evidenceIds.add(cr.claim.source_id);
    }
    for (const er of evidenceResults) {
      evidenceIds.add(er.id);
    }

    if (evidenceIds.size > 0) {
      const { rows: fullEvidence } = await query(
        `SELECT id, title, summary, content, source_ref, state, type
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
      }));

      // Apply top-K cap
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
        `SELECT id, type, title, summary, source_ref, state FROM evidence_records WHERE ${productFilter}is_enabled = true AND (${likeConditions.join(" OR ")}) LIMIT $${limitIdx}`,
        params
      );

      allEvidence = (rows || []).map((r: Record<string, unknown>) => ({
        id: r.id as string,
        type: r.type as string,
        title: r.title as string,
        summary: (r.summary as string) || "",
        source_ref: r.source_ref as string | null,
        state: r.state as string,
      }));
    }
  }

  // ── 4. LLM synthesis ──
  const systemPrompt = mode === "brief" ? BRIEF_SYSTEM_PROMPT : STRESS_TEST_SYSTEM_PROMPT;
  const userContent = buildBriefingPayload(text, allEvidence, mode);

  // Get provider settings for the LLM call
  const { rows: settingsRows } = await query(
    "SELECT provider, model, api_key_hash FROM provider_settings LIMIT 1"
  );
  const settings = settingsRows[0];
  if (!settings?.api_key_hash) {
    throw new Error("No API key configured. Go to Settings to add your API key.");
  }

  // Use Anthropic SDK for LLM call (same pattern as llmClient.ts)
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: settings.api_key_hash });

  const MAX_RETRIES = 2;
  let response;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      response = await client.messages.create({
        model: settings.model || "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      });
      break;
    } catch (err: unknown) {
      const error = err as { status?: number; error?: { type?: string; error?: { type?: string } } };
      const isRetryable =
        error?.status === 529 ||
        error?.status === 429 ||
        error?.error?.type === "overloaded_error" ||
        error?.error?.error?.type === "overloaded_error";
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = (attempt + 1) * 5000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (isRetryable) {
        throw new Error("The AI service is temporarily at capacity. Please wait and try again.");
      }
      throw err;
    }
  }

  if (!response) {
    throw new Error("Failed to get a response from the AI service after retries.");
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from AI service.");
  }

  const parsed = tryParseJSON(textBlock.text);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Could not parse briefing response as JSON. Please try again.");
  }

  return {
    mode,
    result: parsed as Record<string, unknown>,
    evidence_count: allEvidence.length,
    ...(mode === "brief" ? { depth } : {}),
  };
}
