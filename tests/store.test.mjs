// DecisionStore: cross-run dedupe and opening a drain table another tool made.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createRequire } from "node:module";

import { sandboxThisProcess } from "./helpers/sandbox.mjs";

const sb = sandboxThisProcess("assay-store");
const { DecisionStore, parseDecisionTags } = await import("../dist/index.js");
const Database = createRequire(import.meta.url)("better-sqlite3");

// The drain DDL librarian/bin/init-journal.py used before the plugin existed on
// a machine: fewer columns than the plugin writes.
const NARROW_DRAIN_DDL = `
CREATE TABLE IF NOT EXISTS decisions(
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'conflict')),
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'tentative',
    confidence REAL,
    layer TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);`;

function parse(text) {
  return parseDecisionTags(text).decisions;
}

test("depositing the same decisions again stores nothing new", () => {
  const store = new DecisionStore(join(sb.dir, "dedupe.db"));
  try {
    const batch = parse(
      '<assay-decision kind="decision">A.</assay-decision><assay-decision kind="conflict">A.</assay-decision>',
    );
    assert.equal(store.depositBatch(batch).length, 2);
    assert.equal(store.depositBatch(batch).length, 0);
    assert.equal(store.depositBatch(batch).length, 0);
    assert.equal(store.count(), 2);
  } finally {
    store.close();
  }
});

test("a stored body with surrounding whitespace (older builds) dedupes against the trimmed body", () => {
  const path = join(sb.dir, "legacy-ws.db");
  const store = new DecisionStore(path);
  store.close();
  const db = new Database(path);
  db.prepare(
    `INSERT INTO decisions (id, kind, body, status, created_at, updated_at)
     VALUES ('old-1', 'decision', ?, 'tentative', 1, 1)`,
  ).run("\nKeep the worker stateless.\n");
  db.close();

  const again = new DecisionStore(path);
  try {
    const ids = again.depositBatch(parse('<assay-decision kind="decision">Keep the worker stateless.</assay-decision>'));
    assert.equal(ids.length, 0);
    assert.equal(again.count(), 1);
  } finally {
    again.close();
  }
});

test("rows stored by the Jul 2026 hotfix build dedupe against the same tags after an upgrade", () => {
  // The hotfix build decoded bodies with sequential replaces and left \t, \r and
  // an escaped backslash before n undecoded. A session that continues after the
  // upgrade re-reads those tags; they must not be stored a second time.
  const line = (body) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `<assay-decision kind="decision">${body}</assay-decision>` }] } });
  const bodies = ["Split on the literal \\n token.", "Col A\tCol B are tab separated.", "Line one\r\nLine two."];
  const hotfixStored = ["Split on the literal \\\n token.", "Col A\\tCol B are tab separated.", "Line one\\r\nLine two."];

  const path = join(sb.dir, "hotfix-upgrade.db");
  new DecisionStore(path).close();
  const db = new Database(path);
  const ins = db.prepare(
    `INSERT INTO decisions (id, kind, body, status, created_at, updated_at) VALUES (?, 'decision', ?, 'tentative', 1, 1)`,
  );
  hotfixStored.forEach((b, i) => ins.run(`hot-${i}`, b));
  db.close();

  const store = new DecisionStore(path);
  try {
    const parsed = parse(bodies.map(line).join("\n"));
    assert.deepEqual(parsed.map((d) => d.body), bodies);
    assert.deepEqual(parsed.map((d) => d.legacy_body), hotfixStored);
    assert.deepEqual(store.depositBatch(parsed), [], "nothing stored twice");
    assert.equal(store.count(), 3);
    // A genuinely new decision still lands.
    assert.equal(store.depositBatch(parse(line("A new call."))).length, 1);
  } finally {
    store.close();
  }
});

test("a drain table created first with the Librarian's narrow DDL is upgraded in place", () => {
  const path = join(sb.dir, "narrow.db");
  const db = new Database(path);
  db.exec(NARROW_DRAIN_DDL);
  db.prepare(
    `INSERT INTO decisions (id, kind, body, status, layer, created_at, updated_at)
     VALUES ('lib-1', 'decision', 'flag #1: confirmed.', 'tentative', 'ruling', 5, 5)`,
  ).run();
  db.close();

  const store = new DecisionStore(path); // threw "no such column: supersedes_resolved_id" before
  try {
    const ids = store.depositBatch(
      parse('<assay-decision kind="decision" supersedes="abcd1234" confidence="0.5">After the librarian.</assay-decision>'),
    );
    assert.equal(ids.length, 1);
    const row = store.get(ids[0]);
    assert.equal(row.supersedes_raw, "abcd1234");
    assert.equal(row.confidence, 0.5);
    assert.equal(store.get("lib-1").layer, "ruling", "existing rows are untouched");
    assert.equal(store.count(), 2);
  } finally {
    store.close();
  }
});

test("a table named decisions that is not a drain is refused with a clear error", () => {
  const path = join(sb.dir, "foreign.db");
  const db = new Database(path);
  db.exec("CREATE TABLE decisions (name TEXT)");
  db.close();
  assert.throws(() => new DecisionStore(path), /lacks required column\(s\) id, kind, body/);
});
