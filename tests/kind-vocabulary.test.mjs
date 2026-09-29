// The capture protocol (what the MCP server's __IMPORTANT tool teaches), the
// parser, and the decisions table must agree on kinds, so no tag written the
// way the protocol says is dropped at drain.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { sandboxThisProcess } from "./helpers/sandbox.mjs";

const sb = sandboxThisProcess("assay-kinds");
const {
  parseDecisionTags,
  DecisionStore,
  DECISION_KINDS,
  LEGACY_KIND_ALIASES,
  DECISION_CAPTURE_PROTOCOL,
  IMPORTANT_TOOL_DESCRIPTION,
} = await import("../dist/index.js");
const { SCHEMA } = await import("../dist/decisions/schema.js");

function kindsInSchemaCheck() {
  const m = SCHEMA.match(/kind TEXT NOT NULL CHECK \(kind IN \(([^)]*)\)\)/);
  assert.ok(m, "schema must constrain kind with a CHECK");
  return m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
}

function validKindsBlock() {
  const start = DECISION_CAPTURE_PROTOCOL.indexOf("Valid kinds");
  assert.ok(start >= 0, "protocol must list valid kinds");
  const block = DECISION_CAPTURE_PROTOCOL.slice(start).split("\n\n")[0];
  const listed = [...block.matchAll(/^- ([a-z-]+) —/gm)].map((m) => m[1]);
  return { block, listed };
}

test("parser kinds == the decisions table's CHECK constraint", () => {
  assert.deepEqual([...DECISION_KINDS].sort(), kindsInSchemaCheck().sort());
});

test("the protocol's 'Valid kinds' list == the parser's kinds", () => {
  assert.deepEqual(validKindsBlock().listed.sort(), [...DECISION_KINDS].sort());
});

test("every kind the protocol names anywhere is stored, none rejected", () => {
  const bold = [...DECISION_CAPTURE_PROTOCOL.matchAll(/^- \*\*([a-z-]+)\*\* —/gm)].map((m) => m[1]);
  const inline = [...DECISION_CAPTURE_PROTOCOL.matchAll(/kind="([a-z-]+)"/g)].map((m) => m[1]);
  const named = new Set([...bold, ...inline, ...validKindsBlock().listed]);
  assert.ok(named.size >= 6, `expected the six alpha.2 kinds to be named, got ${[...named]}`);
  for (const kind of named) {
    const { decisions, errors } = parseDecisionTags(
      `<assay-decision kind="${kind}">A ${kind} tag body.</assay-decision>`,
    );
    assert.deepEqual(errors, [], `kind="${kind}" must not be rejected`);
    assert.equal(decisions.length, 1, `kind="${kind}" must yield a decision`);
    assert.ok(DECISION_KINDS.includes(decisions[0].kind));
  }
});

test("legacy alpha.2 kinds are stored as decision and keep their original name", () => {
  for (const legacy of Object.keys(LEGACY_KIND_ALIASES)) {
    const { decisions } = parseDecisionTags(`<assay-decision kind="${legacy}">Body.</assay-decision>`);
    assert.equal(decisions[0].kind, "decision");
    assert.equal(decisions[0].kind_alias, legacy);
  }
  const { decisions } = parseDecisionTags('<assay-decision kind="conflict">Body.</assay-decision>');
  assert.equal(decisions[0].kind_alias, undefined);
});

test("unknown kinds are rejected with an error, not stored", () => {
  for (const bad of ["UNKNOWN", "Decision", "constructor", "__proto__", ""]) {
    const { decisions, errors } = parseDecisionTags(`<assay-decision kind="${bad}">Body.</assay-decision>`);
    assert.equal(decisions.length, 0, `kind="${bad}" must be rejected`);
    assert.match(errors[0].message, /unknown kind/);
  }
});

test("a ruling (layer=ruling, flag #N:) and a supersession parse as the protocol describes", () => {
  assert.match(DECISION_CAPTURE_PROTOCOL, /layer="ruling"/);
  assert.match(DECISION_CAPTURE_PROTOCOL, /supersedes="/);
  const { decisions } = parseDecisionTags(
    '<assay-decision kind="decision" layer="ruling">flag #7: confirmed, keep the nightly job.</assay-decision>' +
      '<assay-decision kind="decision" supersedes="deadbeef">Run the job hourly instead.</assay-decision>',
  );
  assert.equal(decisions[0].layer, "ruling");
  assert.match(decisions[0].body, /^flag #7:/);
  assert.equal(decisions[1].supersedes_raw, "deadbeef");
});

test("legacy-kind decisions pass the table's CHECK constraint on deposit", () => {
  const store = new DecisionStore(join(sb.dir, "kinds.db"));
  try {
    const { decisions } = parseDecisionTags(
      Object.keys(LEGACY_KIND_ALIASES)
        .map((k) => `<assay-decision kind="${k}">Legacy ${k}.</assay-decision>`)
        .join("\n"),
    );
    const ids = store.depositBatch(decisions);
    assert.equal(ids.length, Object.keys(LEGACY_KIND_ALIASES).length);
    assert.ok(store.recent(10).every((r) => r.kind === "decision"));
  } finally {
    store.close();
  }
});

test("the __IMPORTANT tool description matches the protocol's stance", () => {
  assert.match(IMPORTANT_TOOL_DESCRIPTION, /ONLY for: a ruling on a librarian flag/);
  assert.match(DECISION_CAPTURE_PROTOCOL, /DEFAULT IS SILENCE/);
  assert.match(DECISION_CAPTURE_PROTOCOL, /REJECTS bodies over 2,000 characters/);
});
