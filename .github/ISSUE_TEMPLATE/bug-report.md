---
name: Bug report
about: A specific thing Assay does that violates a CAPABILITIES.md claim, or breaks installation/runtime
title: "[BUG] "
labels: bug
---

## Which capability is affected?

CAPABILITIES.md ID (e.g., C3, C8): ___

(Or "install / runtime" if the issue is outside the capability surface.)

## What the contract claims

Paste the relevant line from CAPABILITIES.md verbatim.

## What actually happened

Concrete observation. Include the command you ran, the input, the actual output, and what you expected.

## Reproduction

Smallest sequence of steps that reproduces. Ideally a snippet that can be dropped into `evals/capabilities/` as a new probe.

```bash
# example
cd /your/clone/of/assay
ASSAY_DB_PATH=/tmp/probe.db node -e "..."
```

## Environment

- OS: (macOS / Linux + version)
- Node version: `node --version`
- claude-mem version: `npx claude-mem --version` if installed
- Assay version: from package.json (or `plugin/.claude-plugin/plugin.json` for a marketplace install)
- Last lines of `~/.assay/errors.jsonl`, if it exists:
  ```
  (paste here)
  ```

## Eval gate state

- [ ] `npm run smoke` passes before this bug occurs (and fails when it does)
- [ ] `npm run eval` passes before this bug occurs (and fails when it does)

If both still pass when the bug occurs, this is a **contract gap** — the bug isn't covered by an eval. Note that explicitly so we can extend coverage.
