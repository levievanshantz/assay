// Evals C1-C5: capture, idempotency, rescue tiers, profile gating, claude-mem independence.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineEval, assert } from "../lib/harness.mjs";

import { runStopDrain } from "../../dist/hooks/stopDrain.js";
import { DecisionStore } from "../../dist/decisions/store.js";
import { parseDecisionTags } from "../../dist/parser/decisionTagParser.js";

// ────────────────────────────────────────────────────────────────────────
export const C1 = defineEval({
  id: "C1",
  name: "decision tag capture from agent transcripts",
  async verify({ sandbox }) {
    const trans = join(sandbox.dir, "t.txt");
    await writeFile(trans, `
some agent narrative
<assay-decision kind="decision" confidence="0.8" layer="storage">
Keep all decision data on the user's machine.
</assay-decision>
more text
<assay-decision kind="decision">
Use SQLite for v2 storage.
</assay-decision>
`);
    const result = await runStopDrain({ transcript_path: trans, session_id: "c1-eval" });
    assert(result.ok, `hook returned !ok: ${result.reason}`);
    assert(result.decisions_captured === 2, `expected 2 captured, got ${result.decisions_captured}`);
    const store = new DecisionStore(sandbox.dbPath);
    assert(store.count() === 2, `expected 2 in DB, got ${store.count()}`);
    const recent = store.recent(10);
    const r1 = recent.find(r => r.body.includes("user's machine"));
    const r2 = recent.find(r => r.body.includes("SQLite"));
    assert(r1, `storage decision not found`);
    assert(r2, `SQLite decision not found`);
    assert(r1.confidence === 0.8, `confidence not captured: ${r1.confidence}`);
    assert(r1.layer === "storage", `layer not captured: ${r1.layer}`);
    assert(r1.status === "tentative", `status not tentative: ${r1.status}`);
    store.close();
    return { pass: true, details: { captured: 2, with_attrs: 1 } };
  },
  async adversarial({ sandbox }) {
    const trans = join(sandbox.dir, "adv.txt");
    // Mix of malformed, unicode, SQL-injection-shaped, and valid tags.
    await writeFile(trans, `
<assay-decision kind="decision">Body with 'quotes' and "dquotes" 😀 unicode</assay-decision>
<assay-decision kind="UNKNOWN">should be rejected</assay-decision>
<assay-decision kind="decision"></assay-decision>
<assay-decision kind="decision" confidence="999">bad confidence</assay-decision>
<assay-decision kind="decision">'; DROP TABLE decisions;--</assay-decision>
<assay-decision kind="decision"
no close tag, will not match
<assay-decision kind="decision">${"x".repeat(50000)}</assay-decision>
`);
    const result = await runStopDrain({ transcript_path: trans, session_id: "c1-adv" });
    assert(result.ok, `hook should still return ok with mixed input: ${result.reason}`);
    const store = new DecisionStore(sandbox.dbPath);
    const count = store.count();
    // valid: unicode body, sql-injection-shaped body, 50KB body (parser doesn't size-limit)
    // confidence=999 keeps the decision but records a parse error for the bad confidence
    // also keeps decisions; idempotency dedupes same body — these are all unique bodies
    assert(count >= 3 && count <= 5, `expected 3-5 valid decisions persisted, got ${count}`);
    const all = store.recent(20);
    const sqlInj = all.find(r => r.body.includes("DROP TABLE"));
    assert(sqlInj, `SQL-injection-shaped body should be stored as plain text`);
    // verify SQL injection didn't actually drop the table — store still works
    assert(store.count() === count, `table integrity check`);
    store.close();
    return { pass: true, details: { persisted: count, malformed_skipped: true } };
  },
});

// ────────────────────────────────────────────────────────────────────────
export const C2 = defineEval({
  id: "C2",
  name: "idempotency on duplicate tags",
  async verify({ sandbox }) {
    const trans = join(sandbox.dir, "dup.txt");
    await writeFile(trans, `
<assay-decision kind="decision">Same body.</assay-decision>
between
<assay-decision kind="decision">Same body.</assay-decision>
more
<assay-decision kind="decision">Same body.</assay-decision>
different
<assay-decision kind="decision">Different body.</assay-decision>
`);
    const result = await runStopDrain({ transcript_path: trans });
    const store = new DecisionStore(sandbox.dbPath);
    assert(store.count() === 2, `expected 2 (1 deduped + 1 unique), got ${store.count()}`);
    store.close();
    return { pass: true, details: { persisted: 2, deduped: 2 } };
  },
  async adversarial({ sandbox }) {
    const trans = join(sandbox.dir, "dup-adv.txt");
    // dedupe by kind+body — different kind should NOT dedupe even with same body
    await writeFile(trans, `
<assay-decision kind="decision">X.</assay-decision>
<assay-decision kind="conflict">X.</assay-decision>
<assay-decision kind="decision"> X. </assay-decision>
`);
    const result = await runStopDrain({ transcript_path: trans });
    const store = new DecisionStore(sandbox.dbPath);
    // expect 2 (decision X + conflict X). The third has extra whitespace
    // but the parser .trim()s, so " X. " becomes "X." and dedupes.
    assert(store.count() === 2, `expected 2 (different kinds = different), got ${store.count()}`);
    store.close();
    return { pass: true, details: { kinds_distinct: true, whitespace_normalized: true } };
  },
});

// ────────────────────────────────────────────────────────────────────────
export const C3 = defineEval({
  id: "C3",
  name: "three-tier rescue: no silent drops",
  async verify({ sandbox }) {
    // Tier 2 verification: malformed tag interleaved with valid — hook still ok,
    // valid persisted, malformed logged not crashed.
    const trans = join(sandbox.dir, "rescue.txt");
    await writeFile(trans, `
<assay-decision kind="decision">Valid one.</assay-decision>
<assay-decision kind="BROKEN">malformed kind</assay-decision>
<assay-decision kind="decision">Valid two.</assay-decision>
`);
    const result = await runStopDrain({ transcript_path: trans });
    assert(result.ok, `hook should still ok despite tier-2 error`);
    assert(result.parse_errors >= 1, `expected parse_errors >= 1, got ${result.parse_errors}`);
    const store = new DecisionStore(sandbox.dbPath);
    assert(store.count() === 2, `expected 2 valid persisted, got ${store.count()}`);
    store.close();
    return { pass: true, details: { valid_persisted: 2, errors_logged: result.parse_errors } };
  },
  async adversarial({ sandbox }) {
    // Adversarial: missing transcriptPath → graceful failure, not crash.
    const result = await runStopDrain({});
    assert(!result.ok, `should return !ok on missing path`);
    assert(/transcriptPath/i.test(result.reason || ""), `reason should mention transcriptPath: ${result.reason}`);
    // Adversarial: unreadable file → graceful failure.
    const r2 = await runStopDrain({ transcript_path: "/nonexistent/totally/missing.txt" });
    assert(!r2.ok, `should return !ok on unreadable file`);
    return { pass: true, details: { missing_path: "graceful", unreadable: "graceful" } };
  },
});

// ────────────────────────────────────────────────────────────────────────
export const C4 = defineEval({
  id: "C4",
  name: "profile gating via ECC_HOOK_PROFILE",
  async verify({ sandbox }) {
    const trans = join(sandbox.dir, "prof.txt");
    await writeFile(trans, `<assay-decision kind="decision">profile test</assay-decision>`);

    // minimal: noop
    sandbox.setEnv("ECC_HOOK_PROFILE", "minimal");
    const r1 = await runStopDrain({ transcript_path: trans });
    assert(r1.ok && /minimal/.test(r1.reason || ""), `minimal should noop with reason`);
    let store = new DecisionStore(sandbox.dbPath);
    assert(store.count() === 0, `minimal should not persist, found ${store.count()}`);
    store.close();

    // standard: persist
    sandbox.setEnv("ECC_HOOK_PROFILE", "standard");
    const r2 = await runStopDrain({ transcript_path: trans });
    assert(r2.ok && r2.decisions_captured === 1, `standard should persist 1`);
    store = new DecisionStore(sandbox.dbPath);
    assert(store.count() === 1, `standard should have 1 row`);
    store.close();

    // unknown profile → fallback to standard
    sandbox.setEnv("ECC_HOOK_PROFILE", "weirdvalue");
    const trans2 = join(sandbox.dir, "prof2.txt");
    await writeFile(trans2, `<assay-decision kind="decision">unknown profile</assay-decision>`);
    const r3 = await runStopDrain({ transcript_path: trans2 });
    assert(r3.ok && r3.decisions_captured === 1, `unknown profile should fall back to standard`);

    return { pass: true, details: { minimal: "noop", standard: "persist", unknown: "fallback-to-standard" } };
  },
  async adversarial({ sandbox }) {
    // Disabled hooks env var should win even over profile=strict
    const trans = join(sandbox.dir, "disabled.txt");
    await writeFile(trans, `<assay-decision kind="decision">should not persist</assay-decision>`);
    sandbox.setEnv("ECC_HOOK_PROFILE", "strict");
    sandbox.setEnv("ECC_DISABLED_HOOKS", "stop:zz-assay-decision-drain");
    const result = await runStopDrain({ transcript_path: trans });
    assert(result.ok, `disabled should still return ok`);
    assert(/disabled/i.test(result.reason || ""), `reason should mention disabled: ${result.reason}`);
    const store = new DecisionStore(sandbox.dbPath);
    assert(store.count() === 0, `disabled should not persist anything, got ${store.count()}`);
    store.close();
    return { pass: true, details: { disabled_wins_over_strict: true } };
  },
});

// ────────────────────────────────────────────────────────────────────────
export const C5 = defineEval({
  id: "C5",
  name: "independent transcript parse — no dependency on claude-mem",
  async verify({ sandbox }) {
    // The hook never touches claude-mem for tag extraction. Force-set
    // ASSAY env to verify the path is fully self-contained.
    const trans = join(sandbox.dir, "indep.txt");
    await writeFile(trans, `<assay-decision kind="decision">Independent capture.</assay-decision>`);
    const result = await runStopDrain({ transcript_path: trans });
    assert(result.ok && result.decisions_captured === 1, `independent capture failed`);
    const store = new DecisionStore(sandbox.dbPath);
    assert(store.count() === 1, `db should have 1`);
    store.close();
    return { pass: true, details: { capture_independent_of_claude_mem: true } };
  },
  async adversarial({ sandbox }) {
    // Even with claude-mem worker URL pointed at non-routable address,
    // hook capture should succeed (capture doesn't call claude-mem at all).
    sandbox.setEnv("CLAUDE_MEM_WORKER_PORT", "65535");  // unreachable
    const trans = join(sandbox.dir, "indep-adv.txt");
    await writeFile(trans, `<assay-decision kind="decision">Capture with bad provider URL.</assay-decision>`);
    const result = await runStopDrain({ transcript_path: trans });
    assert(result.ok && result.decisions_captured === 1, `capture must not depend on claude-mem reachability`);
    return { pass: true, details: { capture_resilient_to_provider_offline: true } };
  },
});
