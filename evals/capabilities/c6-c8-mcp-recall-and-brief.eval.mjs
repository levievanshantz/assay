// Evals C6-C8: MCP recall shape, graceful degrade, brief composition.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineEval, assert } from "../lib/harness.mjs";

import { runStopDrain } from "../../dist/hooks/stopDrain.js";
import { DecisionStore } from "../../dist/decisions/store.js";
import { AssayMCPServer } from "../../dist/mcp/server.js";
import { ClaudeMemHTTPProvider } from "../../dist/providers/ClaudeMemHTTPProvider.js";

// Helper: populate sandbox DB with 5+ decisions (past cold-start threshold).
async function populateCorpus(sandbox, n = 5) {
  const trans = join(sandbox.dir, "populate.txt");
  const tags = Array.from({ length: n }, (_, i) =>
    `<assay-decision kind="decision" confidence="0.${5 + (i % 5)}" layer="${i % 2 === 0 ? "alpha" : "beta"}">Decision number ${i + 1}: relevant to topic X.</assay-decision>`
  ).join("\n");
  await writeFile(trans, tags);
  await runStopDrain({ transcript_path: trans });
}

// ────────────────────────────────────────────────────────────────────────
export const C6 = defineEval({
  id: "C6",
  name: "MCP recall returns cited decisions with supersession chain",
  async verify({ sandbox }) {
    await populateCorpus(sandbox, 6);
    const server = new AssayMCPServer(
      new DecisionStore(sandbox.dbPath),
      new ClaudeMemHTTPProvider(),
    );
    const resp = await server.recall("topic X");
    await server.close();

    assert(resp.query === "topic X", `query echo missing`);
    assert(Array.isArray(resp.results), `results not array`);
    assert(!resp.cold_start, `cold_start should be absent with 6 decisions`);
    assert(resp.results.length >= 5, `expected >=5 results, got ${resp.results.length}`);
    assert(["full", "degraded", "unavailable"].includes(resp.context_tier), `bad context_tier: ${resp.context_tier}`);
    for (const r of resp.results) {
      assert(r.decision?.id, `result missing decision.id`);
      assert(r.decision?.kind, `result missing decision.kind`);
      assert(r.decision?.body, `result missing decision.body`);
      assert(Array.isArray(r.supersession_chain), `supersession_chain missing/wrong type`);
      assert(r.supersession_chain.length >= 1, `supersession_chain should include the decision itself`);
    }
    return { pass: true, details: { results: resp.results.length, context_tier: resp.context_tier } };
  },
  async adversarial({ sandbox }) {
    await populateCorpus(sandbox, 6);
    const server = new AssayMCPServer(
      new DecisionStore(sandbox.dbPath),
      new ClaudeMemHTTPProvider(),
    );
    // empty query
    const r1 = await server.recall("");
    assert(Array.isArray(r1.results), `empty query should still return shape`);
    // very long query
    const r2 = await server.recall("x".repeat(10_000));
    assert(Array.isArray(r2.results), `long query should not crash`);
    // query containing tag-shaped content
    const r3 = await server.recall("<assay-decision>fake tag</assay-decision>");
    assert(Array.isArray(r3.results), `tag-shaped query should not crash`);
    await server.close();
    return { pass: true, details: { empty: "ok", long: "ok", tag_shaped: "ok" } };
  },
});

// ────────────────────────────────────────────────────────────────────────
export const C7 = defineEval({
  id: "C7",
  name: "graceful degrade when memory substrate is unavailable",
  async verify({ sandbox }) {
    await populateCorpus(sandbox, 6);
    // Use a provider pointed at an unreachable port to force offline state
    const provider = new ClaudeMemHTTPProvider({ port: 65535, timeoutMs: 1000 });
    const server = new AssayMCPServer(new DecisionStore(sandbox.dbPath), provider);
    const resp = await server.recall("anything");
    await server.close();

    assert(Array.isArray(resp.results), `should still return results array`);
    assert(resp.results.length >= 5, `decisions should still come back: got ${resp.results.length}`);
    assert(resp.context_tier === "unavailable", `expected unavailable, got ${resp.context_tier}`);
    assert(resp.context_tier_reason, `should have reason on unavailable`);
    return { pass: true, details: { degraded_path_works: true, results: resp.results.length } };
  },
  async adversarial({ sandbox }) {
    await populateCorpus(sandbox, 6);
    // Provider that returns an HTTP-like error on every call: simulate by
    // pointing at a port that accepts connections but never responds correctly.
    // Easier: tiny timeout forces every call to abort.
    const provider = new ClaudeMemHTTPProvider({ timeoutMs: 1 });  // 1ms — every request times out
    const server = new AssayMCPServer(new DecisionStore(sandbox.dbPath), provider);
    let crashed = false;
    let resp;
    try {
      resp = await server.recall("test");
    } catch (err) {
      crashed = true;
    }
    await server.close();
    assert(!crashed, `recall should never throw, even on aggressive timeouts`);
    assert(resp && Array.isArray(resp.results), `recall returns structured response under load`);
    return { pass: true, details: { aggressive_timeouts_handled: true } };
  },
});

// ────────────────────────────────────────────────────────────────────────
export const C8 = defineEval({
  id: "C8",
  name: "brief composition with citations",
  async verify({ sandbox }) {
    await populateCorpus(sandbox, 6);
    const server = new AssayMCPServer(
      new DecisionStore(sandbox.dbPath),
      new ClaudeMemHTTPProvider(),
    );
    const resp = await server.brief("topic X");
    await server.close();

    assert(resp.topic === "topic X", `topic echo missing`);
    if (resp.refusal) {
      throw new Error(`expected verdict, got refusal: ${resp.refusal.reason}`);
    }
    assert(resp.verdict && resp.verdict.length > 0, `verdict should be non-empty`);
    assert(Array.isArray(resp.citations) && resp.citations.length > 0, `citations should be present`);
    // every citation must reference a real decision id
    const store = new DecisionStore(sandbox.dbPath);
    for (const cit of resp.citations) {
      assert(cit.decision_id, `citation missing decision_id`);
      const found = store.get(cit.decision_id);
      assert(found, `citation.decision_id ${cit.decision_id} does not exist in DB`);
    }
    store.close();
    return { pass: true, details: { citations: resp.citations.length } };
  },
  async adversarial({ sandbox }) {
    // C8 strengthened: brief MUST refuse when corpus has decisions but none match the topic.
    // Codex caught the prior behavior of composing recent decisions regardless of relevance.
    const server = new AssayMCPServer(
      new DecisionStore(sandbox.dbPath),
      new ClaudeMemHTTPProvider(),
    );

    // 1) Empty corpus — refuse
    const r1 = await server.brief("anything");
    assert(r1.refusal, `empty corpus must return refusal, got verdict: ${r1.verdict}`);

    // 2) Populated corpus but unrelated topic — refuse (the C8 fix)
    await populateCorpus(sandbox, 6);  // bodies contain "topic X" / "relevant to topic X"
    const r2 = await server.brief("quantum cryptography zebras");  // no match
    assert(r2.refusal, `unrelated topic must refuse, got verdict: ${r2.verdict?.slice(0, 100)}`);
    assert(r2.verdict === "" || !r2.verdict, `verdict must be empty on refusal`);
    assert(r2.citations.length === 0, `no citations on refusal`);

    // 3) Topic that DOES match — should compose
    const r3 = await server.brief("topic X");
    if (r3.refusal) {
      throw new Error(`matching topic should compose, got refusal: ${r3.refusal.reason}`);
    }
    assert(r3.verdict && r3.verdict.length > 0, `verdict should compose on match`);

    // 4) Empty/short topic — refuse
    const r4 = await server.brief("");
    assert(r4.refusal, `empty topic must refuse`);

    await server.close();
    return { pass: true, details: {
      empty_corpus: "refuse",
      unrelated_topic: "refuse",
      matching_topic: "compose",
      empty_topic: "refuse",
    } };
  },
});
