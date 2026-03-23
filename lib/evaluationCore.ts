import { v4 as uuidv4 } from "uuid";
import {
  getTest,
  getProviderSettings,
  getActivePrompt,
  searchEvidence,
  getTests,
  createEvaluation,
  updateTest,
  createTest,
  upsertTestEvidence,
  embedEvidence,
  type TestProposal,
  type EvaluationResult,
} from "./storage";
import { evaluateTest as callLLM } from "./llmClient";
import { hybridClaimSearch, hybridEvidenceSearch, embedTexts } from "./claims";
import type { ClaimSearchResult, QueryMode } from "./claims";
import { query } from "./db";

// ─── Helpers ─────────────────────────────────────────────────────

/** Truncate content at a sentence boundary for LLM prompt inclusion */
function truncateForPrompt(content: string, maxChars: number = 3200): string {
  if (content.length <= maxChars) return content;
  const truncated = content.substring(0, maxChars);
  const lastPeriod = truncated.lastIndexOf(".");
  return lastPeriod > maxChars * 0.5
    ? truncated.substring(0, lastPeriod + 1) + " [truncated]"
    : truncated + "... [truncated]";
}

// ─── Types ───────────────────────────────────────────────────────

export interface EvaluateProposalInput {
  /** Existing test ID (bypasses test creation) */
  test_id?: string;
  /** Used when creating a new test on-the-fly (e.g. from MCP) */
  title?: string;
  objective?: string;
  prd_body?: string;
  additional_notes?: string;
  product_id?: string;
  /** Source label: "web" (default) or "mcp" */
  source?: string;
  /** Query mode for claim search layer weighting (PRD 7 compat) */
  mode?: QueryMode;
}

export interface EvaluateProposalResult {
  evaluation: { result: EvaluationResult; matches: import("./storage").EvaluationMatch[] };
  test: TestProposal;
  matchCount: number;
  totalEvidenceSearched: number;
}

// ─── Core Evaluation Pipeline ─────────────────────────────────────

/**
 * Unified evaluation pipeline used by both the web UI and MCP server.
 * 1. Resolve or create a test_proposal record
 * 2. Fetch provider settings + active prompt
 * 3. Hybrid evidence search (vector + FTS + RRF)
 * 4. LLM evaluation
 * 5. Save evaluation result + matches
 * 6. Update test status
 */
export async function evaluateProposal(
  input: EvaluateProposalInput
): Promise<EvaluateProposalResult> {
  // ── 1. Resolve test ──
  let test: TestProposal | undefined;

  if (input.test_id) {
    test = await getTest(input.test_id);
    if (!test) throw new Error("Test not found");
  } else if (input.title) {
    // Create a new test on-the-fly (MCP path)
    test = await createTest({
      group_id: uuidv4(),
      version: 1,
      title: input.title,
      objective: input.objective || "",
      prd_body: input.prd_body || "",
      additional_notes: input.additional_notes || null,
      product_id: input.product_id || null,
      project_id: null,
      hypothesis: null,
      test_type: null,
      method: null,
      created_by: input.source || "web",
      status: "draft",
    });
  } else {
    throw new Error("Either test_id or title is required");
  }

  // ── 2. Provider settings + prompt ──
  const settings = await getProviderSettings();
  if (!settings?.api_key_hash) {
    throw new Error("No API key configured. Go to Settings to add your API key.");
  }

  const prompt = await getActivePrompt();
  if (!prompt) {
    throw new Error("No active operation prompt found. Go to Settings.");
  }

  // ── 3. Parallel retrieval (PRD 6.5) ──
  const queryText = [test.title, test.objective, test.prd_body]
    .filter(Boolean)
    .join(" ");

  // Single embedding call, shared by both search paths
  const queryEmbedding = await embedTexts([queryText]).then((r) => r[0]);
  const mode: QueryMode = input.mode || "test_eval";

  // Load current retrieval config for metadata + Top-K limit (Patch 5 + Top-K)
  let metadataWeights: Record<string, number> = { observation: 1.0, interpretation: 1.0, intention: 1.0 };
  let maxEvidenceLimit = 0; // 0 = unlimited
  try {
    const { rows: weightSettings } = await query(
      "SELECT retrieval_config FROM provider_settings LIMIT 1"
    );
    if (weightSettings[0]?.retrieval_config?.layer_weights?.[mode]) {
      metadataWeights = weightSettings[0].retrieval_config.layer_weights[mode];
    }
    if (weightSettings[0]?.retrieval_config?.max_evidence_limit) {
      maxEvidenceLimit = weightSettings[0].retrieval_config.max_evidence_limit;
    }
  } catch {
    // Fall back to defaults silently
  }

  // Fire both searches in parallel
  let allEvidence: Array<{
    id: string;
    type: string;
    title: string;
    summary: string;
    source_ref: string | null;
    state: string;
  }> = [];

  // Retrieval metadata (Patch 5)
  const retrievalMetadata: Record<string, unknown> = {
    claim_results_count: 0,
    evidence_results_count: 0,
    merged_evidence_ids: [] as string[],
    total_evidence_in_prompt: 0,
    search_mode: mode,
    layer_weights: metadataWeights,
    fallback_used: false,
    embedding_model: 'text-embedding-3-small',
  };

  try {
    const [claimResults, evidenceResults] = await Promise.all([
      hybridClaimSearch(queryText, {
        productId: test.product_id,
        limit: 30,
        mode,
        queryEmbedding,
      }).catch((err) => {
        console.warn("Claim search failed:", err);
        return [] as ClaimSearchResult[];
      }),
      hybridEvidenceSearch(queryText, {
        productId: test.product_id,
        limit: 20,
        queryEmbedding,
      }).catch((err) => {
        console.warn("Evidence search failed:", err);
        return [] as Array<{ id: string; [key: string]: unknown }>;
      }),
    ]);

    // Update retrieval metadata counts (Patch 5)
    retrievalMetadata.claim_results_count = claimResults.length;
    retrievalMetadata.evidence_results_count = evidenceResults.length;

    // Resolve claim results to parent evidence_record IDs
    const evidenceIds = new Set<string>();
    for (const cr of claimResults) {
      if (cr.claim.source_id) evidenceIds.add(cr.claim.source_id);
    }
    for (const er of evidenceResults) {
      evidenceIds.add(er.id);
    }

    if (evidenceIds.size > 0) {
      // Fetch full evidence records for all merged IDs
      const { rows: fullEvidence } = await query(
        `SELECT id, title, summary, content, source_ref, state, type
         FROM evidence_records WHERE id = ANY($1) AND is_enabled = true`,
        [Array.from(evidenceIds)]
      );

      allEvidence = (fullEvidence || []).map((er) => ({
        id: er.id,
        type: er.type,
        title: er.title,
        summary: er.content
          ? truncateForPrompt(er.content, 3200)
          : er.summary || "",
        source_ref: er.source_ref,
        state: er.state,
      }));
    }

    retrievalMetadata.merged_evidence_ids = Array.from(evidenceIds);

    // Apply Top-K cap if configured
    const totalBeforeLimit = allEvidence.length;
    if (maxEvidenceLimit > 0 && allEvidence.length > maxEvidenceLimit) {
      allEvidence = allEvidence.slice(0, maxEvidenceLimit);
    }
    retrievalMetadata.total_evidence_before_limit = totalBeforeLimit;
    retrievalMetadata.max_evidence_limit = maxEvidenceLimit;
    retrievalMetadata.total_evidence_in_prompt = allEvidence.length;
  } catch (err) {
    console.warn("Parallel retrieval failed, falling back to ILIKE:", err);
  }

  // Last resort: ILIKE search
  if (allEvidence.length === 0) {
    retrievalMetadata.fallback_used = true;
    const keywords = queryText
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9]/g, ""))
      .filter((w) => w.length > 3)
      .slice(0, 5);
    let fallback = await searchEvidence(test.product_id, keywords);
    if (fallback.length === 0) {
      fallback = await searchEvidence(null, keywords);
    }
    allEvidence = fallback.map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
      summary: e.summary,
      source_ref: e.source_ref,
      state: e.state,
    }));
  }

  // ── 4. Prior tests context ──
  const allTests = await getTests({
    product_id: test.product_id ?? undefined,
  });
  const priorTests = allTests
    .filter((t) => t.id !== test!.id)
    .slice(0, 20)
    .map((t) => ({
      id: t.id,
      title: t.title,
      objective: t.objective,
      prd_body: t.prd_body,
      additional_notes: t.additional_notes,
      status: t.status,
      created_at: t.created_at,
    }));

  // ── 5. LLM call ──
  const llmResult = await callLLM(
    {
      title: test.title,
      objective: test.objective,
      prd_body: test.prd_body,
      additional_notes: test.additional_notes,
    },
    allEvidence.map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
      summary: e.summary,
      source_ref: e.source_ref,
      state: e.state,
    })),
    prompt.text,
    {
      provider: settings.provider,
      model: settings.model,
      apiKey: settings.api_key_hash,
    },
    priorTests
  );

  // ── 6. Save results ──
  const matchesForDb = llmResult.matches
    .filter((m) => allEvidence.some((e) => e.id === m.id))
    .map((m) => ({
      evidence_id: m.id,
      relationship: m.relationship,
      similarity_percentage: 0,
      explanation: m.explanation,
    }));

  const evalResult = await createEvaluation(
    {
      run_id: uuidv4(),
      test_id: test.id,
      provider: settings.provider,
      model: settings.model,
      prompt_version: prompt.version,
      verdict: llmResult.readiness_verdict ?? llmResult.classification ?? "needs_clarification",
      similarity_percentage: 0,
      reason: llmResult.rationale,
      statement: llmResult.execution_summary ?? llmResult.summary_statement ?? llmResult.rationale,
      recommended_action: llmResult.recommended_action,
      prompt_sent: llmResult.prompt_sent,
      retrieval_metadata: retrievalMetadata,
      raw_response: (llmResult.raw_response as Record<string, unknown>) ?? null,
    },
    matchesForDb
  );

  // ── 7. Update status ──
  await updateTest(test.id, { status: "evaluated" });

  // ── 8. Vectorize evaluated test as evidence (Patch 3) ──
  try {
    const evidenceRecord = await upsertTestEvidence(test);
    if (evidenceRecord) {
      await embedEvidence(evidenceRecord.id);
      // Fire claims extraction (non-blocking, Patch 6)
      if (input.source !== 'mcp' && input.source !== 'api') {
        fetch(`${process.env.NEXT_PUBLIC_BASE_URL || ''}/api/evidence/${evidenceRecord.id}/extract-claims`, {
          method: 'POST',
        }).catch((err) => console.error('Claims extraction trigger failed:', err));
      }
    }
  } catch (err) {
    console.error('Test-to-evidence failed:', err);
  }

  return {
    evaluation: evalResult,
    test,
    matchCount: matchesForDb.length,
    totalEvidenceSearched: allEvidence.length,
  };
}
