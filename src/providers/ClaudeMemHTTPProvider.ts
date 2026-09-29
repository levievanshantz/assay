// ClaudeMemHTTPProvider — concrete MemoryProvider talking to claude-mem v13.2.0
// worker over localhost HTTP. Port discovery: 37700 + (uid % 100) or
// CLAUDE_MEM_WORKER_PORT env var. v13 response shape is MCP envelope:
// { content: [{ type: "text", text: "<json string>" }], isError?: boolean }.

import {
  type MemoryProvider,
  type SearchOptions,
  type SearchResult,
  type BatchGetResult,
  type HealthResult,
  type HealthStatus,
} from "./MemoryProvider.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const FULL_HEALTH_LATENCY_MS = 1_000;

interface MCPEnvelope {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function defaultPort(): number {
  const env = process.env.CLAUDE_MEM_WORKER_PORT;
  if (env) return Number(env);
  const uid = process.getuid?.() ?? 0;
  return 37700 + (uid % 100);
}

function parseEnvelope<T>(envelope: MCPEnvelope): T {
  if (envelope.isError) {
    const msg = envelope.content?.[0]?.text ?? "unknown error";
    throw new Error(`claude-mem error: ${msg}`);
  }
  const text = envelope.content?.[0]?.text;
  if (!text) throw new Error("claude-mem returned empty content");
  return JSON.parse(text) as T;
}

export interface ClaudeMemHTTPProviderOptions {
  port?: number;
  baseUrl?: string;
  timeoutMs?: number;
}

export class ClaudeMemHTTPProvider implements MemoryProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: ClaudeMemHTTPProviderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? `http://localhost:${opts.port ?? defaultPort()}`;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const params = new URLSearchParams({ query });
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.type) params.set("type", opts.type);
    if (opts.project) params.set("project", opts.project);

    const envelope = await this.fetchJSON<MCPEnvelope>(`/api/search?${params}`);
    const data = parseEnvelope<{ results?: SearchResult[] }>(envelope);
    const results = data.results ?? [];
    return opts.minScore !== undefined
      ? results.filter((r) => r.score >= opts.minScore!)
      : results;
  }

  async getObservations(ids: string[]): Promise<BatchGetResult> {
    if (ids.length === 0) return { found: [], missing: [] };

    const envelope = await this.fetchJSON<MCPEnvelope>("/api/observations/batch", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    const data = parseEnvelope<{ observations?: Observation[] }>(envelope);
    const found = data.observations ?? [];
    const foundIds = new Set(found.map((o) => o.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    return { found, missing };
  }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      type HealthBody = {
        status: string;
        version?: string;
        uptime?: number;
        mcpReady?: boolean;
      };
      const body = await this.fetchJSON<HealthBody>("/api/health");
      const latency_ms = Date.now() - start;
      const status: HealthStatus = body.status === "ok" && body.mcpReady !== false
        ? latency_ms < FULL_HEALTH_LATENCY_MS ? "full" : "degraded"
        : "degraded";
      return { status, latency_ms };
    } catch (err) {
      return {
        status: "offline",
        latency_ms: Date.now() - start,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

type Observation = import("./MemoryProvider.js").Observation;
