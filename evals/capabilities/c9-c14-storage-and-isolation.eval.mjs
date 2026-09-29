// Evals C9-C14: storage isolation, audit trail, supersession walk, cold-start,
// two-tier fetch, local-first.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { defineEval, assert } from "../lib/harness.mjs";

import { runStopDrain } from "../../dist/hooks/stopDrain.js";
import { DecisionStore } from "../../dist/decisions/store.js";
import { AssayMCPServer } from "../../dist/mcp/server.js";
import { ClaudeMemHTTPProvider } from "../../dist/providers/ClaudeMemHTTPProvider.js";

// Writes n tags with bodies "Decision <offset+1>." .. "Decision <offset+n>." and
// runs the Stop hook. A second call must pass an offset past the first call's
// bodies: cross-run dedupe skips a body that is already stored.
async function populateCorpus(sandbox, n = 5, offset = 0) {
  const trans = join(sandbox.dir, "p.txt");
  const tags = Array.from({ length: n }, (_, i) =>
    `<assay-decision kind="decision">Decision ${offset + i + 1}.</assay-decision>`
  ).join("\n");
  await writeFile(trans, tags);
  await runStopDrain({ transcript_path: trans });
}

// ────────────────────────────────────────────────────────────────────────
export const C9 = defineEval({
  id: "C9",
  name: "storage isolation via ASSAY_DB_PATH",
  async verify({ sandbox }) {
    // Use the real ~/.assay/decisions.db count as baseline. Run hook with
    // probe path set. Verify probe got the row and real did NOT.
    delete process.env.ASSAY_DB_PATH;
    const realStore = new DecisionStore();  // real path
    const realBefore = realStore.count();
    realStore.close();

    sandbox.setEnv("ASSAY_DB_PATH", sandbox.dbPath);
    const trans = join(sandbox.dir, "iso.txt");
    await writeFile(trans, `<assay-decision kind="decision">Isolation probe.</assay-decision>`);
    const result = await runStopDrain({ transcript_path: trans });
    assert(result.ok, `hook failed: ${result.reason}`);

    const probeStore = new DecisionStore(sandbox.dbPath);
    assert(probeStore.count() === 1, `probe should have 1, got ${probeStore.count()}`);
    probeStore.close();

    delete process.env.ASSAY_DB_PATH;
    const realAfter = new DecisionStore();
    const realAfterCount = realAfter.count();
    realAfter.close();
    assert(realAfterCount === realBefore, `REAL DB POLLUTED: before=${realBefore} after=${realAfterCount}`);
    return { pass: true, details: { probe_received: 1, real_db_unchanged: true } };
  },
  async adversarial({ sandbox }) {
    // Empty string env var should NOT redirect — empty means use default
    sandbox.setEnv("ASSAY_DB_PATH", "");
    // Best we can verify here: DecisionStore() with empty env should use ~/.assay/decisions.db
    // and the default path resolution shouldn't crash.
    // Note: implementation treats empty string as falsy, so falls back to ~/.assay
    const store = new DecisionStore();
    const path = store.db?.name; // better-sqlite3 exposes .name on the db
    if (!path || path === "") {
      throw new Error(`store opened against empty path`);
    }
    store.close();
    return { pass: true, details: { empty_env_var: "falls-back-to-default" } };
  },
});

// ────────────────────────────────────────────────────────────────────────
export const C10 = defineEval({
  id: "C10",
  name: "append-only audit trail in decision_transitions",
  async verify({ sandbox }) {
    await populateCorpus(sandbox, 3);
    const db = new Database(sandbox.dbPath);
    const dCount = db.prepare("SELECT COUNT(*) as n FROM decisions").get().n;
    const tCount = db.prepare("SELECT COUNT(*) as n FROM decision_transitions").get().n;
    assert(tCount >= dCount, `transitions ${tCount} should be >= decisions ${dCount}`);
    const rows = db.prepare("SELECT * FROM decision_transitions ORDER BY transitioned_at").all();
    for (const r of rows) {
      assert(r.decision_id, `transition missing decision_id`);
      assert(r.to_status, `transition missing to_status`);
      const decisionExists = db.prepare("SELECT 1 FROM decisions WHERE id = ?").get(r.decision_id);
      assert(decisionExists, `transition references nonexistent decision_id ${r.decision_id}`);
    }
    // initial deposits have from_status NULL
    const initials = rows.filter(r => r.from_status === null);
    assert(initials.length === dCount, `expected ${dCount} initial deposits, got ${initials.length}`);
    db.close();
    return { pass: true, details: { decisions: dCount, transitions: tCount, initial_deposits: initials.length } };
  },
  async adversarial({ sandbox }) {
    // C10 strengthened: append-only must be enforced by storage triggers,
    // not just API absence. Codex's probe direct-SQL-tampered the table;
    // after the fix, BEFORE UPDATE/DELETE triggers reject the operation.
    await populateCorpus(sandbox, 1);
    const db = new Database(sandbox.dbPath);
    let updateBlocked = false;
    let deleteBlocked = false;
    try {
      db.exec("UPDATE decision_transitions SET reason = 'tampered'");
    } catch (err) {
      if (/append-only/i.test(err.message)) updateBlocked = true;
    }
    try {
      db.exec("DELETE FROM decision_transitions");
    } catch (err) {
      if (/append-only/i.test(err.message)) deleteBlocked = true;
    }
    db.close();
    assert(updateBlocked, `UPDATE on decision_transitions was NOT blocked by trigger`);
    assert(deleteBlocked, `DELETE on decision_transitions was NOT blocked by trigger`);
    // Also verify the API-level absence still holds.
    const store = new DecisionStore(sandbox.dbPath);
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
    const hasDelete = proto.some(m => /delet|remove/i.test(m) && /trans/i.test(m));
    store.close();
    assert(!hasDelete, `found delete-transition-like method on DecisionStore: ${proto.join(",")}`);
    return { pass: true, details: { storage_triggers: true, api_no_mutate: true } };
  },
});

// ────────────────────────────────────────────────────────────────────────
export const C11 = defineEval({
  id: "C11",
  name: "cycle-guarded supersession walk (max 10 hops)",
  async verify({ sandbox }) {
    const store = new DecisionStore(sandbox.dbPath);
    // Plant a clean linear chain manually for predictable test
    const db = new Database(sandbox.dbPath);
    const now = Date.now();
    const insert = db.prepare(`INSERT INTO decisions (id, kind, body, status, created_at, updated_at, supersedes_resolved_id) VALUES (?, 'decision', ?, 'tentative', ?, ?, ?)`);
    insert.run("aaa", "A: oldest", now - 4, now - 4, null);
    insert.run("bbb", "B", now - 3, now - 3, "aaa");
    insert.run("ccc", "C", now - 2, now - 2, "bbb");
    insert.run("ddd", "D: newest", now - 1, now - 1, "ccc");
    db.close();

    const chain = store.supersessionChain("ddd");
    assert(chain.length === 4, `expected linear chain of 4, got ${chain.length}`);
    assert(chain[0].id === "aaa" && chain[3].id === "ddd", `chain not in oldest-first order`);
    store.close();
    return { pass: true, details: { linear_chain: chain.map(d => d.id) } };
  },
  async adversarial({ sandbox }) {
    const store = new DecisionStore(sandbox.dbPath);
    const db = new Database(sandbox.dbPath);
    const now = Date.now();
    const insert = db.prepare(`INSERT INTO decisions (id, kind, body, status, created_at, updated_at, supersedes_resolved_id) VALUES (?, 'decision', ?, 'tentative', ?, ?, ?)`);
    // cycle: A → B → A (B supersedes A; A supersedes B)
    insert.run("ca", "cycle A", now, now, "cb");
    insert.run("cb", "cycle B", now, now, "ca");
    db.close();

    // Should not infinite-loop; should cap by visited set
    const start = Date.now();
    const chain = store.supersessionChain("ca");
    const elapsed = Date.now() - start;
    assert(elapsed < 1000, `supersession walk took too long: ${elapsed}ms — possible infinite loop`);
    assert(chain.length <= 2, `cycle should produce 2-element chain, got ${chain.length}`);
    store.close();
    return { pass: true, details: { cycle_terminated: true, chain_size: chain.length, elapsed_ms: elapsed } };
  },
});

// ────────────────────────────────────────────────────────────────────────
export const C12 = defineEval({
  id: "C12",
  name: "cold-start envelope at corpus size <5",
  async verify({ sandbox }) {
    // count=0
    const s1 = new AssayMCPServer(new DecisionStore(sandbox.dbPath), new ClaudeMemHTTPProvider());
    const r1 = await s1.recall("x");
    assert(r1.cold_start && r1.cold_start.corpus_size === 0, `expected cold_start with 0`);
    await s1.close();
    // count=4
    await populateCorpus(sandbox, 4);
    const s2 = new AssayMCPServer(new DecisionStore(sandbox.dbPath), new ClaudeMemHTTPProvider());
    const r2 = await s2.recall("x");
    assert(r2.cold_start && r2.cold_start.corpus_size === 4, `expected cold_start with 4`);
    await s2.close();
    // count=5 → no cold_start
    await populateCorpus(sandbox, 1, 4);  // "Decision 5." -> 5 total
    const s3store = new DecisionStore(sandbox.dbPath);
    assert(s3store.count() === 5, `fifth deposit should land, corpus has ${s3store.count()}`);
    const s3 = new AssayMCPServer(s3store, new ClaudeMemHTTPProvider());
    const r3 = await s3.recall("x");
    assert(!r3.cold_start, `cold_start should be absent at 5+, got ${JSON.stringify(r3.cold_start)}`);
    await s3.close();
    return { pass: true, details: { at_0: "cold-start", at_4: "cold-start", at_5: "normal-results" } };
  },
  async adversarial({ sandbox }) {
    // C12 adversarial (Codex caught no-phase): edge cases around threshold.
    // 1. Exactly at threshold (5): no cold_start
    await populateCorpus(sandbox, 5);
    const s1 = new AssayMCPServer(new DecisionStore(sandbox.dbPath), new ClaudeMemHTTPProvider());
    const r1 = await s1.recall("x");
    assert(!r1.cold_start, `at exactly 5: no cold_start, got ${JSON.stringify(r1.cold_start)}`);
    await s1.close();

    // 2. After raw delete bringing count below threshold: cold_start returns
    const db = new Database(sandbox.dbPath);
    db.pragma("foreign_keys = OFF");
    db.exec("DELETE FROM decisions WHERE rowid <= 3");  // delete 3, leave 2
    db.close();
    const s2 = new AssayMCPServer(new DecisionStore(sandbox.dbPath), new ClaudeMemHTTPProvider());
    const r2 = await s2.recall("x");
    assert(r2.cold_start && r2.cold_start.corpus_size === 2,
      `after delete to 2: expected cold_start with corpus_size:2, got ${JSON.stringify(r2.cold_start)}`);
    await s2.close();

    return { pass: true, details: { at_5: "no-cold-start", after_delete_to_2: "cold-start" } };
  },
});

// ────────────────────────────────────────────────────────────────────────
export const C13 = defineEval({
  id: "C13",
  name: "two-tier enrichment fetch",
  async verify({ sandbox }) {
    await populateCorpus(sandbox, 6);
    const server = new AssayMCPServer(
      new DecisionStore(sandbox.dbPath),
      new ClaudeMemHTTPProvider(),
    );
    const recallResp = await server.recall("topic");
    // Eager-tier behavior: only top-3 have enrichment populated (when provider is full).
    // Hard to assert exactly without controlling claude-mem's response, but
    // we CAN assert that the implementation only attempts top-3 — by checking
    // that recall results' enrichment count ≤3 even when results.length is higher.
    const enriched = recallResp.results.filter(r => r.enrichment && r.enrichment.length > 0);
    assert(enriched.length <= 3, `eager tier exceeded 3, got ${enriched.length}`);
    const expandResp = await server.expand("topic", recallResp.results.map(r => r.decision.id));
    assert(Array.isArray(expandResp.expanded_results), `expand should return array`);
    await server.close();
    return { pass: true, details: { eager_enriched: enriched.length, expand_works: true } };
  },
  async adversarial({ sandbox }) {
    // C13 adversarial (Codex caught no-phase + over-fetch): eager search
    // must request only TOP-3 from provider, not 10. Use a fake provider
    // that records the limits it was called with.
    await populateCorpus(sandbox, 8);

    const calls = { search: [], getObs: [] };
    const fakeProvider = {
      async health() { return { status: "full", latency_ms: 1 }; },
      async search(q, opts) {
        calls.search.push(opts?.limit);
        return Array.from({ length: Math.min(opts?.limit ?? 10, 5) }, (_, i) => ({
          id: `obs-${i}`, score: 0.9 - i * 0.1, snippet: `s${i}`, type: "x", created_at: Date.now(),
        }));
      },
      async getObservations(ids) {
        calls.getObs.push(ids.length);
        return {
          found: ids.map((id) => ({ id, text: `body-${id}`, narrative: `n-${id}`, created_at: Date.now() })),
          missing: [],
        };
      },
    };

    const server = new AssayMCPServer(new DecisionStore(sandbox.dbPath), fakeProvider);
    const recallResp = await server.recall("topic");
    assert(calls.search.length === 1, `expected 1 search call during recall, got ${calls.search.length}`);
    assert(calls.search[0] === 3, `expected search limit=3 (eager top-3), got ${calls.search[0]}`);

    // expand() should fetch more
    const ids = recallResp.results.slice(3, 6).map((r) => r.decision.id);
    const expandResp = await server.expand("topic", ids);
    assert(calls.search.length >= 2, `expand should trigger another search`);
    assert(calls.search[1] >= 10, `expand limit should be >=10 (lazy 4-10 covers wider pool), got ${calls.search[1]}`);

    await server.close();
    return { pass: true, details: { eager_limit: calls.search[0], expand_limit: calls.search[1] } };
  },
});

// ────────────────────────────────────────────────────────────────────────
export const C14 = defineEval({
  id: "C14",
  name: "local-first: no network call required for capture",
  async verify({ sandbox }) {
    // capture path is fully local (no HTTP, no API key needed).
    // Force ANTHROPIC_API_KEY to empty to verify nothing depends on it.
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const trans = join(sandbox.dir, "local.txt");
    await writeFile(trans, `<assay-decision kind="decision">Local-only capture.</assay-decision>`);
    const result = await runStopDrain({ transcript_path: trans });
    assert(result.ok && result.decisions_captured === 1, `capture must work without ANTHROPIC_API_KEY`);
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    return { pass: true, details: { no_api_key_required: true } };
  },
  async adversarial({ sandbox }) {
    // Hammer the capture path 100 times in a tight loop — no rate limiting.
    const trans = join(sandbox.dir, "hammer.txt");
    await writeFile(trans, `<assay-decision kind="decision">Hammer ${Math.random()}.</assay-decision>`);
    const start = Date.now();
    let captured = 0;
    for (let i = 0; i < 100; i++) {
      const t = join(sandbox.dir, `h${i}.txt`);
      await writeFile(t, `<assay-decision kind="decision">Hammer ${i}.</assay-decision>`);
      const r = await runStopDrain({ transcript_path: t });
      if (r.ok && r.decisions_captured === 1) captured++;
    }
    const elapsed = Date.now() - start;
    assert(captured === 100, `expected 100 captures, got ${captured}`);
    assert(elapsed < 60_000, `100 captures took ${elapsed}ms — too slow`);
    return { pass: true, details: { captures: 100, elapsed_ms: elapsed, no_rate_limit: true } };
  },
});
