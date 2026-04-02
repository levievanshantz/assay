/**
 * Client-side grouping utility for evidence records.
 * Groups evidence by source_ref so imported works show as single cards.
 */

export interface GroupedWork {
  source_ref: string;
  author: string;
  work_title: string;
  total_parts: number;
  parts: Array<{
    id: string;
    title: string;
    summary: string;
    recorded_at: string;
    type: string;
    source_ref: string | null;
    state: string;
    product_id: string;
    project_id: string | null;
  }>;
  first_summary: string;
  recorded_at: string; // earliest
}

export interface EvidenceDisplay {
  groups: GroupedWork[];
  ungrouped: Array<{
    id: string;
    title: string;
    summary: string;
    recorded_at: string;
    type: string;
    source_ref: string | null;
    state: string;
    product_id: string;
    project_id: string | null;
  }>;
}

/**
 * Parse the "Author - Work Title (Part N of M)" title pattern (Gutenberg style).
 */
export function parseEvidenceTitle(title: string) {
  const match = title.match(/^(.+?)\s*-\s*(.+?)\s*\((?:Part|Section)\s+(\d+)\s+of\s+(\d+)\)$/);
  if (!match) return null;
  return {
    author: match[1].trim(),
    workTitle: match[2].trim(),
    partNum: parseInt(match[3]),
    totalParts: parseInt(match[4]),
  };
}

/**
 * Extract the Notion page ID from a source_ref like "notion:https://www.notion.so/PAGEID"
 * or bare "https://www.notion.so/PAGEID"
 */
function getNotionPageId(sourceRef: string): string | null {
  const match = sourceRef.match(/(?:notion:)?https:\/\/www\.notion\.so\/([a-f0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Parse "PageTitle -- SectionTitle" format used by Notion evidence.
 */
function parseNotionTitle(title: string): { pageTitle: string; sectionTitle: string } | null {
  const idx = title.indexOf(" \u2014 ");
  if (idx === -1) return null;
  return {
    pageTitle: title.substring(0, idx).trim(),
    sectionTitle: title.substring(idx + 3).trim(),
  };
}

/**
 * Get the grouping key for a record.
 * - Gutenberg records: exact source_ref (they share it)
 * - Notion records: notion page ID (multiple sections per page)
 * - Others: exact source_ref
 */
function getGroupKey(record: any): string {
  const ref = record.source_ref || "";
  if (ref.startsWith("notion:") || ref.startsWith("https://www.notion.so/")) {
    const pageId = getNotionPageId(ref);
    return pageId ? `notion-page:${pageId}` : ref;
  }
  return ref;
}

/**
 * Group evidence records by source_ref.
 * Records sharing the same source_ref become a single GroupedWork.
 * Notion records are grouped by page ID (multiple sections per page).
 * Records without source_ref stay as ungrouped individual items.
 */
export function groupEvidenceBySource(records: any[]): EvidenceDisplay {
  const groupMap = new Map<string, any[]>();
  const ungrouped: any[] = [];

  for (const record of records) {
    if (record.source_ref) {
      const key = getGroupKey(record);
      const existing = groupMap.get(key);
      if (existing) {
        existing.push(record);
      } else {
        groupMap.set(key, [record]);
      }
    } else {
      ungrouped.push(record);
    }
  }

  const groups: GroupedWork[] = [];

  for (const [groupKey, parts] of Array.from(groupMap.entries())) {
    // Only group if there are multiple parts
    if (parts.length === 1 && !groupKey.startsWith('notion-page:')) {
      ungrouped.push(parts[0]);
      continue;
    }

    const sorted = parts.sort((a: any, b: any) => {
      // Try to sort by part number from title (Gutenberg)
      const aP = parseEvidenceTitle(a.title);
      const bP = parseEvidenceTitle(b.title);
      if (aP && bP) return aP.partNum - bP.partNum;
      return new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime();
    });

    // Determine author/title based on source type
    const isNotion = groupKey.startsWith("notion-page:");
    const parsed = parseEvidenceTitle(sorted[0].title);
    const notionParsed = isNotion ? parseNotionTitle(sorted[0].title) : null;

    let author: string;
    let workTitle: string;

    if (notionParsed) {
      author = "Notion";
      workTitle = notionParsed.pageTitle;
    } else if (parsed) {
      author = parsed.author;
      workTitle = parsed.workTitle;
    } else {
      author = isNotion ? "Notion" : "Unknown";
      workTitle = sorted[0].source_ref || groupKey;
    }

    groups.push({
      source_ref: sorted[0].source_ref || groupKey,
      author,
      work_title: workTitle,
      total_parts: sorted.length,
      parts: sorted,
      first_summary: sorted[0].summary?.substring(0, 300) || "",
      recorded_at: sorted[0].recorded_at,
    });
  }

  groups.sort((a, b) => a.author.localeCompare(b.author));

  return { groups, ungrouped };
}

// --- Source-Level Grouping ------------------------------------------------

export interface SourceGroup {
  source_type: "notion" | "test" | "manual" | "other";
  label: string;
  evidence_count: number;
  claims_count: number;
  page_groups: GroupedWork[];
  ungrouped: Array<{
    id: string;
    title: string;
    summary: string;
    recorded_at: string;
    type: string;
    source_ref: string | null;
    state: string;
    product_id: string;
    project_id: string | null;
  }>;
}

/**
 * Groups evidence records by source type (Notion, Test, Manual, Other),
 * then runs existing groupEvidenceBySource within each bucket.
 */
export function groupEvidenceBySourceType(records: any[]): SourceGroup[] {
  const buckets: Record<string, any[]> = {
    notion: [],
    test: [],
    stoic: [],
    manual: [],
    other: [],
  };

  for (const record of records) {
    const ref = record.source_ref || "";
    const type = record.type || "";
    if (type === "stoic_text") {
      buckets.stoic.push(record);
    } else if (ref.startsWith("https://www.notion.so/") || ref.startsWith("notion:")) {
      buckets.notion.push(record);
    } else if (ref.startsWith("test:")) {
      buckets.test.push(record);
    } else if (!ref) {
      buckets.manual.push(record);
    } else {
      buckets.other.push(record);
    }
  }

  const labels: Record<string, string> = {
    notion: "Notion Corpus",
    test: "Submitted Tests",
    stoic: "Stoic Text",
    manual: "Manual Entries",
    other: "Other Sources",
  };

  const alwaysShow = new Set(["test"]); // Always show Submitted Tests even when empty
  const result: SourceGroup[] = [];
  for (const [type, recs] of Object.entries(buckets)) {
    if (recs.length === 0 && !alwaysShow.has(type)) continue;
    const { groups, ungrouped } = groupEvidenceBySource(recs);
    result.push({
      source_type: type as SourceGroup["source_type"],
      label: labels[type],
      evidence_count: recs.length,
      claims_count: 0, // populated by caller from sourceGroups API
      page_groups: groups,
      ungrouped,
    });
  }

  return result;
}
