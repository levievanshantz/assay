#!/usr/bin/env node

/**
 * Assay MCP Server (v2 — 4-tool surface)
 *
 * Tools:
 *   retrieve     — embed + hybrid search (raw/guided/evaluate/brief modes)
 *   scan         — fast pre-flight check: 3-5 signals + verdict in ~3-5s
 *   stress_test  — deliberate judgment: stress-test a proposal against evidence
 *   configure    — manage sync, sources, search settings, extraction settings, health
 *
 * Usage:
 *   npm run dev
 *   npm run build && npm start
 *
 * Environment variables (loaded from ../.env.local then ../.env):
 *   DATABASE_URL  (PostgreSQL connection string)
 *   OPENAI_API_KEY
 *   NOTION_API_KEY  (required for sync/drift)
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
import { embedTexts, hybridClaimSearch, hybridEvidenceSearch } from "../lib/claims.js";
import { sanitizeInput } from "../lib/sanitize.js";
import { computeContentHash } from "../lib/ingestionPipeline.js";
import { query } from "../lib/db.js";
import { syncAllNotionPages } from "../lib/notionSync.js";
import {
  fetchNotionBlocks,
  fetchNotionPageMeta,
  blocksToText,
  chunkAtHeadings,
} from "../lib/notionClient.js";
import { runBriefing } from "../lib/briefingCore.js";
import type { BriefDepth } from "../lib/briefingCore.js";
import { loadConfig } from "../lib/config.js";
import { logger, initSessionLog } from "../lib/logger.js";

const NOTION_API_KEY = process.env.NOTION_API_KEY || "";
const PRODUCT_ID = process.env.PRODUCT_ID || "";

// ─── MCP Server ──────────────────────────────────────────────────

const server = new Server(
  { name: "assay", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool definitions (4 tools) ──────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "retrieve",
      description:
        "Search the Assay evidence corpus. Four modes:\n" +
        "  - raw (default) — returns top-K evidence records with RRF scores. No LLM call.\n" +
        "  - guided — returns evidence + an eval_instructions field. " +
        "The calling LLM processes results itself — zero extra API cost.\n" +
        "  - evaluate — server calls OpenAI to synthesize findings.\n" +
        "  - brief — synthesizes what the org already knows about a topic. " +
        "Returns context summary, prior work, constraints, debates, dependencies, open questions. " +
        "Use brief BEFORE evaluating any product decision.\n\n" +
        "Use raw to explore, guided when you want to reason over results, evaluate for a quick answer, " +
        "brief for organizational knowledge synthesis.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query_text: {
            type: "string",
            description: "The topic or question to search for. For brief mode, this is the topic to brief on.",
          },
          product_id: {
            type: "string",
            description: "Scope search to a specific product UUID (optional).",
          },
          mode: {
            type: "string",
            enum: ["raw", "guided", "evaluate", "brief"],
            description: "Retrieval mode. Default: raw.",
          },
          top_k: {
            type: "number",
            description: "Max results to return. Default: 20. Pass 0 for unlimited. In brief mode, maps to depth.",
          },
          full_content: {
            type: "boolean",
            description: "Return full section content (~3K chars each) instead of truncated excerpts (~500 chars). Default: false. Not used in brief mode.",
          },
          depth: {
            type: "string",
            enum: ["quick", "standard", "deep"],
            description: "Brief mode only. Retrieval depth: quick=5, standard=15, deep=30. Default: standard.",
          },
        },
        required: ["query_text"],
      },
    },
    {
      name: "stress_test",
      description:
        "Stress-test a proposal against organizational evidence. Deliberate opt-in judgment mode. " +
        "Returns overlap analysis, conflict analysis, assumption weaknesses, evidence gaps, " +
        "supporting evidence, verdict (proceed/proceed_with_conditions/revise/redirect/pause/insufficient_evidence), and confidence level. " +
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
      name: "scan",
      description:
        "Quick pre-flight check against organizational evidence. " +
        "Designed for one-sentence intents — sparse input, fast signal. " +
        "Returns 3-5 top signals (blockers, cautions, support) with a clear/caution/blocker verdict. " +
        "Use before starting work to catch obvious conflicts or gaps. ~3-5 second response.",
      inputSchema: {
        type: "object" as const,
        properties: {
          intent: {
            type: "string",
            description: "What you're about to do — a one-sentence intent or question.",
          },
          product_id: {
            type: "string",
            description: "Scope to a specific product UUID (optional).",
          },
        },
        required: ["intent"],
      },
    },
    {
      name: "configure",
      description:
        "Manage Assay configuration and data sources.\n\n" +
        "Subcommands:\n" +
        "  - status — sync health, last sync time, staleness, failed pages. Set include_drift=true for drift analysis.\n" +
        "  - sync — run a full Notion workspace sync.\n" +
        "  - sources — list connected data sources and their status.\n" +
        "  - search — show/update search settings (top_k, layer weights, embedding dims).\n" +
        "  - extraction — show/update model settings (claims extraction model, briefing synthesis model, env status).\n" +
        "  - health — system health: DB connectivity, pgvector, embedding config, extraction mode, Notion integration.",
      inputSchema: {
        type: "object" as const,
        properties: {
          subcommand: {
            type: "string",
            enum: ["status", "sync", "sources", "search", "extraction", "health"],
            description: "Which configuration action to perform.",
          },
          // status subcommand
          include_drift: {
            type: "boolean",
            description: "status subcommand: include full drift analysis (compares Notion content vs stored). Default: false.",
          },
          max_pages: {
            type: "number",
            description: "status/sync subcommand: max pages to check/sync.",
          },
          // sync subcommand
          extract_claims: {
            type: "boolean",
            description: "sync subcommand: re-extract claims for changed sections. Default: true.",
          },
          product_id: {
            type: "string",
            description: "sync subcommand: product UUID.",
          },
          // search subcommand
          top_k: {
            type: "number",
            description: "search subcommand: if provided, updates default top_k setting.",
          },
          layer_weights: {
            type: "object",
            description: "search subcommand: if provided, updates layer weights. Object with keys test_eval and/or strategic_query, each having {evidence: number, claims: number} (must sum to 1.0).",
          },
          embedding_dims: {
            type: "string",
            enum: ["both", "small", "large"],
            description: "search subcommand: which embedding dimensions to use. both=1536+3072, small=1536 only, large=3072 only.",
          },
          // extraction subcommand
          model: {
            type: "string",
            description: "extraction subcommand: if provided, updates claims extraction model.",
          },
          briefing_model: {
            type: "string",
            description: "extraction subcommand: if provided, updates briefing synthesis model.",
          },
          embedding_model_small: {
            type: "string",
            description: "extraction subcommand: 1536-dim embedding model. WARNING: changing requires re-embedding all records.",
          },
          embedding_model_large: {
            type: "string",
            description: "extraction subcommand: 3072-dim embedding model. WARNING: changing requires re-embedding all records.",
          },
        },
        required: ["subcommand"],
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

    if (name === "retrieve") {
      const mode = (args.mode as string | undefined) ?? "raw";
      if (mode === "brief") {
        result = await handleBrief(args);
      } else {
        result = await handleRetrieve(args);
      }
    } else if (name === "stress_test") {
      result = await handleStressTest(args);
    } else if (name === "scan") {
      result = await handleScan(args);
    } else if (name === "configure") {
      result = await handleConfigure(args);
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

// ─── retrieve (raw/guided/evaluate) ──────────────────────────────

async function handleRetrieve(args: Record<string, unknown>) {
  try {
    const queryText = sanitizeInput((args.query_text as string) ?? "");
    if (!queryText) {
      return { content: [{ type: "text", text: "query_text is required." }], isError: true };
    }

    const productId = (args.product_id as string | undefined) || process.env.PRODUCT_ID || undefined;
    const mode = (args.mode as string | undefined) ?? "raw";

    // Read configured default top_k from DB, fall back to 20
    let defaultTopK = 20;
    try {
      const { rows } = await query("SELECT retrieval_config FROM provider_settings LIMIT 1");
      defaultTopK = rows?.[0]?.retrieval_config?.top_k ?? 20;
    } catch { /* use hardcoded default */ }

    const topK = args.top_k !== undefined ? Number(args.top_k) : defaultTopK;
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
    if (mode === "guided") {
      payload._eval_instructions =
        `You have retrieved ${results.length} evidence records from Assay for the query: "${queryText}".\n\n` +
        `Review the evidence array above and:\n` +
        `1. Assess whether the corpus contains a clear answer to the query.\n` +
        `2. Identify the 2-3 strongest relevant records (non-empty title + excerpt only) and explain why they're relevant.\n` +
        `3. Note significant gaps — aspects the query asks about that the corpus doesn't address.\n` +
        `4. Present findings in 3-5 plain-language sentences suitable for a PM making a decision.\n\n` +
        `Do not fabricate evidence. Only cite records with non-empty titles and excerpts.`;
    }

    // ── evaluate mode ─────────────────────────────────────────────
    if (mode === "evaluate") {
      const topEvidence = results
        .filter((r) => r.title && r.excerpt)
        .slice(0, 8)
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.excerpt}`)
        .join("\n\n");

      const systemPrompt =
        "You are an evidence synthesis assistant for a product intelligence tool. " +
        "Given a query and retrieved evidence records, write a concise 3-5 sentence " +
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

// ─── retrieve mode=brief ─────────────────────────────────────────

async function handleBrief(args: Record<string, unknown>) {
  try {
    const topic = sanitizeInput((args.query_text as string) ?? (args.topic as string) ?? "");
    if (!topic) {
      return { content: [{ type: "text", text: "query_text is required for brief mode." }], isError: true };
    }

    const productId = (args.product_id as string | undefined) || process.env.PRODUCT_ID || undefined;
    const depth = (args.depth as BriefDepth | undefined) ?? "standard";

    const result = await runBriefing({
      text: topic,
      mode: "brief",
      product_id: productId,
      depth,
    });

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

// ─── scan (fast pre-flight check) ────────────────────────────────

async function handleScan(args: Record<string, unknown>) {
  try {
    const intent = sanitizeInput((args.intent as string) ?? "");
    if (!intent) {
      return { content: [{ type: "text", text: "intent is required." }], isError: true };
    }

    const productId = (args.product_id as string | undefined) || process.env.PRODUCT_ID || undefined;

    // Scan uses a quick brief retrieval to get fast signals
    const result = await runBriefing({
      text: intent,
      mode: "brief",
      product_id: productId,
      depth: "quick",
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          mode: "scan",
          evidence_count: result.evidence_count,
          ...result.result,
        }, null, 2),
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { content: [{ type: "text", text: `Scan failed: ${msg}` }], isError: true };
  }
}

// ─── stress_test ─────────────────────────────────────────────────

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

// ─── configure (unified admin tool) ──────────────────────────────

async function handleConfigure(args: Record<string, unknown>) {
  const subcommand = (args.subcommand as string) ?? "";

  switch (subcommand) {
    case "status":
      return handleConfigureStatus(args);
    case "sync":
      return handleConfigureSync(args);
    case "sources":
      return handleConfigureSources();
    case "search":
      return handleConfigureSearch(args);
    case "extraction":
      return handleConfigureExtraction(args);
    case "health":
      return handleHealthCheck();
    default:
      return {
        content: [{
          type: "text",
          text: `Unknown subcommand: "${subcommand}". Valid: status, sync, sources, search, extraction, health.`,
        }],
        isError: true,
      };
  }
}

// ─── configure status ────────────────────────────────────────────

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

async function handleConfigureStatus(args: Record<string, unknown>) {
  try {
    // Basic sync status from DB
    const { rows: syncRows } = await query(
      `SELECT max(last_synced_at) as last_sync, count(*)::int as total_records
       FROM evidence_records WHERE source_type = 'notion' AND is_tombstoned = false`
    );
    const lastSync = syncRows?.[0]?.last_sync ?? null;
    const totalRecords = syncRows?.[0]?.total_records ?? 0;

    const payload: Record<string, unknown> = {
      subcommand: "status",
      sync_health: {
        last_synced_at: lastSync,
        total_notion_records: totalRecords,
        notion_configured: !!NOTION_API_KEY,
      },
    };

    const includeDrift = args.include_drift === true;
    if (includeDrift) {
      const driftResult = await runDriftAnalysis(args);
      payload.drift = driftResult;
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(payload, null, 2),
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { content: [{ type: "text", text: `Status check failed: ${msg}` }], isError: true };
  }
}

async function runDriftAnalysis(args: Record<string, unknown>) {
  if (!NOTION_API_KEY) {
    return { error: "NOTION_API_KEY not configured in .env.local" };
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
    return { error: `DB fetch failed: ${fetchError.message}` };
  }

  if (!rows || rows.length === 0) {
    return {
      generated_at: new Date().toISOString(),
      pages_checked: 0,
      pages_with_changes: 0,
      sections: { unchanged: 0, cosmetic: 0, meaningful: 0, new: 0, deleted: 0 },
      details: [],
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

  return {
    generated_at: new Date().toISOString(),
    pages_checked: pageIds.length,
    pages_with_changes: pagesWithChanges,
    sections: totals,
    details,
  };
}

// ─── configure sync ──────────────────────────────────────────────

async function handleConfigureSync(args: Record<string, unknown>) {
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

    const productId = (args.product_id as string) || process.env.PRODUCT_ID || PRODUCT_ID;
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
          subcommand: "sync",
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

// ─── configure sources ───────────────────────────────────────────

async function handleConfigureSources() {
  try {
    // Count evidence records by source type
    const { rows: sourceCounts } = await query(
      `SELECT source_type, COUNT(*) as count, MAX(last_synced_at) as last_synced
       FROM evidence_records
       WHERE is_tombstoned = false AND is_enabled = true
       GROUP BY source_type`
    );

    const sources: Record<string, unknown>[] = [];

    // Notion connector
    const notionCount = sourceCounts?.find((r: any) => r.source_type === "notion");
    sources.push({
      name: "Notion",
      status: NOTION_API_KEY ? "connected" : "not_configured",
      api_key_set: !!NOTION_API_KEY,
      evidence_records: notionCount ? Number(notionCount.count) : 0,
      last_synced: notionCount?.last_synced ?? null,
    });

    // Confluence connector
    const confluenceConfigured = !!(
      process.env.CONFLUENCE_BASE_URL &&
      process.env.CONFLUENCE_EMAIL &&
      process.env.CONFLUENCE_API_TOKEN
    );
    const confluenceCount = sourceCounts?.find((r: any) => r.source_type === "confluence");
    sources.push({
      name: "Confluence",
      status: confluenceConfigured ? "connected" : "not_configured",
      api_key_set: confluenceConfigured,
      evidence_records: confluenceCount ? Number(confluenceCount.count) : 0,
      last_synced: confluenceCount?.last_synced ?? null,
    });

    // Corpus stats
    const { rows: [corpusStats] } = await query(`
      SELECT
        (SELECT COUNT(*) FROM evidence_records) as total_evidence,
        (SELECT COUNT(*) FROM evidence_records WHERE is_tombstoned = false AND is_enabled = true) as active_evidence,
        (SELECT COUNT(*) FROM evidence_records WHERE is_tombstoned = true) as tombstoned_evidence,
        (SELECT COUNT(*) FROM claims) as total_claims,
        (SELECT COUNT(*) FROM claims WHERE superseded_at IS NULL) as active_claims,
        (SELECT COUNT(*) FROM claims WHERE superseded_at IS NOT NULL) as superseded_claims,
        (SELECT COUNT(embedding) FROM evidence_records) as evidence_embedded,
        (SELECT COUNT(*) FROM evidence_records WHERE source_date IS NOT NULL) as has_source_date
    `);

    const corpus = {
      evidence: {
        total: Number(corpusStats.total_evidence),
        active: Number(corpusStats.active_evidence),
        tombstoned: Number(corpusStats.tombstoned_evidence),
        embedded: Number(corpusStats.evidence_embedded),
      },
      claims: {
        total: Number(corpusStats.total_claims),
        active: Number(corpusStats.active_claims),
        superseded: Number(corpusStats.superseded_claims),
      },
      total_retrievable: Number(corpusStats.active_evidence) + Number(corpusStats.active_claims),
      source_date_coverage: `${corpusStats.has_source_date}/${corpusStats.total_evidence}`,
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          subcommand: "sources",
          corpus,
          sources,
        }, null, 2),
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { content: [{ type: "text", text: `Sources check failed: ${msg}` }], isError: true };
  }
}

// ─── configure search ────────────────────────────────────────────

async function handleConfigureSearch(args: Record<string, unknown>) {
  try {
    // Read current settings
    const { rows: settingsRows } = await query(
      "SELECT retrieval_config FROM provider_settings LIMIT 1"
    );

    const currentConfig = settingsRows?.[0]?.retrieval_config ?? {};
    const currentTopK = currentConfig.top_k ?? 20;
    const currentLayerWeights = currentConfig.layer_weights ?? {
      test_eval: { evidence: 0.4, claims: 0.6 },
      strategic_query: { evidence: 0.5, claims: 0.5 },
    };
    const currentEmbeddingDims = currentConfig.embedding_dims ?? "both";

    // Check if any updates were requested
    const hasUpdates = args.top_k !== undefined
      || args.layer_weights !== undefined
      || args.embedding_dims !== undefined;

    if (hasUpdates) {
      const updatedConfig = { ...currentConfig };
      const changes: Record<string, { previous: unknown; new: unknown }> = {};

      if (args.top_k !== undefined) {
        const newTopK = Number(args.top_k);
        changes.top_k = { previous: currentTopK, new: newTopK };
        updatedConfig.top_k = newTopK;
      }

      if (args.layer_weights !== undefined) {
        const newWeights = args.layer_weights as Record<string, { evidence: number; claims: number }>;
        changes.layer_weights = { previous: currentLayerWeights, new: newWeights };
        updatedConfig.layer_weights = newWeights;
      }

      if (args.embedding_dims !== undefined) {
        const newDims = args.embedding_dims as string;
        changes.embedding_dims = { previous: currentEmbeddingDims, new: newDims };
        updatedConfig.embedding_dims = newDims;
      }

      await query(
        "UPDATE provider_settings SET retrieval_config = $1",
        [JSON.stringify(updatedConfig)]
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            subcommand: "search",
            action: "updated",
            changes,
            config: updatedConfig,
          }, null, 2),
        }],
      };
    }

    // Show current settings
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          subcommand: "search",
          action: "show",
          top_k: {
            value: currentTopK,
            source: currentConfig.top_k !== undefined ? "configured" : "default",
            description: "Default number of results returned by retrieve tool.",
          },
          layer_weights: {
            value: currentLayerWeights,
            source: currentConfig.layer_weights !== undefined ? "configured" : "default",
            description: "Weighting between evidence records and claims in hybrid search.",
          },
          embedding_dims: {
            value: currentEmbeddingDims,
            options: ["both", "small", "large"],
            source: currentConfig.embedding_dims !== undefined ? "configured" : "default",
          },
        }, null, 2),
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { content: [{ type: "text", text: `Search settings failed: ${msg}` }], isError: true };
  }
}

// ─── configure extraction ────────────────────────────────────────

async function handleConfigureExtraction(args: Record<string, unknown>) {
  const BRIEFING_DEFAULT_MODEL = "claude-sonnet-4-20250514";
  const EXTRACTION_DEFAULT_MODEL = "claude-haiku-4-5-20251001";

  try {
    const { rows: settingsRows } = await query(
      "SELECT model, provider, retrieval_config FROM provider_settings LIMIT 1"
    );

    const row = settingsRows?.[0];
    const currentModel = row?.model ?? null;
    const currentProvider = row?.provider ?? null;
    const retrievalConfig = row?.retrieval_config ?? {};
    const currentBriefingModel = retrievalConfig.briefing_model ?? null;

    // If extraction model provided, update it
    if (args.model !== undefined) {
      const newModel = args.model as string;
      await query("UPDATE provider_settings SET model = $1", [newModel]);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            subcommand: "extraction",
            action: "updated",
            claims_extraction_model: {
              previous: currentModel ?? EXTRACTION_DEFAULT_MODEL,
              new: newModel,
              source: "configured",
            },
            briefing_synthesis_model: {
              value: currentBriefingModel ?? BRIEFING_DEFAULT_MODEL,
              source: currentBriefingModel ? "configured" : "default",
            },
            provider: currentProvider ?? "anthropic",
          }, null, 2),
        }],
      };
    }

    // If briefing model provided, update it
    if (args.briefing_model !== undefined) {
      const newBriefingModel = args.briefing_model as string;
      const updatedConfig = { ...retrievalConfig, briefing_model: newBriefingModel };
      await query("UPDATE provider_settings SET retrieval_config = $1", [JSON.stringify(updatedConfig)]);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            subcommand: "extraction",
            action: "updated",
            briefing_synthesis_model: {
              previous: currentBriefingModel ?? BRIEFING_DEFAULT_MODEL,
              new: newBriefingModel,
              source: "configured",
            },
            provider: currentProvider ?? "anthropic",
          }, null, 2),
        }],
      };
    }

    // If embedding models provided, update them
    if (args.embedding_model_small !== undefined || args.embedding_model_large !== undefined) {
      const updatedConfig = { ...retrievalConfig };
      const changes: Record<string, { previous: string; new: string }> = {};

      if (args.embedding_model_small !== undefined) {
        const prev = retrievalConfig.embedding_model_small ?? "text-embedding-3-small";
        const next = args.embedding_model_small as string;
        changes.embedding_model_small = { previous: prev, new: next };
        updatedConfig.embedding_model_small = next;
      }
      if (args.embedding_model_large !== undefined) {
        const prev = retrievalConfig.embedding_model_large ?? "text-embedding-3-large";
        const next = args.embedding_model_large as string;
        changes.embedding_model_large = { previous: prev, new: next };
        updatedConfig.embedding_model_large = next;
      }

      await query("UPDATE provider_settings SET retrieval_config = $1", [JSON.stringify(updatedConfig)]);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            subcommand: "extraction",
            action: "updated",
            changes,
            warning: "Embedding model changed. All existing embeddings are now incompatible. Re-embed all records and claims for search to work correctly.",
          }, null, 2),
        }],
      };
    }

    // Show current settings
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          subcommand: "extraction",
          action: "show",
          claims_extraction_model: {
            value: currentModel ?? EXTRACTION_DEFAULT_MODEL,
            source: currentModel ? "configured" : "default",
            description: "Model used to extract claims from evidence sections.",
          },
          briefing_synthesis_model: {
            value: currentBriefingModel ?? BRIEFING_DEFAULT_MODEL,
            source: currentBriefingModel ? "configured" : "default",
            description: "Model used for brief/stress_test synthesis.",
          },
          embedding_model_small: {
            value: retrievalConfig.embedding_model_small ?? "text-embedding-3-small",
            source: retrievalConfig.embedding_model_small ? "configured" : "default",
            dimensions: 1536,
          },
          embedding_model_large: {
            value: retrievalConfig.embedding_model_large ?? "text-embedding-3-large",
            source: retrievalConfig.embedding_model_large ? "configured" : "default",
            dimensions: 3072,
          },
          provider: currentProvider ?? "anthropic",
          api_keys: {
            OPENAI_API_KEY: { status: process.env.OPENAI_API_KEY ? "set" : "missing", used_for: "Embedding generation" },
            NOTION_API_KEY: { status: process.env.NOTION_API_KEY ? "set" : "missing", used_for: "Notion sync pipeline" },
            DATABASE_URL: { status: process.env.DATABASE_URL ? "set" : "missing", used_for: "PostgreSQL connection" },
            PRODUCT_ID: { value: process.env.PRODUCT_ID ?? "(not set)", used_for: "Default product scope" },
          },
        }, null, 2),
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { content: [{ type: "text", text: `Extraction settings failed: ${msg}` }], isError: true };
  }
}

// ─── configure health ────────────────────────────────────────────

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
    extractionResult.model_available = true;
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

// ─── Start ───────────────────────────────────────────────────────

async function main() {
  initSessionLog();
  const extractionMode = process.env.EXTRACTION_MODE || "anthropic";
  logger.info("mcp", "Assay MCP server started", {
    version: "2.0.0",
    extraction_mode: extractionMode,
    product_id: process.env.PRODUCT_ID || "not set",
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Assay MCP server running on stdio (v2 — 4 tools)");
}

main().catch((err) => {
  logger.error("mcp", "Fatal server error", { error: err instanceof Error ? err.message : String(err) });
  console.error("Fatal:", err);
  process.exit(1);
});
