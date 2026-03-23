# /retrieve — Raw evidence retrieval from the Assay corpus

Retrieve evidence sections from the corpus. No evaluation, no judgment — just the evidence.

## Arguments
$ARGUMENTS — The query to search for

## Behavior

1. Call `retrieve_evidence` with the user's query as query_text, mode="raw", full_content=true, top_k=60
2. Display results as a numbered list with:
   - RRF score
   - Title
   - Notion URL (or "(no source link)" if missing)
   - First 200 chars of content as preview
   - Found via: evidence / claims / both
3. At the bottom show:
   - Total results returned
   - Total available in corpus
   - Records below threshold (dropped off)
4. Ask: "Want me to retrieve more, or apply the stress test prompt to these results?"
