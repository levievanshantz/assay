# /sync-status — Check Assay corpus health

Show the current state of the Notion sync pipeline and corpus health.

## Behavior

1. Call `sync_status` to get current health data
2. Display:
   - **Last sync:** timestamp + hours ago
   - **Status:** healthy / stale / in-progress / error
   - **Corpus size:** evidence records + claims counts
   - **Dirty pages:** pages with pending changes
   - **Failed pages:** pages that errored on last sync
   - **Poll interval:** current adaptive interval

3. Query the local sync log for the last 7 days:
   ```
   ls -la scripts/output/nightly-sync-*.log
   ```
   Summarize each day's log in one line:
   - Date | Pages checked | New chunks | Claims extracted | Errors

4. If corpus is stale (hours since sync > threshold), ask:
   "Corpus is stale — last synced X hours ago. Want me to sync now?"
   If yes, trigger sync and report results.
