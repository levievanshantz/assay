// Tag parsing from raw Claude Code JSONL transcripts (the compiled dist/ code).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sandboxThisProcess } from "./helpers/sandbox.mjs";
import { sessionTurns } from "./fixtures/session.mjs";

sandboxThisProcess("assay-parser");
const { parseDecisionTags, MAX_BODY_CHARS, DECISION_CAPTURE_PROTOCOL } = await import("../dist/index.js");
const REPO_ROOT = join(import.meta.dirname, "..");

/** One tool_result JSONL line carrying `text`, as Claude Code writes it. */
function jsonlToolResult(text) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: [{ type: "text", text }] }] },
  });
}

/** One assistant JSONL line carrying `text`, as Claude Code writes it. */
function jsonlAssistant(text) {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

test("attributes parse from a JSONL transcript, where quotes arrive as \\\"", () => {
  const line = jsonlAssistant(
    '<assay-decision kind="conflict" supersedes="abcd1234" layer="ruling" confidence="0.9">flag #3: the two retention rules contradict.</assay-decision>',
  );
  assert.ok(line.includes('kind=\\"conflict\\"'), "fixture must carry JSON-escaped quotes");
  const { decisions, errors } = parseDecisionTags(line);
  assert.deepEqual(errors, []);
  assert.equal(decisions.length, 1);
  const d = decisions[0];
  assert.equal(d.kind, "conflict");
  assert.equal(d.supersedes_raw, "abcd1234");
  assert.equal(d.layer, "ruling");
  assert.equal(d.confidence, 0.9);
  assert.equal(d.body, "flag #3: the two retention rules contradict.");
});

test("plain-text tags (unescaped quotes) still parse", () => {
  const { decisions } = parseDecisionTags(
    'x <assay-decision kind="decision" confidence="0.8" layer="storage">Use SQLite for local storage.</assay-decision> y',
  );
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].confidence, 0.8);
  assert.equal(decisions[0].layer, "storage");
});

test("JSON escapes in bodies are decoded once: quotes, backslashes, tabs, literal \\n", () => {
  const body = 'Name it "Team"; paths use C:\\new\\dir; split on the literal \\n token;\ttab.';
  const { decisions } = parseDecisionTags(
    jsonlAssistant(`<assay-decision kind="decision">${body}</assay-decision>`),
  );
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].body, body);
});

test("a multi-line tag in JSONL is trimmed after unescaping (no stray newlines)", () => {
  const { decisions } = parseDecisionTags(
    jsonlAssistant('<assay-decision kind="decision">\n  Keep the worker stateless.\n</assay-decision>'),
  );
  assert.equal(decisions[0].body, "Keep the worker stateless.");
});

test("a body that names the tag (a literal <assay-decision opener) is rejected, not split", () => {
  const tag = '<assay-decision kind="decision">Rename the <assay-decision> tag to <decision> in v3.</assay-decision>';
  for (const [label, text] of [["plain", tag], ["jsonl", jsonlAssistant(tag)]]) {
    const { decisions, errors } = parseDecisionTags(text);
    assert.deepEqual(decisions, [], `${label}: nothing stored`);
    assert.equal(errors.length, 1, label);
    assert.match(errors[0].message, /tag syntax/, label);
  }
});

test("mentioning the tag and then writing one in the same record is rejected, as before", () => {
  const { decisions, errors } = parseDecisionTags(
    jsonlAssistant('I will use an <assay-decision> tag: <assay-decision kind="decision">Ship it.</assay-decision>'),
  );
  assert.equal(decisions.length, 0);
  assert.match(errors[0].message, /tag syntax/);
});

test("the full capture protocol stores nothing, as plain text or as the __IMPORTANT tool_result", () => {
  for (const [label, text] of [
    ["plain", DECISION_CAPTURE_PROTOCOL],
    ["jsonl", jsonlToolResult(DECISION_CAPTURE_PROTOCOL)],
  ]) {
    const { decisions, errors } = parseDecisionTags(text);
    assert.deepEqual(decisions, [], `${label}: the protocol's own example must not be captured`);
    assert.deepEqual(errors, [], label);
  }
  assert.ok(!DECISION_CAPTURE_PROTOCOL.includes("</assay-decision>"), "the protocol holds no closer");
});

test("the deposit skill's text stores nothing when it loads into the transcript", () => {
  const skill = readFileSync(join(REPO_ROOT, "plugin", "skills", "assay-decision-deposit", "SKILL.md"), "utf8");
  for (const text of [skill, jsonlAssistant(skill)]) {
    assert.deepEqual(parseDecisionTags(text).decisions, []);
  }
});

test("a real tag in the record after the capture protocol still parses", () => {
  const { decisions, errors } = parseDecisionTags(
    jsonlToolResult(DECISION_CAPTURE_PROTOCOL) + "\n" +
      jsonlAssistant('<assay-decision kind="decision">Keep the tag name as is.</assay-decision>'),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(decisions.map((d) => d.body), ["Keep the tag name as is."]);
});

test("a body containing tag syntax is rejected as a parse artifact", () => {
  // Second tag: the file holds the six characters < (a writer that escapes
  // "<"), which decodes to a nested opener.
  const { decisions, errors } = parseDecisionTags(
    '<assay-decision kind="decision">see \u2039assay-decision kind=x\u203a in the docs</assay-decision>\n' +
      '<assay-decision kind="decision">escaped \\u003cassay-decision inside</assay-decision>',
  );
  assert.equal(decisions.length, 0);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((e) => /tag syntax/.test(e.message)));
});

test(`bodies over ${MAX_BODY_CHARS} chars are rejected; exactly ${MAX_BODY_CHARS} is kept`, () => {
  const ok = "a".repeat(MAX_BODY_CHARS);
  const big = "b".repeat(MAX_BODY_CHARS + 1);
  const { decisions, errors } = parseDecisionTags(
    `<assay-decision kind="decision">${ok}</assay-decision><assay-decision kind="decision">${big}</assay-decision>`,
  );
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].body.length, MAX_BODY_CHARS);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /oversized body/);
});

test("an unpaired opener earlier in the transcript does not swallow the next real tag", () => {
  const transcript = [
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: '12:<assay-decision kind="decision" confidence="0.8">' }] } }),
    jsonlAssistant('<assay-decision kind="conflict">The TTL contradicts the freshness target.</assay-decision>'),
  ].join("\n");
  const { decisions } = parseDecisionTags(transcript);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, "conflict");
  assert.equal(decisions[0].body, "The TTL contradicts the freshness target.");
});

test("an unpaired opener on the same record as a later tag blocks it (the span is tag syntax)", () => {
  // Both openers are in one JSONL record, so the span really does contain tag
  // syntax. The same text split across two records parses (test above).
  const { decisions, errors } = parseDecisionTags(
    jsonlAssistant('see 12:<assay-decision kind="decision" confidence="0.8"> then <assay-decision kind="conflict">X.</assay-decision>'),
  );
  assert.equal(decisions.length, 0);
  assert.match(errors[0].message, /tag syntax/);
});

test("legacy_body is the Jul 2026 hotfix build's decoding of the same raw span", () => {
  const cases = [
    ["Split on the literal \\n token.", "Split on the literal \\\n token."],
    ["Col A\tCol B are tab separated.", "Col A\\tCol B are tab separated."],
    ["Line one\r\nLine two.", "Line one\\r\nLine two."],
  ];
  for (const [body, hotfixForm] of cases) {
    const [d] = parseDecisionTags(jsonlAssistant(`<assay-decision kind="decision">${body}</assay-decision>`)).decisions;
    assert.equal(d.body, body);
    assert.equal(d.legacy_body, hotfixForm);
  }
  const [plain] = parseDecisionTags(jsonlAssistant('<assay-decision kind="decision">Name it "Team".</assay-decision>')).decisions;
  assert.equal(plain.legacy_body, undefined, "no legacy_body when both builds decode the same");
});

test("thousands of unclosed openers after the last tag parse in linear time", () => {
  // Every mention of the tag in later records (docs, the protocol, grep output)
  // is an opener with no closer. A scan that runs from each one to the end of
  // the file is quadratic; this input took ~0.4 s that way at half this size.
  const filler = "x".repeat(2000) + "\n";
  const parts = [jsonlAssistant('<assay-decision kind="decision">Early call.</assay-decision>') + "\n"];
  for (let i = 0; i < 6000; i++) parts.push(jsonlAssistant("the <assay-decision> tag") + "\n" + filler);
  const text = parts.join("");
  const t0 = process.hrtime.bigint();
  const { decisions } = parseDecisionTags(text);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.deepEqual(decisions.map((d) => d.body), ["Early call."]);
  assert.ok(ms < 400, `parse of ${(text.length / 1e6).toFixed(1)} MB took ${ms.toFixed(0)} ms`);
});

test("an opener that never closes before a 2,000+ char span is skipped, not stored", () => {
  const { decisions, errors } = parseDecisionTags(
    jsonlAssistant('<assay-decision kind="decision">' + "log line\n".repeat(400) + "</assay-decision>"),
  );
  assert.equal(decisions.length, 0);
  assert.match(errors[0].message, /oversized body/);
});

test("the same kind+body twice in one transcript yields one decision", () => {
  const tag = '<assay-decision kind="decision">Same call.</assay-decision>';
  const { decisions } = parseDecisionTags(jsonlAssistant(tag) + "\n" + jsonlAssistant(` ${tag} `));
  assert.equal(decisions.length, 1);
});

test("the full synthetic session parses to the expected decisions", () => {
  const all = sessionTurns(DECISION_CAPTURE_PROTOCOL).join("");
  const { decisions, errors } = parseDecisionTags(all);
  const bodies = decisions.map((d) => d.body);
  assert.ok(bodies.includes("Store exporter state in SQLite, not flat files."));
  assert.ok(!bodies.some((b) => /One-sentence summary/.test(b)), "the protocol example is not captured");
  assert.ok(bodies.includes("The 24-hour cache TTL contradicts the one-hour freshness target."));
  assert.ok(bodies.includes("Recall must stay under 50 ms at p95."));
  assert.ok(!bodies.includes("Not a real kind."));
  assert.ok(errors.some((e) => /unknown kind="banana"/.test(e.message)));
  assert.ok(errors.some((e) => /oversized body/.test(e.message)));
});
