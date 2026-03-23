import type { ClaimExtractionResult } from "./claims";
import { extractClaimsViaOllama } from "./ollamaClient";

// ─── Types ───────────────────────────────────────────────────────
export type ExtractionMode = "ollama" | "anthropic" | "subagent";

// ─── Mode resolution ─────────────────────────────────────────────
export function getExtractionMode(): ExtractionMode {
  const mode = process.env.EXTRACTION_MODE || "ollama";
  if (!["ollama", "anthropic", "subagent"].includes(mode)) {
    console.warn(`Unknown EXTRACTION_MODE "${mode}", falling back to ollama`);
    return "ollama";
  }
  return mode as ExtractionMode;
}

// ─── Routed extraction ───────────────────────────────────────────
export async function extractClaimsRouted(
  sourceText: string,
  opts: {
    mode?: ExtractionMode;
    sourceType?: string;
    anthropicApiKey?: string;
    anthropicModel?: string;
  } = {}
): Promise<ClaimExtractionResult[]> {
  const mode = opts.mode || getExtractionMode();

  switch (mode) {
    case "ollama":
      return extractClaimsViaOllama(sourceText, opts.sourceType);

    case "anthropic": {
      // Delegate to existing extractClaims in claims.ts
      const { extractClaims } = await import("./claims");
      if (!opts.anthropicApiKey) {
        throw new Error(
          "[extraction-router] anthropic mode requires anthropicApiKey"
        );
      }
      return extractClaims(sourceText, {
        apiKey: opts.anthropicApiKey,
        model: opts.anthropicModel,
      });
    }

    case "subagent":
      // Subagent mode is handled by the MCP tool flow.
      // The MCP server returns instructions for the calling agent to execute
      // extraction itself — no programmatic extraction happens here.
      console.log(
        "[extraction-router] subagent mode — extraction deferred to calling agent"
      );
      return [];

    default:
      throw new Error(`Unknown extraction mode: ${mode}`);
  }
}
