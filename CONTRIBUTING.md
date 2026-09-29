# Contributing to Assay

Thanks for the interest. Assay is alpha software. The bar for a change is simple: it is proven against the contract, with the output to show for it.

## Two components, one repo

| Component | Where | Language | Test suite |
|---|---|---|---|
| Assay plugin | `src/`, `plugin-src/`, `plugin/`, `scripts/`, `tests/`, `evals/` | TypeScript on Node 22.x | `npm test`, smoke, demo, evals |
| Librarian | `librarian/` | Bash, Python 3.9+ standard library, SQLite | `python3 -m unittest` in `librarian/` |

They share one file: `~/.assay/decisions.db`. The plugin owns its schema. `librarian/bin/decisions-schema.sql` is a verbatim copy of that schema, and two Librarian tests fail if the copy drifts from `src/decisions/schema.ts` or from the shipped bundle. If you change the plugin schema, update that file in the same PR and give existing databases a migration path.

## The contract

Every claim the plugin makes lives in [`CAPABILITIES.md`](CAPABILITIES.md). Each capability has a claim, a pass line, an eval that checks it, and adversarial vectors. If your change weakens a capability, or adds behavior no eval covers, the PR does not land.

The Librarian's claims live in its own docs: [`librarian/LIMITATIONS.md`](librarian/LIMITATIONS.md), [`librarian/POSTMORTEM.md`](librarian/POSTMORTEM.md) and [`librarian/PRECISION-AUDIT.md`](librarian/PRECISION-AUDIT.md). Its regression tests pin each fix described there.

## Setup

```bash
git clone https://github.com/levievanshantz/assay
cd assay
npm ci
```

You need:

- **Node 22.x.** `package.json` pins `>=22.0.0 <23.0.0`, because the vendored better-sqlite3 in `plugin/node_modules` is built for Node ABI 127 on macOS arm64.
- **macOS on Apple Silicon** to run the shipped plugin bundle. The TypeScript build, tests, smoke pack and evals are configured in CI for both macOS and Linux. The tests that execute the shipped bundle skip, with a stated reason, on any other platform.
- **For the Librarian:** macOS, Python 3.9 or newer, the `sqlite3` CLI, and bash. No pip packages.
- **claude-mem is optional** for all of the above. The smoke pack and demo run with it offline.

## Run the checks

### Plugin (from the repo root)

| Command | What it checks | Passing output today |
|---|---|---|
| `npm test` | Builds, then runs the node:test suite: parser, kind vocabulary, store, Stop hook bundle, MCP over stdio, bundle drift | `# tests 44`, `# pass 44`, `# fail 0` |
| `npm run test:bundle` | Only the committed `plugin/` bundle, as a marketplace install gets it. Needs no `npm install` | `# tests 12`, `# pass 12` |
| `npm run smoke` | Integration smoke pack | `=== Results: 19 passed, 0 failed ===` |
| `npm run demo` | Capture, recall and brief end to end, in a temp sandbox | Ends with `DEMO COMPLETE` |
| `node scripts/build-plugin.mjs --check` | `plugin/scripts/*.cjs` match a fresh build of source | `Plugin bundles match source.` |
| `node bin/assay.mjs check-consistency` | Tool and capability counts agree across code and docs | `Consistency checks passed.` |
| `npm run eval:verify` | Capability evals, verify mode | `Results: 16 passed, 0 failed, 0 skipped` |
| `npm run eval:adversarial` | Capability evals, adversarial mode | `Results: 16 passed, 0 failed, 0 skipped` |

`npm test`, the smoke pack and the demo set a temporary HOME themselves, so they do not touch your real `~/.assay`. Run the evals with a throwaway HOME (for example `HOME=$(mktemp -d) npm run eval:verify`), because some of them open the default `~/.assay/decisions.db` path.

If you change `src/` or `plugin-src/`, rebuild the shipped bundle and commit it:

```bash
npm run build:plugin
```

### Librarian (from `librarian/`)

```bash
cd librarian
python3 -m unittest discover tests -v
```

Passing output today is `Ran 22 tests` and `OK`: 8 coverage-gate tests, 7 install-order tests, and 7 install-consent, re-install and permission tests. Two install-order tests run the real plugin Stop hook and skip unless Node 22 on Apple Silicon can load `plugin/node_modules/better-sqlite3`. The tests use a synthetic HOME and fake `claude` and `launchctl` binaries. They never run a real worker or load a real launchd job.

Also run the two demos, which exercise the real sweep on synthetic data with a stand-in worker:

```bash
cd librarian/demo
./demo.sh        # ends: coverage audit missing=0
./break-it.sh    # three rollbacks, then HUMAN REVIEW NEEDED
```

The Librarian tests are not wired into the root CI workflow yet. GitHub Actions only reads `.github/workflows/` at the repo root. Run them locally and paste the output in your PR.

## PR checklist

Plugin changes:

- [ ] `npm test` passes (34 of 34)
- [ ] `npm run smoke` passes (19 of 19)
- [ ] `npm run eval:verify` and `npm run eval:adversarial` show no new failures
- [ ] `node scripts/build-plugin.mjs --check` passes (rebuild with `npm run build:plugin` and commit the bundle)
- [ ] If you added a capability: CAPABILITIES.md has its claim, pass line and adversarial vectors, and `evals/capabilities/` has its eval
- [ ] If you changed a capability: the existing eval still passes, or you updated the eval and the CAPABILITIES.md pass line together
- [ ] If you touched the Stop hook or MCP server: you ran `npm run demo` and pasted the output in the PR
- [ ] If you touched the schema: existing databases still open, and `librarian/bin/decisions-schema.sql` matches

Librarian changes:

- [ ] `python3 -m unittest discover tests -v` passes in `librarian/`
- [ ] `./demo.sh` and `./break-it.sh` still end as described above
- [ ] If you changed what the scheduled worker can do: README.md "Security model" and LIMITATIONS.md say so

## What to work on

See [`ROADMAP.md`](ROADMAP.md) for the plugin and [`librarian/LIMITATIONS.md`](librarian/LIMITATIONS.md) for the Librarian.

Especially welcome:

- New adversarial probes for existing capabilities
- Bug reports with a reproduction through the eval harness or the Librarian tests
- Documentation that closes gaps testers actually hit

Not currently welcome:

- New features not on the roadmap (open an issue first)
- Refactors that do not address a capability gap

## Cross-model eval (optional)

For larger changes, run the eval gate from a second model's point of view and compare. Agreement between two models is a stronger signal than one model checking itself. [`PROOF.md`](PROOF.md) shows how this was done for 2.0.0-alpha.2.

## Code style

- TypeScript strict mode, no `any` except at the IO boundary
- Explicit over clever
- Comments explain why, not what
- No comments that narrate recent changes; that belongs in the PR description

## Licensing

By contributing you agree your contributions are licensed under MIT.

## Code of Conduct

See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
