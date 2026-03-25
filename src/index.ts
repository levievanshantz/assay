#!/usr/bin/env node

/**
 * Assay MCP Server
 *
 * Tools:
 *   retrieve_evidence    — embed + hybrid search, returns raw K results with RRF scores.
 *   brief                — briefing-first synthesis: what does the org know about this topic? (PRD 13)
 *   stress_test          — deliberate judgment mode: stress-test a proposal against evidence (PRD 13)
 *   check_proposal       — [DEPRECATED] alias for stress_test
 *   ingest_from_notion   — fetch a Notion page, chunk at headings, embed, and extract claims.
 *   ingest_from_confluence — fetch a Confluence page, chunk, embed, and extract claims.
 *   sync_notion          — sync all tracked Notion pages.
 *   drift_report         — read-only drift health report for tracked Notion pages.
 *
 * Usage:
 *   npm run dev
 *   npm run build && npm start
 *
 * Environment variables (loaded from ../.env.local then ../.env):
 *   DATABASE_URL  (PostgreSQL connection string)
 *   OPENAI_API_KEY
 *   NOTION_API_KEY  (required for ingest_from_notion)
 *   PRODUCT_ID  (optional — default product scope)
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

// Load .env.local then .env before any lib imports
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { embedTexts, hybridClaimSearch, hybridEvidenceSearch, processSourceClaims, saveClaims } from "../lib/claims.js";
import { createEvidence, embedEvidence } from "../lib/storage.js";
import { sanitizeInput } from "../lib/sanitize.js";
import { computeContentHash, checkDuplicate, emptyIngestionResult } from "../lib/ingestionPipeline.js";
import { query } from "../lib/db.js";
import type { IngestionResult } from "../lib/ingestionPipeline.js";
import { syncAllNotionPages } from "../lib/notionSync.js";
import {
  parseNotionPageId,
  fetchNotionBlocks,
  fetchNotionPageTitle,
  fetchNotionPageMeta,
  blocksToText,
  chunkAtHeadings,
} from "../lib/notionClient.js";
import { parseConfluencePageId, fetchConfluencePage } from "../lib/confluenceClient.js";
import type { ConfluenceConfig } from "../lib/confluenceClient.js";
import { runBriefing } from "../lib/briefingCore.js";
import { depositEvaluation } from "../lib/accumulationLoop.js";
import type { BriefDepth } from "../lib/briefingCore.js";
import { loadConfig } from "../lib/config.js";
import { logger, initSessionLog } from "../lib/logger.js";

const NOTION_API_KEY = process.env.NOTION_API_KEY || "";

// ─── MCP Server ──────────────────────────────────────────────────

const server = new Server(
  { name: "assay", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool definitions ─────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "retrieve_evidence",
      description:
        "Search the Assay evidence corpus. Three modes:\n" +
        "  • raw (default) — returns top-K evidence records with RRF scores. No LLM call.\n" +
        "  • guided — returns evidence + an eval_instructions field. " +
        "⚡ Smart: the calling LLM (you) processes the results itself — zero extra API cost, " +
        "no server-side LLM call. The tool hands you the data and a synthesis prompt; you do the thinking.\n" +
        "  • evaluate — server calls OpenAI to synthesize findings and returns a plain-language summary.\n" +
        "Use raw to explore, guided when you want to reason over results yourself, evaluate for a quick answer.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query_text: {
            type: "string",
            description: "The topic or question to search for.",
          },
          product_id: {
            type: "string",
            description: "Scope search to a specific product UUID (optional).",
          },
          mode: {
            type: "string",
            enum: ["raw", "guided", "evaluate"],
            description: "Retrieval mode. Default: raw.",
          },
          top_k: {
            type: "number",
            description: "Max results to return. Default: 20. Pass 0 for unlimited.",
          },
          full_content: {
            type: "boolean",
            description: "Return full section content (~3K chars each) instead of truncated excerpts (~500 chars). Default: false.",
          },
        },
        required: ["query_text"],
      },
    },
    {
      name: "brief",
      description:
        "Get a briefing on what the organization already knows about a topic. " +
        "Returns context summary, prior work, active constraints, unresolved debates, dependencies, and open questions. " +
        "Use this BEFORE evaluating any product decision — it accelerates by surfacing existing knowledge. " +
        "No judgment, no verdict — just what the org knows.",
      inputSchema: {
        type: "object" as const,
        properties: {
          topic: {
            type: "string",
            description: "The topic or question to brief on.",
          },
          product_id: {
            type: "string",
            description: "Scope to a specific product UUID (optional).",
          },
          depth: {
            type: "string",
            enum: ["quick", "standard", "deep"],
            description: "Retrieval depth. quick=5 records, standard=15, deep=30. Default: standard.",
          },
        },
        required: ["topic"],
      },
    },
    {
      name: "stress_test",
      description:
        "Stress-test a proposal against organizational evidence. Deliberate opt-in judgment mode. " +
        "Returns overlap analysis, conflict analysis, assumption weaknesses, evidence gaps, " +
        "supporting evidence, verdict (proceed/revise/pause/insufficient), and confidence level. " +
        "Use this when you want rigorous assessment of a specific proposal.",
      inputSchema: {
        type: "object" as const,
        properties: {
          proposal: {
            type: "string",
            description: "The full proposal to stress-test.",
          },
          product_id: {
            type: "string",
            description: "Scope to a specific product UUID (optional).",
          },
        },
        required: ["proposal"],
      },
    },
    {
      name: "check_proposal",
      description:
        "[DEPRECATED — use stress_test instead] " +
        "Evaluate a product proposal against the Assay evidence corpus. " +
        "Routes to stress_test handler.",
      inputSchema: {
        type: "object" as const,
        properties: {
          proposal_text: {
            type: "string",
            description: "The full proposal or question to evaluate.",
          },
          title: {
            type: "string",
            description: "Short title (optional — auto-derived if omitted).",
          },
          product_id: {
            type: "string",
            description: "Scope evaluation to a specific product UUID (optional).",
          },
        },
        required: ["proposal_text"],
      },
    },
    {
      name: "sync_notion",
      description:
        "Sync all tracked Notion pages. Checks each ingested Notion page for changes, " +
        "re-processes changed sections (re-embed + re-extract claims), tombstones deleted pages. " +
        "Uses content hash comparison + 0.95 cosine similarity threshold to skip cosmetic changes. " +
        "Includes circuit breaker: halts if >20% of pages show changes (prevents runaway cost).",
      inputSchema: {
        type: "object" as const,
        properties: {
          extract_claims: {
            type: "boolean",
            description: "Re-extract claims for changed sections. Default: true.",
          },
          max_pages: {
            type: "number",
            description: "Max pages to check. Default: all tracked pages.",
          },
          product_id: {
            type: "string",
            description: "Product UUID (optional).",
          },
        },
        required: [],
      },
    },
    {
      name: "ingest_from_notion",
      description:
        "Fetch a Notion page by URL or page ID, chunk it at heading boundaries, embed, and extract claims. " +
        "Skips sections that haven't changed (content hash dedup). Returns import summary.",
      inputSchema: {
        type: "object" as const,
        properties: {
          page_url_or_id: {
            type: "string",
            description: "Notion page URL or 32-char page ID.",
          },
          product_id: {
            type: "string",
            description: "Scope to a specific product UUID (optional — defaults to PRODUCT_ID env var).",
          },
          extract_claims: {
            type: "boolean",
            description: "Set false to vectorize only (Tier 1). Defaults to true.",
          },
        },
        required: ["page_url_or_id"],
      },
    },
    {
      name: "drift_report",
      description:
        "Generate a read-only drift health report for all tracked Notion pages. " +
        "Compares current Notion content against stored evidence records using content hash + cosine similarity. " +
        "Classifies sections as: unchanged, cosmetic (sim >= 0.95), meaningful (sim < 0.95), new, or deleted. " +
        "Does NOT modify any data — purely diagnostic.",
      inputSchema: {
        type: "object" as const,
        properties: {
          product_id: {
            type: "string",
            description: "Product UUID (optional).",
          },
          max_pages: {
            type: "number",
            description: "Max pages to check. Default: all tracked pages.",
          },
        },
        required: [],
      },
    },
    {
      name: "ingest_from_confluence",
      description:
        "Fetch a Confluence page by URL or page ID, parse ADF/HTML content, chunk at headings, embed, and extract claims. " +
        "Requires CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN in .env.local. " +
        "Supports both Cloud (v2 ADF) and Server/Data Center (v1 storage format).",
      inputSchema: {
        type: "object" as const,
        properties: {
          page_url_or_id: {
            type: "string",
            description: "Confluence page URL or numeric page ID.",
          },
          product_id: {
            type: "string",
            description: "Product UUID (optional).",
          },
          extract_claims: {
            type: "boolean",
            description: "Set false to vectorize only (Tier 1). Defaults to true.",
          },
        },
        required: ["page_url_or_id"],
      },
    },
    {
      name: "health_check",
      description:
        "Get quick system health status for monitoring and load balancing. " +
        "Checks database connectivity, pgvector extension, embedding configuration, " +
        "extraction mode, Notion integration, and synthesis availability.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: "submit_extracted_claims",
      description:
        "Submit extracted claims for an evidence record. Used in subagent extraction mode " +
        "where claims are extracted externally and submitted via this tool. " +
        "Validates claims, embeds them, and saves to the database.",
      inputSchema: {
        type: "object" as const,
        properties: {
          evidence_record_id: {
            type: "string",
            description: "The evidence record these claims belong to.",
          },
          claims: {
            type: "array",
            description: "JSON array of extracted claims. Each claim should have: claim_text, claim_type, stance, source_excerpt, claim_layer, modality, confidence, claim_origin, stance_signal.",
            items: { type: "object" },
          },
          extraction_model: {
            type: "string",
            description: "Model used for extraction. Defaults to 'subagent'.",
          },
        },
        required: ["evidence_record_id", "claims"],
      },
    },
  ],
}));

// ─── Tool handler ─────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  const startMs = Date.now();
  logger.info(name, "Tool called", { params: Object.keys(args) });

  try {
    let result: { content: { type: string; text: string }[]; isError?: boolean };

    if (name === "retrieve_evidence") {
      result = await handleRetrieve(args as Record<string, string>);
    } else if (name === "brief") {
      result = await handleBrief(args);
    } else if (name === "stress_test") {
      result = await handleStressTest(args);
    } else if (name === "check_proposal") {
      result = await handleStressTest({
        proposal: (args as Record<string, string>).proposal_text,
        product_id: (args as Record<string, string>).product_id,
      });
    } else if (name === "sync_notion") {
      result = await handleSyncNotion(args);
    } else if (name === "ingest_from_notion") {
      result = await handleIngestFromNotion(args);
    } else if (name === "drift_report") {
      result = await handleDriftReport(args);
    } else if (name === "ingest_from_confluence") {
      result = await handleIngestFromConfluence(args);
    } else if (name === "health_check") {
      result = await handleHealthCheck();
    } else if (name === "submit_extracted_claims") {
      result = await handleSubmitExtractedClaims(args);
    } else {
      result = {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const durationMs = Date.now() - startMs;
    if (result.isError) {
      logger.error(name, "Tool failed", { duration_ms: durationMs, error: result.content[0]?.text?.slice(0, 200) });
    } else {
      logger.info(name, "Tool completed", { duration_ms: durationMs, result_chars: result.content[0]?.text?.length });
    }
    return result;
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(name, "Tool threw exception", { duration_ms: durationMs, error: msg });
    return {
      content: [{ type: "text", text: `Internal error in ${name}: ${msg}` }],
      isError: true,
    };
  }
});

// ─── retrieve_evidence ────────────────────────────────────────────

async function handleRetrieve(args: Record<string, unknown>) {
  try {
    const queryText = sanitizeInput((args.query_text as string) ?? "");
    if (!queryText) {
      return { content: [{ type: "text", text: "query_text is required." }], isError: true };
    }

    const productId = (args.product_id as string | undefined) || process.env.PRODUCT_ID || undefined;
    const mode = (args.mode as string | undefined) ?? "raw";
    const topK = args.top_k !== undefined ? Number(args.top_k) : 20;
    const limit = topK === 0 ? undefined : topK;
    const fullContent = args.full_content === true;

    // Single embedding call shared across both searches
    const [embedding] = await embedTexts([queryText]);

    // Parallel hybrid search
    const [claimResults, evidenceResults] = await Promise.all([
      hybridClaimSearch(queryText, { productId, queryEmbedding: embedding, limit }),
      hybridEvidenceSearch(queryText, { productId, queryEmbedding: embedding, limit }),
    ]);

    // Build a score map keyed by evidence record ID
    const scoreMap = new Map<string, { rrf_score: number; source: "claims" | "evidence" | "both" }>();

    evidenceResults.forEach((r) => {
      scoreMap.set(r.id, { rrf_score: r.rrf_score, source: "evidence" });
    });

    claimResults.forEach((r) => {
      const evidenceId = r.claim.source_id;
      if (!evidenceId) return;
      const existing = scoreMap.get(evidenceId);
      if (existing) {
        scoreMap.set(evidenceId, {
          rrf_score: existing.rrf_score + r.rrf_score,
          source: "both",
        });
      } else {
        scoreMap.set(evidenceId, { rrf_score: r.rrf_score, source: "claims" });
      }
    });

    // Build output
    const evidenceById = new Map(evidenceResults.map((r) => [r.id, r]));
    const allIds = Array.from(scoreMap.keys());

    // If full_content requested, fetch content field from DB for all matched evidence
    let contentById = new Map<string, string>();
    if (fullContent && allIds.length > 0) {
      const { rows: contentRows } = await query(
        "SELECT id, content FROM evidence_records WHERE id = ANY($1)",
        [allIds]
      );
      if (contentRows) {
        contentById = new Map(contentRows.map((r: { id: string; content: string }) => [r.id, r.content ?? ""]));
      }
    }

    const results = Array.from(scoreMap.entries())
      .sort(([, a], [, b]) => b.rrf_score - a.rrf_score)
      .map(([id, score]) => {
        const ev = evidenceById.get(id);
        const record: Record<string, unknown> = {
          id,
          title: ev?.title ?? "",
          excerpt: fullContent ? (contentById.get(id) ?? ev?.summary ?? "") : (ev?.summary ?? ""),
          source_url: ev?.source_ref ?? "",
          rrf_score: Math.round(score.rrf_score * 10000) / 10000,
          found_via: score.source,
        };
        return record;
      });

    // Calculate total text size
    let totalChars = 0;
    results.forEach((r) => { totalChars += ((r.excerpt as string) || "").length + ((r.title as string) || "").length; });

    const payload: Record<string, unknown> = {
      query: queryText,
      mode,
      full_content: fullContent,
      total_results: results.length,
      total_text_chars: totalChars,
      total_text_tokens_approx: Math.round(totalChars / 4),
      evidence: results,
    };

    // ── guided mode ───────────────────────────────────────────────
    // ⚡ Zero extra API cost: the calling LLM processes the results itself.
    // The server hands back data + a synthesis prompt; the caller does the thinking.
    if (mode === "guided") {
      payload._eval_instructions =
        `You have retrieved ${results.length} evidence records from Assay for the query: "${queryText}".\n\n` +
        `Review the evidence array above and:\n` +
        `1. Assess whether the corpus contains a clear answer to the query.\n` +
        `2. Identify the 2–3 strongest relevant records (non-empty title + excerpt only) and explain why they're relevant.\n` +
        `3. Note significant gaps — aspects the query asks about that the corpus doesn't address.\n` +
        `4. Present findings in 3–5 plain-language sentences suitable for a PM making a decision.\n\n` +
        `Do not fabricate evidence. Only cite records with non-empty titles and excerpts.`;
    }

    // ── evaluate mode ─────────────────────────────────────────────
    // Server-side synthesis via OpenAI (gpt-4o-mini). Adds latency + cost.
    if (mode === "evaluate") {
      const topEvidence = results
        .filter((r) => r.title && r.excerpt)
        .slice(0, 8)
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.excerpt}`)
        .join("\n\n");

      const systemPrompt =
        "You are an evidence synthesis assistant for a product intelligence tool. " +
        "Given a query and retrieved evidence records, write a concise 3–5 sentence " +
        "synthesis of what the corpus says about the query. " +
        "Note any clear gaps. Do not fabricate. Be direct and factual.";

      const userPrompt =
        `Query: ${queryText}\n\nTop evidence:\n${topEvidence || "(no titled records found)"}`;

      const oaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 300,
          temperature: 0.3,
        }),
      });

      if (!oaiRes.ok) {
        throw new Error(`OpenAI synthesis failed: ${oaiRes.status}`);
      }

      const oaiJson = await oaiRes.json() as { choices: { message: { content: string } }[] };
      payload.synthesis = oaiJson.choices[0]?.message?.content ?? "";
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(payload, null, 2),
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { content: [{ type: "text", text: `Retrieval failed: ${msg}` }], isError: true };
  }
}

// ─── brief (PRD 13) ───────────────────────────────────────────────

async function handleBrief(args: Record<string, unknown>) {
  try {
    const topic = sanitizeInput((args.topic as string) ?? "");
    if (!topic) {
      return { content: [{ type: "text", text: "topic is required." }], isError: true };
    }

    const productId = (args.product_id as string | undefined) || process.env.PRODUCT_ID || undefined;
    const depth = (args.depth as BriefDepth | undefined) ?? "standard";

    const result = await runBriefing({
      text: topic,
      mode: "brief",
      product_id: productId,
      depth,
    });

    const synthesisText = JSON.stringify(result.result);

    // Fire-and-forget: deposit briefing back into corpus (PRD 14)
    const cfgBrief = loadConfig();
    if (cfgBrief.accumulation.enabled) {
      depositEvaluation({
        mode: "brief",
        queryText: topic,
        synthesisText,
        evidenceIds: [],
        claimIds: [],
        signalFlags: ((result.result as Record<string, unknown>).signal_flags as string[]) ?? [],
        productId: productId ?? process.env.PRODUCT_ID ?? "",
      }).catch((err) => console.error("[accumulation] brief deposit failed:", err));
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          mode: "brief",
          depth,
          evidence_count: result.evidence_count,
          ...result.result,
        }, null, 2),
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { content: [{ type: "text", text: `Briefing failed: ${msg}` }], isError: true };
  }
}

// ─── stress_test (PRD 13) ────────────────────────────────────────

async function handleStressTest(args: Record<string, unknown>) {
  try {
    const proposal = sanitizeInput((args.proposal as string) ?? "");
    if (!proposal) {
      return { content: [{ type: "text", text: "proposal is required." }], isError: true };
    }

    const productId = (args.product_id as string | undefined) || process.env.PRODUCT_ID || undefined;

    const result = await runBriefing({
      text: proposal,
      mode: "stress_test",
      product_id: productId,
    });

    // PRD 14: deposit stress-test synthesis back into corpus (fire-and-forget)
    const synthesisText = JSON.stringify(result.result);
    const cfgStress = loadConfig();
    if (cfgStress.accumulation.enabled) {
      depositEvaluation({
        mode: "stress_test",
        queryText: proposal,
        synthesisText,
        evidenceIds: [],
        claimIds: [],
        signalFlags: ((result.result as Record<string, unknown>).signal_flags as string[]) ?? [],
        productId: productId ?? process.env.PRODUCT_ID ?? "",
      }).catch((err) => console.error("[accumulation] stress_test deposit failed:", err));
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          mode: "stress_test",
          evidence_count: result.evidence_count,
          ...result.result,
        }, null, 2),
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { content: [{ type: "text", text: `Stress test failed: ${msg}` }], isError: true };
  }
}

// ─── ingest_from_notion ───────────────────────────────────────────

async function handleSyncNotion(args: Record<string, unknown>) {
  try {
    const cfg = loadConfig();
    if (!cfg.sync.enabled) {
      return {
        content: [{ type: "text", text: "Sync is disabled. Enable with: node scripts/assay-config.mjs sync.enabled true" }],
      };
    }

    if (!NOTION_API_KEY) {
      return {
        content: [{ type: "text", text: "NOTION_API_KEY not configured in .env.local" }],
        isError: true,
      };
    }

    const productId = (args.product_id as string) || process.env.PRODUCT_ID || "";
    const extractClaims = args.extract_claims !== false;
    const maxPages = args.max_pages !== undefined ? Number(args.max_pages) : undefined;

    const result = await syncAllNotionPages({
      notionApiKey: NOTION_API_KEY,
      productId,
      extractClaims,
      maxPages,
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "complete",
          ...result,
        }, null, 2),
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { content: [{ type: "text", text: `Notion sync failed: ${msg}` }], isError: true };
  }
}

// ─── drift_report ──────────────────────────────────────────────────

const DRIFT_SIMILARITY_THRESHOLD = 0.95;
const DRIFT_RATE_LIMIT_MS = 500;

function driftCosineSimilarity(a: number[], b: number[]): number {
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

async function handleDriftReport(args: Record<string, unknown>) {
  try {
    if (!NOTION_API_KEY) {
      return {
        content: [{ type: "text", text: "NOTION_API_KEY not configured in .env.local" }],
        isError: true,
      };
    }

    const maxPages = args.max_pages !== undefined ? Number(args.max_pages) : undefined;

    // Get all tracked Notion pages
    let rows: any[];
    try {
      const result = await query(
        `SELECT id, source_external_id, title, content_hash, embedding
         FROM evidence_records
         WHERE source_type = 'notion' AND is_tombstoned = false AND source_external_id IS NOT NULL`
      );
      rows = result.rows;
    } catch (fetchError: any) {
      return {
        content: [{ type: "text", text: `DB fetch failed: ${fetchError.message}` }],
        isError: true,
      };
    }

    if (!rows || rows.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            generated_at: new Date().toISOString(),
            pages_checked: 0,
            pages_with_changes: 0,
            sections: { unchanged: 0, cosmetic: 0, meaningful: 0, new: 0, deleted: 0 },
            details: [],
          }, null, 2),
        }],
      };
    }

    // Group records by page ID
    const pageMap = new Map<
      string,
      { id: string; title: string; content_hash: string; embedding: number[] | null }[]
    >();
    for (const row of rows) {
      const pageId = row.source_external_id;
      if (!pageMap.has(pageId)) pageMap.set(pageId, []);
      pageMap.get(pageId)!.push({
        id: row.id,
        title: row.title,
        content_hash: row.content_hash,
        embedding: row.embedding,
      });
    }

    let pageIds = Array.from(pageMap.keys());
    if (maxPages && maxPages > 0) {
      pageIds = pageIds.slice(0, maxPages);
    }

    const totals = { unchanged: 0, cosmetic: 0, meaningful: 0, new: 0, deleted: 0 };
    const details: any[] = [];
    let pagesWithChanges = 0;

    for (let i = 0; i < pageIds.length; i++) {
      const pageId = pageIds[i];
      const storedRecords = pageMap.get(pageId)!;

      // Rate limiting
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, DRIFT_RATE_LIMIT_MS));
      }

      let pageMeta: { title: string; lastEditedTime: string; inTrash: boolean };
      try {
        pageMeta = await fetchNotionPageMeta(pageId, NOTION_API_KEY);
      } catch (err: any) {
        details.push({
          page_title: storedRecords[0]?.title ?? pageId,
          page_id: pageId,
          status: "error",
          error: err.message,
          sections: [],
        });
        continue;
      }

      if (pageMeta.inTrash) {
        const sectionDetails = storedRecords.map((r) => ({
          title: r.title,
          status: "deleted",
        }));
        totals.deleted += sectionDetails.length;
        pagesWithChanges++;
        details.push({
          page_title: pageMeta.title,
          page_id: pageId,
          status: "changed",
          sections: sectionDetails,
        });
        continue;
      }

      // Fetch current page content
      let blocks: any[];
      try {
        await new Promise((resolve) => setTimeout(resolve, DRIFT_RATE_LIMIT_MS));
        blocks = await fetchNotionBlocks(pageId, NOTION_API_KEY);
      } catch (err: any) {
        details.push({
          page_title: pageMeta.title,
          page_id: pageId,
          status: "error",
          error: err.message,
          sections: [],
        });
        continue;
      }

      const textLines = blocksToText(blocks);
      const fullText = textLines.join("\n");
      const chunks = chunkAtHeadings(fullText, pageMeta.title);

      // Build lookup maps
      const storedByHash = new Map<string, (typeof storedRecords)[0]>();
      const storedByTitle = new Map<string, (typeof storedRecords)[0]>();
      for (const record of storedRecords) {
        if (record.content_hash) storedByHash.set(record.content_hash, record);
        if (record.title) storedByTitle.set(record.title, record);
      }

      const matchedStoredIds = new Set<string>();
      const sectionDetails: any[] = [];

      for (const chunk of chunks) {
        const contentHash = computeContentHash(chunk.text);

        const hashMatch = storedByHash.get(contentHash);
        if (hashMatch) {
          matchedStoredIds.add(hashMatch.id);
          sectionDetails.push({ title: chunk.title, status: "unchanged" });
          totals.unchanged++;
          continue;
        }

        const titleMatch = storedByTitle.get(chunk.title);
        if (titleMatch && titleMatch.embedding) {
          matchedStoredIds.add(titleMatch.id);

          const [newEmbedding] = await embedTexts([chunk.text]);
          const similarity = driftCosineSimilarity(titleMatch.embedding, newEmbedding);

          if (similarity >= DRIFT_SIMILARITY_THRESHOLD) {
            sectionDetails.push({
              title: chunk.title,
              status: "cosmetic",
              similarity: Math.round(similarity * 10000) / 10000,
            });
            totals.cosmetic++;
          } else {
            sectionDetails.push({
              title: chunk.title,
              status: "meaningful",
              similarity: Math.round(similarity * 10000) / 10000,
            });
            totals.meaningful++;
          }
        } else {
          sectionDetails.push({ title: chunk.title, status: "new" });
          totals.new++;
        }
      }

      // Deleted sections
      for (const record of storedRecords) {
        if (!matchedStoredIds.has(record.id)) {
          sectionDetails.push({ title: record.title, status: "deleted" });
          totals.deleted++;
        }
      }

      const hasChanges = sectionDetails.some((s: any) => s.status !== "unchanged");
      if (hasChanges) pagesWithChanges++;

      details.push({
        page_title: pageMeta.title,
        page_id: pageId,
        status: hasChanges ? "changed" : "unchanged",
        sections: sectionDetails,
      });
    }

    const report = {
      generated_at: new Date().toISOString(),
      pages_checked: pageIds.length,
      pages_with_changes: pagesWithChanges,
      sections: totals,
      details,
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify(report, null, 2),
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { content: [{ type: "text", text: `Drift report failed: ${msg}` }], isError: true };
  }
}

async function handleIngestFromConfluence(args: Record<string, unknown>) {
  try {
    const baseUrl = process.env.CONFLUENCE_BASE_URL;
    const email = process.env.CONFLUENCE_EMAIL;
    const apiToken = process.env.CONFLUENCE_API_TOKEN;

    if (!baseUrl || !email || !apiToken) {
      return {
        content: [{
          type: "text",
          text: "Confluence not configured. Add CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN to .env.local",
        }],
        isError: true,
      };
    }

    const rawInput = (args.page_url_or_id as string) ?? "";
    if (!rawInput) {
      return { content: [{ type: "text", text: "page_url_or_id is required." }], isError: true };
    }

    const pageId = parseConfluencePageId(rawInput);
    const productId = (args.product_id as string) || process.env.PRODUCT_ID || "";
    const extractClaimsFlag = args.extract_claims !== false;

    const confluenceConfig: ConfluenceConfig = { baseUrl, email, apiToken };
    const page = await fetchConfluencePage(pageId, confluenceConfig);

    // Chunk at headings (same logic as Notion)
    const chunks = chunkAtHeadings(page.body, page.title);
    const result = emptyIngestionResult();
    result.total = chunks.length;

    const now = new Date().toISOString();

    for (const chunk of chunks) {
      const contentHash = computeContentHash(chunk.text);
      const existing = await checkDuplicate(productId, contentHash);

      if (existing) {
        result.skipped++;
        result.details.skippedHashes.push(contentHash);
        continue;
      }

      // Insert evidence record
      let newRecord: { id: string } | null = null;
      try {
        const { rows: insertRows } = await query(
          `INSERT INTO evidence_records (type, product_id, title, summary, content, source_ref, source_type, source_external_id, content_hash, source_version, state, is_enabled, is_tombstoned)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
          ["strategy", productId, chunk.title, chunk.text.slice(0, 500), chunk.text, page.url, "confluence", pageId, contentHash, 1, "current", true, false]
        );
        newRecord = insertRows[0] ?? null;
      } catch {
        continue;
      }

      if (!newRecord) {
        continue;
      }

      // Embed
      const [embedding] = await embedTexts([chunk.text]);
      await query(
        `UPDATE evidence_records SET embedding = $1, embedding_model = $2, embedded_at = $3, last_synced_at = $4
         WHERE id = $5`,
        [`[${embedding.join(",")}]`, "text-embedding-3-small", now, now, newRecord.id]
      );

      // Extract claims if enabled
      if (extractClaimsFlag) {
        const anthropicKey = process.env.ANTHROPIC_API_KEY;
        if (anthropicKey) {
          await processSourceClaims({
            sourceType: "evidence",
            sourceId: newRecord.id,
            sourceText: chunk.text,
            productId,
            sourceKind: "document",
            sourceVersion: 1,
            anthropicApiKey: anthropicKey,
          });
        }
      }

      result.imported++;
      result.details.importedIds.push(newRecord.id);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "complete",
          page_title: page.title,
          page_id: pageId,
          confluence_url: page.url,
          extract_claims: extractClaimsFlag,
          result,
        }, null, 2),
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { content: [{ type: "text", text: `Confluence ingestion failed: ${msg}` }], isError: true };
  }
}

async function handleIngestFromNotion(args: Record<string, unknown>) {
  try {
    if (!NOTION_API_KEY) {
      return {
        content: [{ type: "text", text: "NOTION_API_KEY not configured in .env.local" }],
        isError: true,
      };
    }

    const rawInput = (args.page_url_or_id as string) ?? "";
    if (!rawInput) {
      return {
        content: [{ type: "text", text: "page_url_or_id is required." }],
        isError: true,
      };
    }

    const pageId = parseNotionPageId(rawInput);
    const productId =
      (args.product_id as string | undefined) ||
      process.env.PRODUCT_ID ||
      "";
    const cfgIngest = loadConfig();
    const extractClaims = args.extract_claims !== false && cfgIngest.extraction.enabled;
    const notionUrl = `https://www.notion.so/${pageId}`;

    // 1. Fetch page title and blocks in parallel
    const [pageTitle, blocks] = await Promise.all([
      fetchNotionPageTitle(pageId, NOTION_API_KEY),
      fetchNotionBlocks(pageId, NOTION_API_KEY),
    ]);

    // 2. Convert blocks to text
    const textLines = blocksToText(blocks);
    const fullText = textLines.join("\n");

    if (!fullText.trim()) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "empty",
            page_title: pageTitle,
            message: "Page has no extractable text content.",
          }, null, 2),
        }],
      };
    }

    // 3. Chunk at H1/H2 boundaries
    const chunks = chunkAtHeadings(fullText, pageTitle);

    // 4. Process each chunk: hash → dedup → insert → embed → claims
    const result = emptyIngestionResult();
    result.total = chunks.length;

    for (const chunk of chunks) {
      const contentHash = computeContentHash(chunk.text);

      // Dedup check
      const existing = await checkDuplicate(productId, contentHash);
      if (existing) {
        result.skipped++;
        result.details.skippedHashes.push(contentHash);
        continue;
      }

      // Insert evidence record
      const evidence = await createEvidence({
        type: "strategy",
        product_id: productId,
        project_id: null,
        title: chunk.title,
        summary: chunk.text.slice(0, 500),
        content: chunk.text,
        source_ref: notionUrl,
        state: "current",
        is_enabled: true,
        content_hash: contentHash,
        source_type: "notion",
        source_external_id: pageId,
        source_version: 1,
        is_tombstoned: false,
        tombstone_reason: null,
      } as any);

      // Embed the evidence record
      await embedEvidence(evidence.id);

      // Extract claims if requested
      if (extractClaims) {
        const anthropicKey = process.env.ANTHROPIC_API_KEY;
        if (anthropicKey) {
          try {
            await processSourceClaims({
              sourceType: "evidence",
              sourceId: evidence.id,
              sourceText: chunk.text,
              productId,
              projectId: null,
              sourceKind: "document",
              sourceVersion: 1,
              anthropicApiKey: anthropicKey,
            });
          } catch (claimErr) {
            console.error(`Claim extraction failed for chunk "${chunk.title}":`, claimErr);
            // Continue — evidence is still imported even if claims fail
          }
        }
      }

      result.imported++;
      result.details.importedIds.push(evidence.id);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "complete",
          page_title: pageTitle,
          page_id: pageId,
          notion_url: notionUrl,
          extract_claims: extractClaims,
          result,
        }, null, 2),
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return {
      content: [{ type: "text", text: `Notion ingestion failed: ${msg}` }],
      isError: true,
    };
  }
}

// ─── health_check ─────────────────────────────────────────────────

async function handleHealthCheck() {
  const result: Record<string, unknown> = {};

  // Database
  try {
    const { rows: evRows } = await query("SELECT count(*)::int AS c FROM evidence_records");
    const { rows: clRows } = await query("SELECT count(*)::int AS c FROM claims");
    result.database = {
      status: "connected",
      evidence_count: evRows[0]?.c ?? 0,
      claims_count: clRows[0]?.c ?? 0,
    };
  } catch (err) {
    result.database = {
      status: "error",
      evidence_count: 0,
      claims_count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // pgvector
  try {
    const { rows } = await query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    if (rows.length > 0) {
      result.pgvector = { status: "installed", version: rows[0].extversion };
    } else {
      result.pgvector = { status: "missing" };
    }
  } catch {
    result.pgvector = { status: "missing" };
  }

  // Embeddings
  result.embeddings = {
    status: process.env.OPENAI_API_KEY ? "configured" : "missing",
    model: "text-embedding-3-small",
  };

  // Extraction
  const extractionMode = process.env.EXTRACTION_MODE || "anthropic";
  const extractionResult: Record<string, unknown> = { mode: extractionMode };
  if (extractionMode === "ollama") {
    const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
    try {
      const resp = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      extractionResult.model_available = resp.ok;
    } catch {
      extractionResult.model_available = false;
      extractionResult.error = "Cannot reach Ollama";
    }
  } else if (extractionMode === "anthropic") {
    extractionResult.model_available = !!process.env.ANTHROPIC_API_KEY;
    if (!process.env.ANTHROPIC_API_KEY) extractionResult.error = "ANTHROPIC_API_KEY not set";
  } else if (extractionMode === "subagent") {
    extractionResult.model_available = true; // external, always "available"
  } else {
    extractionResult.model_available = false;
    extractionResult.error = `Unknown mode: ${extractionMode}`;
  }
  result.extraction = extractionResult;

  // Notion
  if (process.env.NOTION_API_KEY) {
    try {
      const { rows } = await query(
        "SELECT count(*)::int AS c FROM evidence_records WHERE source_type = 'notion'"
      );
      const { rows: syncRows } = await query(
        "SELECT max(updated_at) AS last_sync FROM evidence_records WHERE source_type = 'notion'"
      );
      result.notion = {
        status: "configured",
        tracked_pages: rows[0]?.c ?? 0,
        last_sync: syncRows[0]?.last_sync ?? null,
      };
    } catch {
      result.notion = { status: "configured", tracked_pages: 0 };
    }
  } else {
    result.notion = { status: "not_configured" };
  }

  // Synthesis
  result.synthesis = {
    status: process.env.ANTHROPIC_API_KEY ? "configured" : "not_configured",
  };

  // Overall
  const dbOk = (result.database as Record<string, unknown>).status === "connected";
  const embOk = (result.embeddings as Record<string, unknown>).status === "configured";
  const pgOk = (result.pgvector as Record<string, unknown>).status === "installed";

  if (dbOk && embOk && pgOk) {
    result.overall = "healthy";
  } else if (dbOk) {
    result.overall = "degraded";
  } else {
    result.overall = "broken";
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

// ─── submit_extracted_claims ──────────────────────────────────────

async function handleSubmitExtractedClaims(args: Record<string, unknown>) {
  const evidenceRecordId = args.evidence_record_id as string;
  const claimsInput = args.claims as unknown[];
  const extractionModel = (args.extraction_model as string) || "subagent";

  if (!evidenceRecordId) {
    return { content: [{ type: "text", text: "evidence_record_id is required." }], isError: true };
  }
  if (!Array.isArray(claimsInput) || claimsInput.length === 0) {
    return { content: [{ type: "text", text: "claims must be a non-empty array." }], isError: true };
  }

  // Verify evidence record exists
  const { rows: evRows } = await query("SELECT id, product_id FROM evidence_records WHERE id = $1", [evidenceRecordId]);
  if (evRows.length === 0) {
    return { content: [{ type: "text", text: `Evidence record not found: ${evidenceRecordId}` }], isError: true };
  }
  const productId = evRows[0].product_id;

  // Validate and normalize claims
  const validated = [];
  for (let i = 0; i < claimsInput.length; i++) {
    const c = claimsInput[i] as Record<string, unknown>;
    if (!c.claim_text || typeof c.claim_text !== "string") {
      return { content: [{ type: "text", text: `Claim at index ${i} missing claim_text.` }], isError: true };
    }
    validated.push({
      claim_text: String(c.claim_text),
      claim_type: String(c.claim_type || "finding"),
      stance: String(c.stance || "neutral"),
      source_excerpt: String(c.source_excerpt || "").slice(0, 200),
      claim_layer: String(c.claim_layer || "observation"),
      modality: String(c.modality || "asserted"),
      confidence: String(c.confidence || "medium"),
      claim_origin: String(c.claim_origin || "explicit"),
      stance_signal: typeof c.stance_signal === "number" ? c.stance_signal : 0.3,
    });
  }

  // Embed all claim texts
  let embeddings: number[][];
  try {
    embeddings = await embedTexts(validated.map((c) => c.claim_text));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Embedding failed: ${msg}` }], isError: true };
  }

  // Build claim objects for saveClaims
  const now = new Date().toISOString();
  const claimRecords = validated.map((c, i) => ({
    workspace_id: null,
    source_type: "evidence" as const,
    source_id: evidenceRecordId,
    claim_text: c.claim_text,
    claim_type: c.claim_type as any,
    stance: c.stance,
    source_excerpt: c.source_excerpt,
    claim_layer: c.claim_layer as any,
    confidence: c.confidence as any,
    modality: c.modality as any,
    durability_class: "working" as const,
    source_kind: null,
    duplicate_of_claim_id: null,
    product_id: productId,
    project_id: null,
    embedding: embeddings[i],
    embedding_model: "text-embedding-3-small",
    embedded_at: now,
    freshness_state: "current" as const,
    claim_origin: c.claim_origin as any,
    stance_signal: c.stance_signal,
    extracted_at: now,
    extraction_model: extractionModel,
    extraction_prompt_version: null,
    source_version: null,
    extraction_confidence: c.confidence,
  }));

  const saved = await saveClaims(claimRecords as any);

  logger.info("claims", "Claims submitted via subagent", {
    evidence_record_id: evidenceRecordId,
    submitted: validated.length,
    saved: saved.length,
    extraction_model: extractionModel,
  });

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "saved",
        evidence_record_id: evidenceRecordId,
        claims_submitted: validated.length,
        claims_saved: saved.length,
        extraction_model: extractionModel,
      }, null, 2),
    }],
  };
}

// ─── Start ────────────────────────────────────────────────────────

async function main() {
  initSessionLog();
  const extractionMode = process.env.EXTRACTION_MODE || "anthropic";
  logger.info("mcp", "Assay MCP server started", {
    version: "0.1.0",
    extraction_mode: extractionMode,
    product_id: process.env.PRODUCT_ID || "not set",
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Assay MCP server running on stdio");
}

main().catch((err) => {
  logger.error("mcp", "Fatal server error", { error: err instanceof Error ? err.message : String(err) });
  console.error("Fatal:", err);
  process.exit(1);
});
