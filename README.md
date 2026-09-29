# Assay

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node 22.x](https://img.shields.io/badge/node-22.x-brightgreen.svg)](https://nodejs.org) [![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](#status)

**Assay is a local memory layer for Claude Code.** It remembers the decisions you make while building with an AI agent. It keeps them in SQLite on your machine and gives them back in later sessions, with citations.

Every agent session starts from zero. Yesterday's decisions sit in old transcripts, so the agent re-derives them or quietly contradicts them. Assay keeps a record of what you decided, when, and how sure you were, so the next session can start from there.

This repo holds both parts of the system:

| Part | What it does | Needs |
|---|---|---|
| **[Assay plugin](#the-assay-plugin)** (`plugin/`, `src/`) | Captures decisions inline, stores them locally, recalls them in later sessions | macOS on Apple Silicon, Node 22.x |
| **[Librarian](#the-librarian)** (`librarian/`), optional | A background scribe that files what you capture into topics, tracks what replaced what, and briefs each new session | macOS, Claude Code CLI, claude-mem |

## The Assay plugin

- **Capture.** A decision is one sentence inside an `<assay-decision>` tag, written by you or by the agent. At the end of every turn, a Stop hook reads the session transcript and stores each new tag in `~/.assay/decisions.db`. Nothing leaves your machine.
- **Recall.** In a later session, `/assay-decision` returns your recent decisions with their ids. `/assay-brief <topic>` returns up to five recent decisions that mention the topic, each cited by id.
- **Interface.** 3 MCP tools (`assay_decision_recall`, `assay_decision_expand`, `assay_brief_render`) and 3 slash commands (`/assay-decision`, `/assay-brief`, `/assay-decision-deposit`). A fourth tool, `__IMPORTANT`, only carries the capture instructions agents see at session start.
- **Optional context.** If [claude-mem](https://github.com/thedotmack/claude-mem) is running, recall attaches related session observations from it. Without it, everything else still works.

The plugin tells agents to stay silent by default. An agent tags a decision only when you ask it to save one, when a decision replaces an earlier one, or to record a Librarian ruling. You can write a tag yourself at any time, or run `/assay-decision-deposit`. The format:

```
<assay-decision kind="decision|conflict" confidence="0..1" layer="label" supersedes="id-prefix">One sentence.</assay-decision>
```

`kind` is `decision` or `conflict`. The other three attributes are optional. [USAGE.md](USAGE.md) has worked examples.

## The Librarian

Optional, macOS only. The plugin captures decisions. The Librarian keeps them in order.

It runs as a launchd job every 20 minutes and shortly after each turn ends. It reads new [claude-mem](https://github.com/thedotmack/claude-mem) observations and new plugin decisions. A deterministic prefilter files the obvious ones. A headless `claude -p` worker files the rest under topics ("authorities") in an append-only journal, `~/.assay/librarian.db`. When something looks superseded or contradictory, it raises a flag for you to rule on, and it records a supersession only when your ruling confirms one. At the start of each new session, a hook injects a glossary of what is still true.

- **Self-audited.** The Librarian checks its own coverage and filing accuracy. [POSTMORTEM.md](librarian/POSTMORTEM.md) covers a data-loss bug it caught in itself, the fix, and the regression tests. [PRECISION-AUDIT.md](librarian/PRECISION-AUDIT.md) covers how filing accuracy is measured.
- **Security.** The worker runs `claude -p --permission-mode bypassPermissions`, unattended, as your user, over text your sessions touched. Read the [security model](librarian/README.md#security-model) before installing. `install.sh` installs nothing until you type `bypassPermissions`.

## Status

Alpha, version `2.0.0-alpha.3`. Known limits:

- **Recall is by recency, not meaning.** `assay_decision_recall` returns your most recent decisions. The query does not select or rank them yet. Brief matches topic words as plain substrings. Semantic recall is on the [roadmap](ROADMAP.md).
- **Nothing comes back until you have 5 decisions.** Below that, recall and brief return a cold-start message.
- **`supersedes` is stored, not resolved.** The chain in a recall result holds only the decision itself for now. Today, supersession is tracked by the Librarian's flag and ruling loop.
- **The Stop hook reads the whole transcript,** including tool output. A complete tag inside a file an agent reads is captured too.
- **Platform.** The plugin ships a prebuilt SQLite driver (better-sqlite3) for macOS on Apple Silicon and Node 22.x. Claude Code runs the plugin with the `node` on your PATH. On Linux, Windows, Intel Macs, or any other Node version, the Stop hook and MCP server fail to load.
- **The Librarian is macOS only** (launchd, BSD `stat`, `shlock`) and runs an unattended agent with every permission. See its [security model](librarian/README.md#security-model) and [LIMITATIONS.md](librarian/LIMITATIONS.md).
- **Not on npm.** The package name `@assaylabs/assay` is not published. Install from the marketplace or from source.

## Install

### The plugin

In Claude Code:

```
/plugin marketplace add levievanshantz/assay
/plugin install assay@assaylabs
```

You need macOS on Apple Silicon and Node 22.x as the `node` on your PATH. claude-mem is optional. Without it, recall and brief still work and report `context_tier: "unavailable"`.

### The Librarian (optional, macOS)

You need claude-mem 13.x, run for at least one session, plus the other requirements in [librarian/SETUP.md](librarian/SETUP.md). The plugin can be installed before or after. Read the [security model](librarian/README.md#security-model), then:

```bash
git clone https://github.com/levievanshantz/assay
cd assay/librarian
./install.sh
```

`install.sh` shows what the scheduled worker will run and asks you to type `bypassPermissions`. Any other answer exits with nothing installed.

To watch the pipeline before installing anything, run `./demo.sh` inside `librarian/demo`. It uses synthetic data and a stand-in worker, so it makes no model calls.

### From source

For development, or to check the claims yourself. Needs Node 22.x.

```bash
git clone https://github.com/levievanshantz/assay
cd assay
npm ci
npm test          # builds, then runs 44 tests
npm run smoke     # 19 integration cases
npm run demo      # capture, recall and brief in a temp sandbox
```

These runs use a temporary HOME, so your real `~/.assay` is not touched.

The Librarian's suite needs macOS and Python 3.9 or newer:

```bash
cd librarian
python3 -m unittest discover tests -v    # 22 tests
```

Two of the 20 run the real plugin Stop hook and skip unless Node 22 on Apple Silicon is available. [CONTRIBUTING.md](CONTRIBUTING.md) lists every check.

## How it works

```
  Claude Code session                           A later session
  -------------------                           ---------------
  a tag is written                              /assay-decision, /assay-brief
        |                                               |
        |  Stop hook, end of every turn                 |  MCP server (stdio)
        v                                               v
  +-----------------------------------------------------------+
  |  ~/.assay/decisions.db     SQLite, on your machine        |
  |  decisions, decision_transitions, decision_evidence       |
  +-----------------------------------------------------------+
        |
        |  optional, macOS
        v
  Librarian sweep (launchd, every 20 min and after each turn)
    reads decisions.db and claude-mem
    files into ~/.assay/librarian.db, raises flags for you to rule on
        |
        v
  SessionStart hook injects a glossary of what is still true
```

1. **Capture.** The Stop hook reads the transcript file as raw text. It decodes each complete tag and rejects bad ones (unknown kind, empty body, over 2,000 characters). It skips anything already stored and inserts the rest with status `tentative`. It never blocks the session. Fatal errors go to `~/.assay/errors.jsonl`.
2. **Recall.** The MCP server reads the same database. Recall and brief are plain SQL over it, with optional claude-mem context.
3. **File.** The Librarian treats the decisions database as one of its two inputs. After each run, a coverage audit checks that every item got a disposition. If any did not, the run rolls back and retries.

Design detail lives in [ARCHITECTURE.md](ARCHITECTURE.md) and [librarian/ARCHITECTURE.md](librarian/ARCHITECTURE.md).

## Repo layout

| Path | What it is |
|---|---|
| `plugin/` | The Claude Code plugin as installed: manifest, hooks, skills, built bundles, vendored better-sqlite3 |
| `plugin-src/` | Entry points bundled into `plugin/scripts/` |
| `src/` | TypeScript source: tag parser, SQLite store, Stop hook, MCP server, claude-mem client |
| `tests/` | node:test suite |
| `scripts/` | Plugin build, smoke pack, end-to-end demo |
| `evals/` | Capability eval gate for the claims in CAPABILITIES.md |
| `bin/assay.mjs` | Developer CLI, for example `node bin/assay.mjs check-consistency` |
| `docs/` | Guides: onboarding and tagging |
| `librarian/` | The Librarian: installer, sweep, worker prompt, tests, demo, and its own docs |
| `.claude-plugin/marketplace.json` | The `assaylabs` marketplace that lists the plugin |

## Docs

| Doc | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the plugin is built and why |
| [CAPABILITIES.md](CAPABILITIES.md) | The plugin's contract: each claim, its pass line, and the eval that checks it |
| [USAGE.md](USAGE.md) | Tag attributes, commands, output fields, troubleshooting |
| [ROADMAP.md](ROADMAP.md) | What comes next |
| [PROOF.md](PROOF.md) | The evidence record for 2.0.0-alpha.2 (May 2026) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, both test suites, PR checklist |
| [librarian/README.md](librarian/README.md) | The Librarian: what it is, requirements, security model |
| [librarian/SETUP.md](librarian/SETUP.md) | Install, verify, uninstall, troubleshooting |
| [librarian/OPERATING.md](librarian/OPERATING.md) | The daily loop: glossary, flags, rulings |
| [librarian/ARCHITECTURE.md](librarian/ARCHITECTURE.md) | The Librarian's design, from zero to deep |
| [librarian/DECISIONS.md](librarian/DECISIONS.md) | Its design calls and their reasons |
| [librarian/POSTMORTEM.md](librarian/POSTMORTEM.md) | The July 2026 data-loss bug and the fix |
| [librarian/PRECISION-AUDIT.md](librarian/PRECISION-AUDIT.md) | How filing accuracy is measured |
| [librarian/LIMITATIONS.md](librarian/LIMITATIONS.md) | Every known weakness, stated plainly |

## History

- **v1 (March 2026).** An MCP server for team knowledge retrieval. Archived at [github.com/levievanshantz/assay-v1](https://github.com/levievanshantz/assay-v1).
- **v2 (May 2026).** Rebuilt as a Claude Code plugin focused on decisions. Published as `assay-decisions` at 2.0.0-alpha.2.
- **Librarian (July 2026).** Built in a private working repo. It was imported here as one snapshot, so its history in this repo starts at the import.
- **One repo (September 2026).** Both parts now live here. 2.0.0-alpha.3 moves fixes that had been applied by hand to an installed copy back into source, with tests.

## License

MIT. See [LICENSE](LICENSE).

## Credits

- [claude-mem](https://github.com/thedotmack/claude-mem): the session memory the Librarian files from, and the optional context source for recall.
- [QMD](https://github.com/tobi/qmd): inspiration for local-first hybrid retrieval.
- OpenAI Codex served as an adversarial reviewer during the build. See [PROOF.md](PROOF.md).
