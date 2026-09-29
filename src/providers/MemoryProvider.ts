// MemoryProvider — abstraction over the memory substrate AssayLabs depends on.
// Concrete impl for claude-mem v13.2.0 lives in ClaudeMemHTTPProvider.ts.
// Contract test (tests/MemoryProvider.contract.test.ts) runs against every impl.

export type HealthStatus = "full" | "degraded" | "offline";

export interface HealthResult {
  status: HealthStatus;
  latency_ms: number;
  reason?: string;
}

export interface SearchOptions {
  limit?: number;
  minScore?: number;
  type?: string;
  project?: string;
}

export interface SearchResult {
  id: string;
  score: number;
  snippet: string;
  type: string;
  title?: string;
  created_at: number;
}

export interface Observation {
  id: string;
  text: string;
  narrative?: string;
  facts?: string[];
  concepts?: string[];
  created_at: number;
  files_read?: string[];
  files_modified?: string[];
  metadata?: Record<string, unknown>;
}

export interface BatchGetResult {
  found: Observation[];
  missing: string[];
}

export interface MemoryProvider {
  /**
   * Search the memory substrate. Returns results ordered by score (desc).
   * Implementations may use any retrieval strategy; the contract is "best matches first".
   */
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;

  /**
   * Batch-fetch observations by ID. Partial failure is non-fatal:
   * found[] contains what was retrieved; missing[] lists IDs that weren't found.
   */
  getObservations(ids: string[]): Promise<BatchGetResult>;

  /**
   * Probe the substrate's health.
   * - 'full': latency < 1000ms, all features available
   * - 'degraded': substrate reachable but slow or feature-limited
   * - 'offline': unreachable; callers should gracefully degrade
   */
  health(): Promise<HealthResult>;
}
