/**
 * Evidence payload enrichment functions.
 * Deterministic inference -- no LLM calls.
 */

import { query } from "./db";

// --- Authority Inference -------------------------------------------------

type Authority = "prd" | "spec" | "strategy" | "research" | "decision_record" | "interview" | "evaluation" | "opinion" | "unknown";

export function inferAuthority(type: string, title: string): Authority {
  const t = type?.toLowerCase() ?? "";
  const tl = title?.toLowerCase() ?? "";

  if (t === "prd") return "prd";
  if (t === "spec") return "spec";
  if (t === "strategy") return "strategy";
  if (t === "architecture") return "decision_record";
  if (t === "evaluation") return "evaluation";
  if (t === "philosophy") return "decision_record";
  if (t === "research") return "research";

  // Title-based inference
  if (tl.includes("prd")) return "prd";
  if (tl.includes("spec")) return "spec";
  if (tl.includes("interview") || tl.includes("discovery")) return "interview";
  if (tl.includes("decision") || tl.includes("architecture")) return "decision_record";
  if (tl.includes("research") || tl.includes("analysis")) return "research";

  return "unknown";
}

// --- Customer vs Internal Inference --------------------------------------

type CustomerVsInternal = "customer" | "internal" | "mixed" | "unknown";

export function inferCustomerVsInternal(type: string, title: string): CustomerVsInternal {
  const t = type?.toLowerCase() ?? "";
  const tl = title?.toLowerCase() ?? "";

  // Customer signals
  if (t === "research" && (tl.includes("interview") || tl.includes("customer") || tl.includes("discovery"))) return "customer";
  if (tl.includes("interview") || tl.includes("customer feedback") || tl.includes("user research")) return "customer";
  if (tl.includes("voice of customer") || tl.includes("voc")) return "customer";

  // Internal signals
  if (t === "prd" || t === "spec" || t === "architecture" || t === "philosophy") return "internal";
  if (t === "strategy") return "internal";
  if (t === "evaluation") return "internal";
  if (t === "stoic_text") return "internal";

  return "unknown";
}

// --- Claims Join ---------------------------------------------------------

export interface EnrichedClaim {
  claim_text: string;
  claim_type: string;
  stance: string;
  stance_signal: number | null;
  claim_layer: string;
  claim_origin: string | null;
  extraction_confidence: string | null;
  source_excerpt: string | null;
}

/**
 * Batch-fetch top claims for multiple evidence records.
 * Returns a Map of evidence_id -> top 5 claims.
 * Single query, not N+1.
 */
export async function batchFetchClaims(
  evidenceIds: string[]
): Promise<Map<string, EnrichedClaim[]>> {
  if (evidenceIds.length === 0) return new Map();

  const { rows } = await query(
    `SELECT source_id, claim_text, claim_type, stance, stance_signal, claim_layer, claim_origin, extraction_confidence, source_excerpt
     FROM (
       SELECT source_id::text, claim_text, claim_type, stance, stance_signal, claim_layer, claim_origin, extraction_confidence, source_excerpt,
              ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY extraction_confidence DESC NULLS LAST) as rn
       FROM claims
       WHERE source_id::text = ANY($1)
         AND superseded_at IS NULL
     ) ranked
     WHERE rn <= 5`,
    [evidenceIds]
  );

  const map = new Map<string, EnrichedClaim[]>();
  for (const row of rows) {
    const id = row.source_id as string;
    if (!map.has(id)) map.set(id, []);
    map.get(id)!.push({
      claim_text: row.claim_text as string,
      claim_type: row.claim_type as string,
      stance: row.stance as string,
      stance_signal: row.stance_signal as number | null,
      claim_layer: row.claim_layer as string,
      claim_origin: row.claim_origin as string | null,
      extraction_confidence: row.extraction_confidence as string | null,
      source_excerpt: row.source_excerpt as string | null,
    });
  }

  return map;
}
