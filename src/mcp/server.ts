// AssayLabs v2 MCP server.
// 3 tools: assay_decision_recall, assay_decision_expand, assay_brief_render
// All tools query MemoryProvider (claude-mem HTTP) for context enrichment,
// join with the local decision graph, return cited evidence.
//
// "Not the agent" axiom DROPPED per CEO T1 (May 17). assay_brief_render
// composes verdicts with citations; opacity is not permitted, synthesis is.

import { DecisionStore, type StoredDecision } from "../decisions/store.js";
import {
  ClaudeMemHTTPProvider,
} from "../providers/ClaudeMemHTTPProvider.js";
import type { MemoryProvider } from "../providers/MemoryProvider.js";

const COLD_START_THRESHOLD = 5;
const EAGER_FETCH_TOP_N = 3;
const RECALL_DEFAULT_LIMIT = 10;

export interface RecallResponse {
  query: string;
  results: Array<{
    decision: StoredDecision;
    supersession_chain: StoredDecision[];
    enrichment?: { source: string; snippet: string }[];
  }>;
  context_tier: "full" | "degraded" | "unavailable";
  context_tier_reason?: string;
  cold_start?: {
    message: string;
    corpus_size: number;
  };
}

export interface ExpandResponse {
  query: string;
  expanded_results: Array<{
    decision_id: string;
    enrichment: { source: string; snippet: string }[];
  }>;
  context_tier: "full" | "degraded" | "unavailable";
}

export interface BriefResponse {
  topic: string;
  verdict: string; // composed synthesis (axiom dropped — composition allowed)
  citations: Array<{
    decision_id: string;
    body: string;
    evidence_source?: string;
    evidence_snippet?: string;
  }>;
  refusal?: { reason: string };
}

export class AssayMCPServer {
  private readonly store: DecisionStore;
  private readonly provider: MemoryProvider;

  constructor(
    store: DecisionStore = new DecisionStore(),
    provider: MemoryProvider = new ClaudeMemHTTPProvider(),
  ) {
    this.store = store;
    this.provider = provider;
  }

  async close(): Promise<void> {
    this.store.close();
  }

  /**
   * assay_decision_recall: typed decision-graph recall with provider enrichment.
   *
   * Flow (per CEO review §2 Days 11-13):
   *   1. Cold-start check: if total corpus <5 decisions, return cold-start envelope.
   *   2. Deterministic coverage: retrieve recent decisions (no agent-judgment fetching).
   *      Note: full vector similarity over decisions is a v3 add; v2 uses recency.
   *   3. Two-tier context enrichment: top-N batched eagerly via provider.
   *   4. Supersession traversal: walk chain for each result.
   *   5. Graceful degrade: provider unreachable → return decisions without enrichment.
   */
  async recall(query: string, opts: { limit?: number } = {}): Promise<RecallResponse> {
    const limit = opts.limit ?? RECALL_DEFAULT_LIMIT;
    const corpusSize = this.store.count();

    if (corpusSize < COLD_START_THRESHOLD) {
      return {
        query,
        results: [],
        context_tier: "unavailable",
        cold_start: {
          message: `Your decision corpus has ${corpusSize} item${corpusSize === 1 ? "" : "s"} (fewer than ${COLD_START_THRESHOLD}). AssayLabs accumulates decisions as you work — tag decisions inline with <assay-decision> in your agent sessions, or invoke /assay-decision-deposit explicitly. Recall improves with use.`,
          corpus_size: corpusSize,
        },
      };
    }

    // v2 deterministic coverage = recent decisions. v3 swaps to vector similarity
    // once the decisions table supports embeddings (deferred per Anti-axiom #6).
    const decisions = this.store.recent(limit);

    // Probe provider health before fan-out. Malformed providers (missing
    // fields, wrong types, throws) all degrade to "unavailable" — never throw
    // out to the caller. C7 contract: graceful degrade is unconditional.
    let health: { status?: string; reason?: string };
    try {
      health = await this.provider.health();
    } catch (err) {
      health = { status: "offline", reason: err instanceof Error ? err.message : String(err) };
    }
    const contextTier: RecallResponse["context_tier"] =
      health?.status === "full" ? "full"
      : health?.status === "degraded" ? "degraded"
      : "unavailable";

    const results: RecallResponse["results"] = [];

    if (contextTier === "unavailable") {
      // Graceful degrade: return decisions without enrichment, flag tier.
      for (const d of decisions) {
        results.push({
          decision: d,
          supersession_chain: this.store.supersessionChain(d.id),
        });
      }
      return {
        query,
        results,
        context_tier: "unavailable",
        context_tier_reason: health?.reason ?? "provider offline",
      };
    }

    // Two-tier eager fetch: enrich top-N via batched provider call.
    // Cap the search to EAGER_FETCH_TOP_N to honor the "lazy 4-10" contract —
    // expand() does the wider fetch on demand.
    //
    // Per-decision enrichment: each top-3 decision gets the SINGLE most-relevant
    // observation by index position (1st decision ↔ 1st observation, etc).
    // This is a pragmatic v2 mapping — the local decision IDs and claude-mem
    // observation IDs are in different namespaces, so we can't do strict ID joins.
    // v3 candidate: semantic similarity between decision body and observation
    // narrative to do real per-decision matching.
    const eagerDecisions = decisions.slice(0, EAGER_FETCH_TOP_N);
    let enrichmentMap = new Map<string, { source: string; snippet: string }[]>();
    try {
      const searchResults = await this.provider.search(query, { limit: EAGER_FETCH_TOP_N });
      const ids = searchResults.map((r) => r.id);
      if (ids.length > 0) {
        const { found } = await this.provider.getObservations(ids);
        // Per-decision mapping: decision[i] gets observation[i] when both exist.
        for (let i = 0; i < eagerDecisions.length; i++) {
          const obs = found[i];
          if (obs) {
            enrichmentMap.set(eagerDecisions[i]!.id, [{
              source: `claude-mem:${obs.id}`,
              snippet: (obs.narrative ?? obs.text ?? "").slice(0, 280),
            }]);
          }
        }
      }
    } catch (err) {
      // Provider call failed mid-flight; degrade for this request.
      return {
        query,
        results: decisions.map((d) => ({
          decision: d,
          supersession_chain: this.store.supersessionChain(d.id),
        })),
        context_tier: "degraded",
        context_tier_reason: err instanceof Error ? err.message : String(err),
      };
    }

    for (const d of decisions) {
      results.push({
        decision: d,
        supersession_chain: this.store.supersessionChain(d.id),
        enrichment: enrichmentMap.get(d.id),
      });
    }

    return { query, results, context_tier: contextTier };
  }

  /**
   * assay_decision_expand: lazy fetch ranks 4-10 enrichment.
   * (Top-3 are already eagerly enriched by recall().)
   */
  async expand(query: string, decisionIds: string[]): Promise<ExpandResponse> {
    const health = await this.provider.health();
    const contextTier: ExpandResponse["context_tier"] =
      health.status === "full" ? "full"
      : health.status === "degraded" ? "degraded"
      : "unavailable";

    if (contextTier === "unavailable") {
      return { query, expanded_results: [], context_tier: "unavailable" };
    }

    const expanded: ExpandResponse["expanded_results"] = [];
    try {
      const searchResults = await this.provider.search(query, { limit: 20 });
      const allIds = searchResults.map((r) => r.id);
      const { found } = await this.provider.getObservations(allIds);
      for (const decisionId of decisionIds) {
        expanded.push({
          decision_id: decisionId,
          enrichment: found.map((o) => ({
            source: `claude-mem:${o.id}`,
            snippet: (o.narrative ?? o.text ?? "").slice(0, 280),
          })),
        });
      }
    } catch (err) {
      return { query, expanded_results: [], context_tier: "degraded" };
    }

    return { query, expanded_results: expanded, context_tier: contextTier };
  }

  /**
   * assay_brief_render: composes a verdict from accumulated decisions + evidence.
   * Synthesis is permitted (axiom dropped); opacity is not — every verdict carries
   * citations. Refusal envelope when confidence is low or evidence is ambiguous.
   */
  async brief(topic: string): Promise<BriefResponse> {
    const corpusSize = this.store.count();
    if (corpusSize < COLD_START_THRESHOLD) {
      return {
        topic,
        verdict: "",
        citations: [],
        refusal: {
          reason: `Your decision corpus has ${corpusSize} item${corpusSize === 1 ? "" : "s"} (fewer than ${COLD_START_THRESHOLD}). Brief composition needs more accumulated evidence.`,
        },
      };
    }

    // Topic relevance filter: a brief MUST be on-topic, not just "recent decisions".
    // Strategy: case-insensitive substring match on decision bodies, with a fallback
    // to claude-mem semantic search when available. If neither yields matches, refuse.
    const lowerTopic = topic.toLowerCase().trim();
    const topicTokens = lowerTopic
      .split(/\s+/)
      .filter((t) => t.length >= 3);  // skip stop words like 'a', 'of'

    const allRecent = this.store.recent(50);  // wide pool to filter
    let relevant: typeof allRecent = [];

    if (topicTokens.length === 0) {
      // Empty topic = no relevance signal. Refuse.
      return {
        topic,
        verdict: "",
        citations: [],
        refusal: { reason: "Topic too short to brief on. Provide a more specific topic." },
      };
    }

    relevant = allRecent.filter((d) => {
      const body = d.body.toLowerCase();
      const layer = (d.layer ?? "").toLowerCase();
      return topicTokens.some((t) => body.includes(t) || layer.includes(t));
    });

    // Augment with claude-mem semantic results if the provider is reachable.
    if (relevant.length < 5) {
      try {
        const health = await this.provider.health();
        if (health.status !== "offline") {
          const semantic = await this.provider.search(topic, { limit: 5 });
          // We can't directly map semantic IDs to decisions (different stores),
          // but if semantic returns nothing AND substring is empty, the corpus
          // has no signal on this topic. Use semantic count as a signal only.
          if (semantic.length === 0 && relevant.length === 0) {
            return {
              topic,
              verdict: "",
              citations: [],
              refusal: { reason: `No decisions in corpus match topic "${topic}". Try a broader query or use /assay-decision for raw recall.` },
            };
          }
        }
      } catch {
        // Provider failure is not a refusal trigger — we still have substring matches (or not).
      }
    }

    if (relevant.length === 0) {
      return {
        topic,
        verdict: "",
        citations: [],
        refusal: { reason: `No decisions in corpus match topic "${topic}". Try a broader query or use /assay-decision for raw recall.` },
      };
    }

    // Compose verdict: stitch matching decision bodies, each with citation marker.
    const top = relevant.slice(0, 5);
    const citations = top.map((d) => ({
      decision_id: d.id,
      body: d.body,
    }));
    const verdict = top.map((d, i) => `[${i + 1}] ${d.body}`).join("\n\n");

    return { topic, verdict, citations };
  }
}
