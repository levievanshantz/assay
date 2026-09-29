# Roadmap

Assay is alpha and maintained on a best effort basis. These are the known next steps, roughly in order. Open an issue if one of them matters to you.

## Plugin

- **Topic-aware recall.** Recall returns your most recent decisions today. Next is ranking by the query, first with keyword matching, then with local embeddings.
- **Resolve `supersedes`.** Link a decision to the one it replaces, so recall shows the full chain.
- **More platforms.** Ship SQLite drivers for Intel Macs, Linux, and Node versions beyond 22, or move to Node's built in SQLite.
- **Capture only what the agent writes.** Ignore tags that appear inside tool output and files the agent reads.
- **Better briefs.** Replace the stitched citation summary with a synthesized answer that still cites each decision.

## Librarian

- **Safer default permissions.** Replace the unattended bypassPermissions run with an explicit tool allowlist.
- **Linux support.** Replace launchd, BSD `stat`, and `shlock`.
- **Backfill.** File decisions that were captured before the Librarian was installed.

The full list of current Librarian limits is in [librarian/LIMITATIONS.md](librarian/LIMITATIONS.md).
