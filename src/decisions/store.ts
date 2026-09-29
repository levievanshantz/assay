// Decision store: thin wrapper over SQLite for ~/.assay/decisions.db.
// Transactional deposit + cycle-guarded supersession walk carry forward
// from current Assay's tested patterns.

import Database from "better-sqlite3";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { SCHEMA } from "./schema.js";
import type { ParsedDecision } from "../parser/decisionTagParser.js";

export interface StoredDecision {
  id: string;
  kind: "decision" | "conflict";
  body: string;
  status: string;
  confidence: number | null;
  layer: string | null;
  supersedes_raw: string | null;
  supersedes_resolved_id: string | null;
  supersedes_unresolved_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface DepositContext {
  session_id?: string;
  transcript_path?: string;
}

const MAX_SUPERSESSION_HOPS = 10;

// Columns the plugin writes or indexes, beyond the core the Librarian's
// init-journal.py drain DDL also creates (id, kind, body, created_at,
// updated_at). If another tool created `decisions` first with fewer columns,
// they are added in place; otherwise CREATE INDEX on a missing column fails
// and every Stop hook and MCP start breaks.
const ADDABLE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["status", "TEXT NOT NULL DEFAULT 'tentative'"],
  ["confidence", "REAL"],
  ["layer", "TEXT"],
  ["supersedes_raw", "TEXT"],
  ["supersedes_resolved_id", "TEXT"],
  ["supersedes_unresolved_reason", "TEXT"],
  ["source_session_id", "TEXT"],
  ["source_transcript_path", "TEXT"],
  ["source_span_start", "INTEGER"],
  ["source_span_end", "INTEGER"],
  ["embedding_model", "TEXT"],
  ["embedded_at", "INTEGER"],
];
const REQUIRED_COLUMNS = ["id", "kind", "body", "created_at", "updated_at"];

function defaultDbPath(): string {
  // Honors ASSAY_DB_PATH override for tests, demos, and sandboxed runs.
  // Falls back to ~/.assay/decisions.db for production use.
  const override = process.env.ASSAY_DB_PATH;
  if (override) {
    mkdirSync(dirname(override), { recursive: true });
    return override;
  }
  const dir = join(homedir(), ".assay");
  mkdirSync(dir, { recursive: true });
  return join(dir, "decisions.db");
}

export class DecisionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = defaultDbPath()) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.addMissingColumns(dbPath);
    this.db.exec(SCHEMA);
  }

  private addMissingColumns(dbPath: string): void {
    const exists = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decisions'")
      .get();
    if (!exists) return; // SCHEMA creates the full table
    const have = new Set(
      (this.db.prepare("PRAGMA table_info(decisions)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    const missingCore = REQUIRED_COLUMNS.filter((c) => !have.has(c));
    if (missingCore.length > 0) {
      throw new Error(
        `decisions table in ${dbPath} lacks required column(s) ${missingCore.join(", ")}; ` +
          `it was not created as an Assay decision drain`,
      );
    }
    for (const [name, def] of ADDABLE_COLUMNS) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE decisions ADD COLUMN ${name} ${def}`);
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Deposit a batch of parsed decisions inside a single transaction.
   * Atomicity per Day 8-10 spec: all-or-nothing on the candidate set.
   * Returns ids of newly inserted decisions.
   *
   * Cross-run dedupe: the Stop hook fires once per turn and re-parses the whole
   * transcript, so every earlier tag comes back each time. A decision whose
   * kind + body is already stored is skipped. The comparison ignores leading and
   * trailing whitespace on stored rows, so bodies saved by earlier builds (which
   * kept an escaped leading/trailing newline) still count as the same decision.
   * It also matches `legacy_body`, the form the Jul 2026 hotfix build stored for
   * the same raw span (it left \t, \r and an escaped backslash before n
   * undecoded), so upgrading mid-session does not store those tags twice.
   */
  depositBatch(decisions: ParsedDecision[], ctx: DepositContext = {}): string[] {
    if (decisions.length === 0) return [];

    const ids: string[] = [];
    const dupCheck = this.db.prepare(`
      SELECT 1 FROM decisions
      WHERE kind = @kind
        AND (body = @body OR trim(body, char(32, 9, 10, 13)) = @body OR body = @legacy_body)
      LIMIT 1
    `);
    const insert = this.db.prepare(`
      INSERT INTO decisions (
        id, kind, body, status, confidence, layer,
        supersedes_raw, source_session_id, source_transcript_path,
        source_span_start, source_span_end, created_at, updated_at
      ) VALUES (
        @id, @kind, @body, 'tentative', @confidence, @layer,
        @supersedes_raw, @session_id, @transcript_path,
        @span_start, @span_end, @now, @now
      )
    `);
    const transition = this.db.prepare(`
      INSERT INTO decision_transitions (decision_id, from_status, to_status, reason, transitioned_at)
      VALUES (?, NULL, 'tentative', 'initial deposit', ?)
    `);

    const txn = this.db.transaction(() => {
      const now = Date.now();
      for (const d of decisions) {
        if (dupCheck.get({ kind: d.kind, body: d.body, legacy_body: d.legacy_body ?? null })) continue;
        const id = randomUUID();
        insert.run({
          id,
          kind: d.kind,
          body: d.body,
          confidence: d.confidence ?? null,
          layer: d.layer ?? null,
          supersedes_raw: d.supersedes_raw ?? null,
          session_id: ctx.session_id ?? null,
          transcript_path: ctx.transcript_path ?? null,
          span_start: d.source_span.start,
          span_end: d.source_span.end,
          now,
        });
        transition.run(id, now);
        ids.push(id);
      }
    });
    txn();
    return ids;
  }

  /**
   * Look up a decision by id.
   */
  get(id: string): StoredDecision | null {
    const row = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as
      | StoredDecision
      | undefined;
    return row ?? null;
  }

  /**
   * Total count of decisions (used for cold-start envelope detection).
   */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as n FROM decisions").get() as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  /**
   * Recent decisions ordered by created_at desc, capped at limit.
   * Used by the SessionStart context payload writer.
   */
  recent(limit = 10): StoredDecision[] {
    return this.db
      .prepare("SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?")
      .all(limit) as StoredDecision[];
  }

  /**
   * Walk the supersession chain forward from a decision id.
   * Returns the chain in deposit order, oldest first. Cycle-guarded.
   * Empty array if id not found.
   */
  supersessionChain(id: string): StoredDecision[] {
    const visited = new Set<string>();
    const chain: StoredDecision[] = [];

    let current = this.get(id);
    while (current && !visited.has(current.id) && chain.length < MAX_SUPERSESSION_HOPS) {
      visited.add(current.id);
      chain.push(current);
      if (!current.supersedes_resolved_id) break;
      current = this.get(current.supersedes_resolved_id);
    }

    return chain.reverse(); // oldest first
  }
}
