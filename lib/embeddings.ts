import { logger } from "./logger";

/**
 * Embedding provider abstraction — Assay
 *
 * Active provider is selected by EMBEDDING_PROVIDER env var:
 *   - "openai" (default) — uses OpenAI text-embedding-3-small (1536 dims)
 *   - "local"            — uses @xenova/transformers with bge-large-en-v1.5 (1024 dims)
 *                           Optimized for Apple Silicon (M1/M2/M3/M4) via ONNX quantized inference
 *
 * ⚠️  Local provider is NOT activated by default. To use it:
 *   1. npm install @xenova/transformers
 *   2. Set EMBEDDING_PROVIDER=local in .env.local
 *   3. Re-embed all records (dimensions change from 1536 → 1024)
 *   4. Run migration to add vector(1024) columns + indexes
 *
 * The local provider exists so the system can run without any external
 * API keys for embeddings. It uses ONNX quantized models which run
 * efficiently on Apple Silicon (M1 Pro 16GB+ recommended).
 *
 * Performance notes (Apple Silicon):
 *   - First call: ~30s (model download ~1.3GB, cached after)
 *   - Subsequent calls: ~50-100ms per text on M1 Pro
 *   - Batch of 100 texts: ~5-8 seconds on M1 Pro
 *   - 8GB machines will work but slower (swap pressure)
 */

// ─── Provider Interface ────────────────────────────────────────

export interface EmbeddingProvider {
  name: string;
  model: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

// ─── OpenAI Provider ───────────────────────────────────────────

const openaiProvider: EmbeddingProvider = {
  name: "openai",
  model: "text-embedding-3-small",
  dimensions: 1536,

  async embed(texts: string[]): Promise<number[][]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

    const batchSize = 100;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: batch,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI embedding failed: ${response.status} ${err}`);
      }

      const data = await response.json();
      const embeddings = data.data
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
        .map((d: { embedding: number[] }) => d.embedding);
      allEmbeddings.push(...embeddings);
    }

    return allEmbeddings;
  },
};

// ─── Local Provider (bge-large-en-v1.5 via transformers.js) ───
//
// Uses ONNX quantized inference — runs natively on CPU with good
// performance on Apple Silicon (M1/M2/M3/M4) without needing
// Metal or GPU acceleration explicitly.

const localProvider: EmbeddingProvider = {
  name: "local",
  model: "BAAI/bge-large-en-v1.5",
  dimensions: 1024,

  async embed(texts: string[]): Promise<number[][]> {
    // Dynamic import — @xenova/transformers is only required when
    // EMBEDDING_PROVIDER=local. This avoids breaking the default
    // build if the package is not installed.
    let pipeline: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = await (Function(
        'return import("@xenova/transformers")'
      )() as Promise<any>);
      pipeline = mod.pipeline ?? mod.default?.pipeline;
    } catch {
      throw new Error(
        "Local embedding provider requires @xenova/transformers. " +
          "Install it with: npm install @xenova/transformers"
      );
    }

    // Singleton pipeline — first call downloads + caches the model (~1.3GB)
    if (!localPipelineInstance) {
      logger.info("embeddings", `Loading local model ${localProvider.model} (first call downloads ~1.3GB)...`);
      localPipelineInstance = await pipeline(
        "feature-extraction",
        localProvider.model,
        { quantized: true } // Use quantized ONNX variant for speed on Apple Silicon
      );
      logger.info("embeddings", "Local model loaded.");
    }

    const allEmbeddings: number[][] = [];
    const batchSize = 32; // Smaller batches for local inference

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const output = await localPipelineInstance(batch, {
        pooling: "mean",
        normalize: true,
      });

      // output.tolist() returns number[][]
      const embeddings: number[][] = output.tolist();
      allEmbeddings.push(...embeddings);
    }

    return allEmbeddings;
  },
};

// Cache the pipeline singleton across calls
let localPipelineInstance: any = null;

// ─── Provider Selection ────────────────────────────────────────

function getProvider(): EmbeddingProvider {
  const providerName = (
    process.env.EMBEDDING_PROVIDER || "openai"
  ).toLowerCase();

  switch (providerName) {
    case "local":
      return localProvider;
    case "openai":
    default:
      return openaiProvider;
  }
}

/**
 * Get the active embedding provider's metadata.
 * Useful for storing embedding_model alongside vectors.
 */
export function getEmbeddingInfo(): {
  name: string;
  model: string;
  dimensions: number;
} {
  const p = getProvider();
  return { name: p.name, model: p.model, dimensions: p.dimensions };
}

/**
 * Embed texts using the active provider.
 * Drop-in replacement — all consumers import this function.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  return getProvider().embed(texts);
}
