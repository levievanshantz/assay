#!/usr/bin/env bash
# inject-glossary.sh — SessionStart hook target.
# Emits the compiled glossary to stdout so it is injected into session context.
# Contract: MUST finish in <100ms and exit 0 in EVERY case (missing/unreadable/oversized).
# A hook must never propagate failure, so the whole body is guarded and we exit 0.

GLOSSARY="$HOME/.assay/glossary.md"
MAX=9000

{
  # Only emit when the file exists, is a regular non-empty file, and is under 9000 chars.
  if [ -f "$GLOSSARY" ] && [ -r "$GLOSSARY" ] && [ -s "$GLOSSARY" ]; then
    bytes=$(wc -c <"$GLOSSARY" 2>/dev/null || echo 999999)
    # Strip whitespace from wc output.
    bytes=${bytes//[[:space:]]/}
    if [ -n "$bytes" ] && [ "$bytes" -lt "$MAX" ] 2>/dev/null; then
      cat "$GLOSSARY" 2>/dev/null || true
    fi
  fi
} || true

exit 0
