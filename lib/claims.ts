import { query } from "./db";
import { supersedeClaimsForSource } from "./ingestionPipeline";
import { embedTexts, getEmbeddingInfo } from "./embeddings";

// ─── Types ──────────────────────────────────────────────────────
export type ClaimLayer = "observation" | "interpretation" | "intention";
export type ClaimModality = "asserted" | "suspected" | "hypothesized";
export type ClaimConfidence = "high" | "medium" | "low";
export type ClaimType = "finding" | "recommendation" | "assumption" | "metric" | "constraint" | "commitment" | "deferral";
export type ClaimOrigin = "explicit" | "inferred";
export type DurabilityClass = "ephemeral" | "working" | "canonical";
export type SourceKind =
  | "experiment"
  | "analytics"
  | "interview"
  | "document"
  | "meeting_notes"
  | "slack"
  | "csv"
  | "evaluation"; // PRD 5.2 absorbed: claims derived from evaluation verdicts

export interface Claim {
  id: string;
  workspace_id: string | null;
  source_type: "proposal" | "evidence";
  source_id: string;
  claim_text: string;
  claim_type: ClaimType;
  stance: "support" | "oppose" | "neutral" | "unknown";
  source_excerpt: string | null;
  // ── PRD 6 new fields ──
  claim_layer: ClaimLayer | null;
  confidence: ClaimConfidence | null;
  modality: ClaimModality;
  durability_class: DurabilityClass;
  source_kind: SourceKind | null;
  duplicate_of_claim_id: string | null;
  // ── V3.1 fields ──
  claim_origin: ClaimOrigin | null;
  stance_signal: number | null;
  // ── existing fields ──
  product_id: string | null;
  project_id: string | null;
  embedding: number[] | null;
  embedding_model: string;
  embedded_at: string | null;
  freshness_state: "current" | "aging" | "superseded";
  freshness_updated_at: string;
  created_at: string;
}

export interface ClaimExtractionResult {
  claim_text: string;
  claim_type: ClaimType;
  stance: string;
  source_excerpt: string;
  // ── PRD 6 new extraction fields ──
  claim_layer: ClaimLayer;
  modality: ClaimModality;
  confidence: ClaimConfidence;
  // ── V3.1 fields ──
  claim_origin: ClaimOrigin;
  stance_signal: number;
}

export interface ClaimSearchResult {
  claim: Claim;
  vector_score: number;
  fts_score: number;
  rrf_score: number;
}

// Legacy alias — kept for backward compat
export type HybridSearchResult = ClaimSearchResult;

// ─── Query Mode Weights (PRD 7 prep) ────────────────────────────
// test_eval: PRD 6 default — observations weigh heaviest
// strategic: PRD 7 — interpretations/intentions weigh more
export type QueryMode = "test_eval" | "strategic";

const DEFAULT_LAYER_WEIGHTS: Record<QueryMode, Record<ClaimLayer, number>> = {
  test_eval: { observation: 1.0, interpretation: 1.0, intention: 1.0 },
  strategic: { observation: 1.0, interpretation: 1.0, intention: 1.0 },
};

// ─── Claim Extraction (via Claude) — V3.1 Prompt ────────────────
// Full V3.1 prompt lives in .claude/agents/claim-extractor-v3.md
// This is the inline version for programmatic extraction via Anthropic SDK
const EXTRACTION_PROMPT = `You are a claim extractor for Assay. Claims are POINTERS in semantic space — standalone vector embeddings whose purpose is to pull parent evidence records into retrieval via RRF. No PM ever reads a claim directly.

CORE TEST: Does this claim's embedding vector point in a meaningfully different direction than the embedding of the full source text? If yes, extract it. If no, skip it.

STANCE OVER FORM: Before skipping any candidate, ask: does this sentence carry adversarial, constraining, or dissenting intent relative to organizational consensus? If yes, extract it — even if pgvector could match the raw text.

For each claim, provide:
- claim_text: Single sentence, independently understandable. This will be embedded as a standalone vector.
- claim_type: "finding" | "recommendation" | "assumption" | "metric" | "constraint" | "commitment" | "deferral"
  Tie-break: constraint > commitment > deferral > finding/recommendation
- stance: "support" | "oppose" | "neutral" | "unknown"
- claim_layer: "observation" | "interpretation" | "intention"
- claim_origin: "explicit" (source directly states this) | "inferred" (derived from context)
- stance_signal: 0.0-1.0 float. Organizational dissent/constraint strength. Default 0.3 when uncertain. 0.7+ = clear dissent or constraint.
- extraction_confidence: "high" | "medium" | "low"
- source_excerpt: Exact phrase from source text (max 200 chars)
- modality: "asserted" | "suspected" | "hypothesized"

Observations: Extract ONLY when stance-carrying (dissent, constraint, contradiction), a decision commitment, a scope deferral, or a specific quantitative threshold. Skip generic factual restatements.
Interpretations: Primary value layer — causal reasoning that embeds differently from literal source text.
Intentions: Commitments and constraints for "should we do X" queries.

5-15 claims per section. Quality over quantity. Return [] if no extractable claims.
Preserve hedging language. No markdown, no extra text — ONLY a JSON array.`;

export async function extractClaims(
  sourceText: string,
  config: { apiKey: string; model?: string }
): Promise<ClaimExtractionResult[]> {
  // Dynamic import to avoid loading Anthropic SDK at module level
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: config.apiKey });

  const response = await client.messages.create({
    model: config.model || "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: EXTRACTION_PROMPT,
    messages: [
      {
        role: "user",
        content: `Extract claims from this text:\n\n${sourceText}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from claim extraction");
  }

  try {
    const cleaned = textBlock.text
      .replace(/^```json?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error("Expected array");
    return parsed.map((c: Record<string, unknown>) => ({
      claim_text: String(c.claim_text || ""),
      claim_type: (String(c.claim_type || "finding")) as ClaimType,
      stance: String(c.stance || "neutral"),
      source_excerpt: String(c.source_excerpt || "").slice(0, 200),
      claim_layer: (c.claim_layer || "observation") as ClaimLayer,
      modality: (c.modality || "asserted") as ClaimModality,
      confidence: (c.confidence || "medium") as ClaimConfidence,
      claim_origin: (c.claim_origin || "explicit") as ClaimOrigin,
      stance_signal: typeof c.stance_signal === "number" ? c.stance_signal : 0.3,
    }));
  } catch {
    console.error("Failed to parse claim extraction:", textBlock.text);
    return [];
  }
}

// ─── Embedding ──────────────────────────────────────────────────
// Re-exported from embeddings.ts — supports OpenAI (default) and
// local ONNX provider (bge-large-en-v1.5, optimized for Apple Silicon).
// Set EMBEDDING_PROVIDER=local in .env.local to use local embeddings.
export { embedTexts, getEmbeddingInfo } from "./embeddings";

// ─── Claim CRUD ─────────────────────────────────────────────────
export async function saveClaims(
  claims: Omit<Claim, "id" | "created_at" | "freshness_updated_at" | "fts">[]
): Promise<Claim[]> {
  if (claims.length === 0) return [];
  const results: Claim[] = [];

  for (const claim of claims) {
    const { rows } = await query(
      `INSERT INTO claims (workspace_id, source_type, source_id, claim_text, claim_type, stance, source_excerpt,
        claim_layer, confidence, modality, durability_class, source_kind, duplicate_of_claim_id,
        product_id, project_id, embedding, embedding_model, embedded_at, freshness_state,
        extracted_at, extraction_model, extraction_prompt_version, source_version,
        claim_origin, stance_signal, extraction_confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
       RETURNING *`,
      [
        claim.workspace_id, claim.source_type, claim.source_id, claim.claim_text,
        claim.claim_type, claim.stance, claim.source_excerpt,
        claim.claim_layer, claim.confidence, claim.modality, claim.durability_class,
        claim.source_kind, claim.duplicate_of_claim_id,
        claim.product_id, claim.project_id,
        claim.embedding ? (typeof claim.embedding === 'string' ? claim.embedding : `[${(claim.embedding as number[]).join(",")}]`) : null,
        claim.embedding_model, claim.embedded_at, claim.freshness_state,
        (claim as any).extracted_at ?? null, (claim as any).extraction_model ?? null,
        (claim as any).extraction_prompt_version ?? null, (claim as any).source_version ?? null,
        claim.claim_origin ?? null, claim.stance_signal ?? null, (claim as any).extraction_confidence ?? null,
      ]
    );
    results.push(rows[0]);
  }
  return results;
}

export async function getClaimsBySource(
  sourceType: string,
  sourceId: string
): Promise<Claim[]> {
  const { rows } = await query(
    "SELECT * FROM claims WHERE source_type = $1 AND source_id = $2 ORDER BY created_at ASC",
    [sourceType, sourceId]
  );
  return rows;
}

export async function getClaimById(id: string): Promise<Claim | undefined> {
  const { rows } = await query("SELECT * FROM claims WHERE id = $1", [id]);
  return rows[0] ?? undefined;
}

export async function deleteClaimsBySource(
  sourceType: string,
  sourceId: string
): Promise<void> {
  await query(
    "DELETE FROM claims WHERE source_type = $1 AND source_id = $2",
    [sourceType, sourceId]
  );
}

// ─── Dedup: check if claim is near-duplicate of existing ─────────
async function findDuplicateCanonical(
  embedding: number[],
  productId: string | null
): Promise<string | null> {
  if (!productId) return null;
  const { rows } = await query(
    "SELECT * FROM find_duplicate_claims($1, $2, $3, $4)",
    [`[${embedding.join(",")}]`, productId, 0.92, 1]
  );
  if (!rows || rows.length === 0) return null;
  return rows[0].id;
}

// ─── Chunking for long content (PRD 5.2 absorbed) ────────────────
const CHUNK_CHAR_LIMIT = 12000; // ~3000 tokens
const CHUNK_OVERLAP = 800; // ~200 tokens overlap

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_CHAR_LIMIT) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + CHUNK_CHAR_LIMIT;

    // Try to break at a heading or double newline for cleaner sections
    if (end < text.length) {
      const slice = text.slice(start, end);
      const headingBreak = slice.lastIndexOf("\n#");
      const paraBreak = slice.lastIndexOf("\n\n");
      const breakPoint = headingBreak > CHUNK_CHAR_LIMIT * 0.5
        ? headingBreak
        : paraBreak > CHUNK_CHAR_LIMIT * 0.5
          ? paraBreak
          : -1;
      if (breakPoint > 0) end = start + breakPoint;
    }

    chunks.push(text.slice(start, Math.min(end, text.length)));
    start = end - CHUNK_OVERLAP;
  }

  return chunks;
}

// ─── Full Pipeline: Extract → Embed → Dedup → Store ─────────────
export async function processSourceClaims(opts: {
  sourceType: "proposal" | "evidence";
  sourceId: string;
  sourceText: string;
  productId?: string | null;
  projectId?: string | null;
  sourceKind?: SourceKind | null;
  sourceVersion?: number;
  anthropicApiKey: string;
  anthropicModel?: string;
}): Promise<Claim[]> {
  // 1. Extract claims via Claude (PRD 6 upgraded prompt)
  const chunks = chunkText(opts.sourceText);
  const extracted: ClaimExtractionResult[] = [];
  for (const chunk of chunks) {
    const chunkClaims = await extractClaims(chunk, {
      apiKey: opts.anthropicApiKey,
      model: opts.anthropicModel,
    });
    extracted.push(...chunkClaims);
  }

  if (extracted.length === 0) return [];

  // 2. Embed all claim texts in one batch
  const embeddings = await embedTexts(extracted.map((c) => c.claim_text));

  // 2.5. Cosine distance gate (V3.1 contract: 0.10 hard drop)
  // Drop claims whose embedding is too close to the source evidence record's embedding.
  // These claims add zero retrieval value — pgvector already finds the chunk.
  const COSINE_DISTANCE_GATE = 0.10;
  let filteredExtracted = extracted;
  let filteredEmbeddings = embeddings;

  if (opts.sourceType === "evidence" && opts.sourceId) {
    const { rows: sourceRows } = await query(
      "SELECT embedding FROM evidence_records WHERE id = $1 AND embedding IS NOT NULL",
      [opts.sourceId]
    );
    if (sourceRows.length > 0 && sourceRows[0].embedding) {
      const sourceEmb = typeof sourceRows[0].embedding === "string"
        ? JSON.parse(sourceRows[0].embedding.replace(/^\[/, "[").replace(/\]$/, "]"))
        : sourceRows[0].embedding;

      const keepIndices: number[] = [];
      for (let i = 0; i < embeddings.length; i++) {
        const dotProduct = embeddings[i].reduce((sum, v, j) => sum + v * (sourceEmb[j] ?? 0), 0);
        const normA = Math.sqrt(embeddings[i].reduce((sum, v) => sum + v * v, 0));
        const normB = Math.sqrt(sourceEmb.reduce((sum: number, v: number) => sum + v * v, 0));
        const cosineSim = normA && normB ? dotProduct / (normA * normB) : 0;
        const cosineDistance = 1 - cosineSim;

        if (cosineDistance >= COSINE_DISTANCE_GATE) {
          keepIndices.push(i);
        }
      }

      if (keepIndices.length < extracted.length) {
        const dropped = extracted.length - keepIndices.length;
        console.log(`[cosine-gate] Dropped ${dropped}/${extracted.length} claims (distance < ${COSINE_DISTANCE_GATE})`);
        filteredExtracted = keepIndices.map(i => extracted[i]);
        filteredEmbeddings = keepIndices.map(i => embeddings[i]);
      }
    }
  }

  if (filteredExtracted.length === 0) return [];

  // 3. Dedup: check each claim against existing canonical claims
  const dupIds = await Promise.all(
    filteredEmbeddings.map((emb) => findDuplicateCanonical(emb, opts.productId ?? null))
  );

  // 4. Build claim records with V3.1 metadata
  const claimRecords = filteredExtracted.map((c, i) => ({
    workspace_id: null as string | null,
    source_type: opts.sourceType,
    source_id: opts.sourceId,
    claim_text: c.claim_text,
    claim_type: c.claim_type as Claim["claim_type"],
    stance: c.stance as Claim["stance"],
    source_excerpt: c.source_excerpt,
    // PRD 6 fields
    claim_layer: c.claim_layer,
    confidence: c.confidence,
    modality: c.modality,
    durability_class: "working" as DurabilityClass,
    source_kind: opts.sourceKind ?? null,
    duplicate_of_claim_id: dupIds[i] ?? null,
    // V3.1 fields
    claim_origin: c.claim_origin ?? null,
    stance_signal: c.stance_signal ?? null,
    // existing fields
    product_id: opts.productId || null,
    project_id: opts.projectId || null,
    embedding: `[${filteredEmbeddings[i].join(",")}]` as unknown as number[],
    embedding_model: "text-embedding-3-small",
    embedded_at: new Date().toISOString(),
    freshness_state: "current" as const,
    // Ingestion pipeline metadata
    extracted_at: new Date().toISOString(),
    extraction_model: opts.anthropicModel || "claude-haiku-4-5-20251001",
    extraction_prompt_version: "v3.1",
    extraction_confidence: c.confidence,
    source_version: opts.sourceVersion ?? 1,
  }));

  // 5. Supersede old claims for this source (soft-deprecate), then save new ones
  await supersedeClaimsForSource(opts.sourceType, opts.sourceId);
  return saveClaims(claimRecords);
}

// ─── Evidence Search Result ──────────────────────────────────────
export interface EvidenceSearchResult {
  id: string;
  type: string;
  product_id: string;
  project_id: string | null;
  title: string;
  summary: string;
  source_ref: string | null;
  state: string;
  recorded_at: string;
  source_date: string | null;
  is_enabled: boolean;
  vector_score: number;
  fts_score: number;
  rrf_score: number;
}

// ─── Hybrid Search: Vector + FTS → RRF (on evidence_records) ────
export async function hybridEvidenceSearch(
  queryText: string,
  opts?: {
    productId?: string | null;
    limit?: number;
    queryEmbedding?: number[];  // PRD 6.5: skip embedding if pre-computed
    excludeRecentEvaluations?: boolean; // PRD 14: anti-recursion guard
  }
): Promise<EvidenceSearchResult[]> {
  const limit = opts?.limit ?? 20;

  // PRD 14 — Anti-recursion guard: fetch IDs of evaluation records created
  // in the last 24 hours so they can be excluded from retrieval results.
  // Prevents echo chamber effects where recent brief/stress-test outputs
  // dominate the next retrieval.
  let recentEvalIds: Set<string> | null = null;
  if (opts?.excludeRecentEvaluations) {
    const { rows: recentRows } = await query(
      `SELECT id FROM evidence_records
       WHERE source_type = 'evaluation'
         AND recorded_at > NOW() - INTERVAL '24 hours'`,
    );
    if (recentRows.length > 0) {
      recentEvalIds = new Set(recentRows.map((r: { id: string }) => r.id));
    }
  }

  // 1. Embed the query (skip if pre-computed)
  const queryEmbedding = opts?.queryEmbedding ?? (await embedTexts([queryText]))[0];

  // 2. Vector search — top 30 by cosine similarity
  const vectorPromise = query(
    "SELECT * FROM match_evidence_by_embedding($1, $2, $3, $4)",
    [`[${queryEmbedding.join(",")}]`, 0.25, 30, opts?.productId ?? null]
  );

  // 3. FTS search — top 20 by text relevance
  const ftsKeywords = queryText
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 10)
    .join(" & ");

  const ftsPromise = query(
    "SELECT * FROM match_evidence_by_fts($1, $2, $3)",
    [ftsKeywords || queryText, 20, opts?.productId ?? null]
  );

  // Run both in parallel
  const [vectorRes, ftsRes] = await Promise.all([vectorPromise, ftsPromise]);

  type VectorRow = { id: string; similarity: number; type: string; product_id: string; project_id: string | null; title: string; summary: string; source_ref: string | null; state: string; recorded_at: string; source_date: string | null; is_enabled: boolean };
  type FtsRow = { id: string; rank: number; type: string; product_id: string; project_id: string | null; title: string; summary: string; source_ref: string | null; state: string; recorded_at: string; source_date: string | null; is_enabled: boolean };

  const vectorResults: VectorRow[] = vectorRes.rows ?? [];
  const ftsResults: FtsRow[] = ftsRes.rows ?? [];

  // 4. Reciprocal Rank Fusion (RRF)
  const k = 60;
  const scoreMap = new Map<string, EvidenceSearchResult>();

  vectorResults.forEach((r, idx) => {
    const rrfContrib = 1 / (k + idx + 1);
    const existing = scoreMap.get(r.id);
    if (existing) {
      existing.vector_score = r.similarity;
      existing.rrf_score += rrfContrib;
    } else {
      scoreMap.set(r.id, {
        id: r.id,
        type: r.type,
        product_id: r.product_id,
        project_id: r.project_id,
        title: r.title,
        summary: r.summary,
        source_ref: r.source_ref,
        state: r.state,
        recorded_at: r.recorded_at,
        source_date: r.source_date ?? null,
        is_enabled: r.is_enabled ?? true,
        vector_score: r.similarity,
        fts_score: 0,
        rrf_score: rrfContrib,
      });
    }
  });

  ftsResults.forEach((r, idx) => {
    const rrfContrib = 1 / (k + idx + 1);
    const existing = scoreMap.get(r.id);
    if (existing) {
      existing.fts_score = r.rank;
      existing.rrf_score += rrfContrib;
    } else {
      scoreMap.set(r.id, {
        id: r.id,
        type: r.type,
        product_id: r.product_id,
        project_id: r.project_id,
        title: r.title,
        summary: r.summary,
        source_ref: r.source_ref,
        state: r.state,
        recorded_at: r.recorded_at,
        source_date: r.source_date ?? null,
        is_enabled: r.is_enabled ?? true,
        vector_score: 0,
        fts_score: r.rank,
        rrf_score: rrfContrib,
      });
    }
  });

  // 5. Sort by RRF score, apply anti-recursion filter, return top N
  let results = Array.from(scoreMap.values()).sort(
    (a, b) => b.rrf_score - a.rrf_score
  );

  // PRD 14: filter out recent evaluation records to prevent echo chamber
  if (recentEvalIds && recentEvalIds.size > 0) {
    results = results.filter((r) => !recentEvalIds!.has(r.id));
  }

  return results.slice(0, limit);
}

// ─── PRD 6: Hybrid Claim Search — Vector + FTS → Layer-Weighted RRF ──
export async function hybridClaimSearch(
  queryText: string,
  opts?: {
    productId?: string | null;
    limit?: number;
    mode?: QueryMode;
    queryEmbedding?: number[];  // PRD 6.5: skip embedding if pre-computed
  }
): Promise<ClaimSearchResult[]> {
  const limit = opts?.limit ?? 20;
  const mode = opts?.mode ?? "test_eval";

  // Load configurable weights from provider_settings, fall back to defaults
  let weights = DEFAULT_LAYER_WEIGHTS[mode];
  try {
    const { rows: settingsRows } = await query(
      "SELECT retrieval_config FROM provider_settings LIMIT 1"
    );
    if (settingsRows[0]?.retrieval_config?.layer_weights?.[mode]) {
      weights = settingsRows[0].retrieval_config.layer_weights[mode];
    }
  } catch {
    // Fall back to defaults silently
  }

  // 1. Embed the query (skip if pre-computed)
  const queryEmbedding = opts?.queryEmbedding ?? (await embedTexts([queryText]))[0];

  // 2. Vector search on claims table — top 50
  const vectorPromise = query(
    "SELECT * FROM match_claims_by_embedding($1, $2, $3, $4)",
    [`[${queryEmbedding.join(",")}]`, 0.0, 50, opts?.productId ?? null]
  );

  // 3. FTS search on claims table — top 30
  const ftsKeywords = queryText
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 10)
    .join(" & ");

  const ftsPromise = query(
    "SELECT * FROM match_claims_by_fts($1, $2, $3)",
    [ftsKeywords || queryText, 30, opts?.productId ?? null]
  );

  // Run both in parallel
  const [vectorRes, ftsRes] = await Promise.all([vectorPromise, ftsPromise]);

  type ClaimRow = {
    id: string; workspace_id: string | null; source_type: string; source_id: string;
    claim_text: string; claim_type: string; stance: string; source_excerpt: string | null;
    claim_layer: ClaimLayer | null; confidence: ClaimConfidence | null;
    modality: ClaimModality | null; source_kind: SourceKind | null;
    duplicate_of_claim_id: string | null;
    product_id: string | null; project_id: string | null;
    embedding_model: string; freshness_state: string; created_at: string;
    similarity?: number; rank?: number;
  };

  const vectorResults: ClaimRow[] = vectorRes.rows ?? [];
  const ftsResults: ClaimRow[] = ftsRes.rows ?? [];

  // 4. Layer-Weighted Reciprocal Rank Fusion (RRF)
  const k = 60;
  const scoreMap = new Map<string, { claim: Claim; vector_score: number; fts_score: number; rrf_score: number }>();

  const buildClaim = (r: ClaimRow): Claim => ({
    id: r.id,
    workspace_id: r.workspace_id,
    source_type: r.source_type as Claim["source_type"],
    source_id: r.source_id,
    claim_text: r.claim_text,
    claim_type: r.claim_type as Claim["claim_type"],
    stance: r.stance as Claim["stance"],
    source_excerpt: r.source_excerpt,
    claim_layer: r.claim_layer,
    confidence: r.confidence,
    modality: r.modality ?? "asserted",
    durability_class: "working" as DurabilityClass,
    source_kind: r.source_kind,
    duplicate_of_claim_id: r.duplicate_of_claim_id,
    claim_origin: (r as any).claim_origin ?? null,
    stance_signal: (r as any).stance_signal ?? null,
    product_id: r.product_id,
    project_id: r.project_id,
    embedding: null,
    embedding_model: r.embedding_model,
    embedded_at: null,
    freshness_state: r.freshness_state as Claim["freshness_state"],
    freshness_updated_at: r.created_at,
    created_at: r.created_at,
  });

  // Layer weight multiplier for a claim
  const layerMultiplier = (layer: ClaimLayer | null): number =>
    weights[layer ?? "observation"];

  vectorResults.forEach((r, idx) => {
    const baseRrf = 1 / (k + idx + 1);
    const rrfContrib = baseRrf * layerMultiplier(r.claim_layer);
    const existing = scoreMap.get(r.id);
    if (existing) {
      existing.vector_score = r.similarity ?? 0;
      existing.rrf_score += rrfContrib;
    } else {
      scoreMap.set(r.id, {
        claim: buildClaim(r),
        vector_score: r.similarity ?? 0,
        fts_score: 0,
        rrf_score: rrfContrib,
      });
    }
  });

  ftsResults.forEach((r, idx) => {
    const baseRrf = 1 / (k + idx + 1);
    const rrfContrib = baseRrf * layerMultiplier(r.claim_layer);
    const existing = scoreMap.get(r.id);
    if (existing) {
      existing.fts_score = r.rank ?? 0;
      existing.rrf_score += rrfContrib;
    } else {
      scoreMap.set(r.id, {
        claim: buildClaim(r),
        vector_score: 0,
        fts_score: r.rank ?? 0,
        rrf_score: rrfContrib,
      });
    }
  });

  // 5. Sort by weighted RRF score, return top N
  return Array.from(scoreMap.values())
    .sort((a, b) => b.rrf_score - a.rrf_score)
    .slice(0, limit);
}

// ─── Legacy wrapper — backward compat for callers using hybridSearch ──
export async function hybridSearch(
  queryText: string,
  opts?: {
    productId?: string | null;
    limit?: number;
    freshnessFilter?: string[];
  }
): Promise<ClaimSearchResult[]> {
  return hybridClaimSearch(queryText, {
    productId: opts?.productId,
    limit: opts?.limit,
    mode: "test_eval",
  });
}

// ─── Spec History ───────────────────────────────────────────────
export interface SpecHistoryEntry {
  id: string;
  spec_name: string;
  version: string;
  description: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  notion_url: string | null;
  created_at: string;
}

export async function getSpecHistory(): Promise<SpecHistoryEntry[]> {
  const { rows } = await query(
    "SELECT * FROM spec_history ORDER BY created_at DESC"
  );
  return rows;
}

export async function addSpecHistoryEntry(
  entry: Omit<SpecHistoryEntry, "id" | "created_at">
): Promise<SpecHistoryEntry> {
  const { rows } = await query(
    `INSERT INTO spec_history (spec_name, version, description, status, started_at, completed_at, notion_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [entry.spec_name, entry.version, entry.description, entry.status, entry.started_at, entry.completed_at, entry.notion_url]
  );
  return rows[0];
}
