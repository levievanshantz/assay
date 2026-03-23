import { readFileSync } from "fs";
import { join } from "path";
import type {
  ClaimExtractionResult,
  ClaimType,
  ClaimLayer,
  ClaimModality,
  ClaimConfidence,
  ClaimOrigin,
} from "./claims";

// ─── Config ──────────────────────────────────────────────────────
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "phi4:14b";

// ─── Load extraction prompt from disk ────────────────────────────
let _cachedPrompt: string | null = null;

function getExtractionPrompt(): string {
  if (_cachedPrompt) return _cachedPrompt;
  const promptPath = join(process.cwd(), "prompts", "extraction-phi4.md");
  try {
    _cachedPrompt = readFileSync(promptPath, "utf-8");
  } catch (err) {
    console.warn(
      `[ollama-client] Could not read prompt at ${promptPath}, using inline fallback`
    );
    _cachedPrompt =
      "You are a claim extractor. Extract claims as a JSON array. Each claim must have: claim_text, claim_type, stance, source_excerpt, claim_layer, claim_origin, stance_signal, extraction_confidence, modality.";
  }
  return _cachedPrompt;
}

// ─── Validation helpers ──────────────────────────────────────────
const VALID_CLAIM_TYPES: ClaimType[] = [
  "finding",
  "recommendation",
  "assumption",
  "metric",
  "constraint",
  "commitment",
  "deferral",
];
const VALID_STANCES = ["support", "oppose", "neutral", "unknown"];
const VALID_LAYERS: ClaimLayer[] = ["observation", "interpretation", "intention"];
const VALID_MODALITIES: ClaimModality[] = ["asserted", "suspected", "hypothesized"];
const VALID_CONFIDENCES: ClaimConfidence[] = ["high", "medium", "low"];
const VALID_ORIGINS: ClaimOrigin[] = ["explicit", "inferred"];

function isValidClaim(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.claim_text === "string" &&
    obj.claim_text.length > 0 &&
    typeof obj.claim_type === "string" &&
    typeof obj.stance === "string" &&
    typeof obj.source_excerpt === "string" &&
    typeof obj.claim_layer === "string"
  );
}

function normalizeClaim(raw: Record<string, unknown>): ClaimExtractionResult {
  const claimType = VALID_CLAIM_TYPES.includes(raw.claim_type as ClaimType)
    ? (raw.claim_type as ClaimType)
    : "finding";

  const stance = VALID_STANCES.includes(raw.stance as string)
    ? (raw.stance as string)
    : "neutral";

  const claimLayer = VALID_LAYERS.includes(raw.claim_layer as ClaimLayer)
    ? (raw.claim_layer as ClaimLayer)
    : "observation";

  const modality = VALID_MODALITIES.includes(raw.modality as ClaimModality)
    ? (raw.modality as ClaimModality)
    : "asserted";

  // The phi4 prompt emits "extraction_confidence"; ClaimExtractionResult uses "confidence"
  const rawConfidence = (raw.extraction_confidence ?? raw.confidence) as string;
  const confidence = VALID_CONFIDENCES.includes(rawConfidence as ClaimConfidence)
    ? (rawConfidence as ClaimConfidence)
    : "medium";

  const claimOrigin = VALID_ORIGINS.includes(raw.claim_origin as ClaimOrigin)
    ? (raw.claim_origin as ClaimOrigin)
    : "explicit";

  const stanceSignal =
    typeof raw.stance_signal === "number"
      ? Math.max(0, Math.min(1, raw.stance_signal))
      : 0.3;

  return {
    claim_text: String(raw.claim_text),
    claim_type: claimType,
    stance,
    source_excerpt: String(raw.source_excerpt || "").slice(0, 200),
    claim_layer: claimLayer,
    modality,
    confidence,
    claim_origin: claimOrigin,
    stance_signal: stanceSignal,
  };
}

// ─── JSON extraction from LLM output ────────────────────────────
function extractJsonArray(text: string): unknown[] | null {
  // Strip markdown code fences if present
  let cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  // Try direct parse first
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }

  // Try to find a JSON array within the text
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
  }

  return null;
}

// ─── Main export ─────────────────────────────────────────────────
export async function extractClaimsViaOllama(
  sourceText: string,
  sourceType?: string
): Promise<ClaimExtractionResult[]> {
  const systemPrompt = getExtractionPrompt();
  const userMessage = sourceType
    ? `[Source type: ${sourceType}]\n\nExtract claims from this text:\n\n${sourceText}`
    : `Extract claims from this text:\n\n${sourceText}`;

  const fullPrompt = `${systemPrompt}\n\n${userMessage}`;

  let response: Response;
  try {
    response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: fullPrompt,
        stream: false,
      }),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      console.error(
        `[ollama-client] Ollama not running at ${OLLAMA_URL}. Install: https://ollama.ai`
      );
    } else {
      console.error(`[ollama-client] Connection error: ${msg}`);
    }
    return [];
  }

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 404 || body.includes("model") ) {
      console.error(
        `[ollama-client] Model ${OLLAMA_MODEL} not found. Run: ollama pull ${OLLAMA_MODEL}`
      );
    } else {
      console.error(
        `[ollama-client] Ollama returned ${response.status}: ${body.slice(0, 300)}`
      );
    }
    return [];
  }

  let responseJson: { response?: string };
  try {
    responseJson = await response.json();
  } catch {
    console.error("[ollama-client] Failed to parse Ollama response as JSON");
    return [];
  }

  const llmOutput = responseJson.response ?? "";
  if (!llmOutput.trim()) {
    console.warn("[ollama-client] Empty response from Ollama");
    return [];
  }

  // Parse the JSON array from LLM output
  const rawArray = extractJsonArray(llmOutput);
  if (!rawArray) {
    console.warn(
      "[ollama-client] Could not extract JSON array from response. First 500 chars:",
      llmOutput.slice(0, 500)
    );
    return [];
  }

  // Validate and normalize each claim
  const results: ClaimExtractionResult[] = [];
  for (const item of rawArray) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (!isValidClaim(obj)) {
      console.warn("[ollama-client] Skipping invalid claim:", JSON.stringify(obj).slice(0, 200));
      continue;
    }
    results.push(normalizeClaim(obj));
  }

  return results;
}
