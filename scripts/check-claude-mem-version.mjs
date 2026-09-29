#!/usr/bin/env node
// Postinstall: warn if claude-mem version drifts from the pinned target.
// Soft warning, not hard failure — keeps install path working under
// version drift while making the drift visible.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const PINNED = "13.2.0";

try {
  const pkg = require("claude-mem/package.json");
  if (pkg.version !== PINNED) {
    console.warn(
      `[assaylabs/decision-layer] WARNING: claude-mem version is ${pkg.version}, pinned target is ${PINNED}.`,
    );
    console.warn(
      `[assaylabs/decision-layer]   API contracts may differ. Run \`npm test\` to verify.`,
    );
  } else {
    console.log(`[assaylabs/decision-layer] claude-mem ${PINNED} (pinned) verified.`);
  }
} catch (err) {
  console.warn(
    "[assaylabs/decision-layer] WARNING: claude-mem not found as installed dependency.",
  );
  console.warn(
    "[assaylabs/decision-layer]   Install with: npx claude-mem install",
  );
}
