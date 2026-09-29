// plugin/scripts/*.cjs are generated from src/ + plugin-src/. This fails when
// the committed bundles are stale, i.e. someone edited source without running
// `npm run build:plugin`, or hand-edited a bundle (how the Jul 2026 hotfixes
// ended up in an installed plugin and nowhere in source).
// Needs esbuild from devDependencies and an up-to-date dist/ (npm test builds it).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { REPO_ROOT } from "./helpers/plugin.mjs";

test("committed plugin bundles match a fresh build of source", () => {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "build-plugin.mjs"), "--check"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  assert.equal(r.status, 0, `bundles are stale:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /Plugin bundles match source\./);
});
