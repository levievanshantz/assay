/**
 * Markdown renderers for briefing output modes.
 *
 * Three formatters (brief, scan, stress_test) + shared helpers
 * for citation mapping and retrieval artifact rendering.
 *
 * Rules across ALL outputs:
 * - Hyperlink document references wherever possible
 * - Citations are [{number}] in-text, numbered sources at bottom
 * - No JSON shown to user
 * - No blockquotes (>) --- use horizontal rules (---) for separation
 * - No italicized warnings --- plain text
 * - Retrieval artifact always last, separated by ---
 * - Citation placement: end of sentence/bullet, before the period
 */

// --- Types ----------------------------------------------------------------

export interface RetrievalMeta {
  totalRecords: number;
  totalChars: number;
  syncedAgo: string;
  documentOnly: number;
  claimsOnly: number;
  both: number;
  sources: Array<{
    number: number;
    title: string;
    url: string | null;
    sourceType: string;
  }>;
  warnings: string[];
}

interface CitationEntry {
  number: number;
  title: string;
  url: string | null;
  sourceType: string;
}

// --- Citation Helpers -----------------------------------------------------

/**
 * Map evidence IDs to citation numbers. Used by all formatters to convert
 * evidence_id references to [{n}] citations and build the sources list.
 */
export function buildCitationMap(
  evidenceIds: string[],
  evidenceRecords: Array<{
    id: string;
    title: string;
    source_ref?: string | null;
    type?: string;
  }>
): Map<string, CitationEntry> {
  const map = new Map<string, CitationEntry>();
  const recordLookup = new Map(evidenceRecords.map((r) => [r.id, r]));
  let counter = 1;

  for (const id of evidenceIds) {
    if (map.has(id)) continue;
    const record = recordLookup.get(id);
    map.set(id, {
      number: counter,
      title: record?.title ?? id,
      url: record?.source_ref ?? null,
      sourceType: record?.type ?? "unknown",
    });
    counter++;
  }

  return map;
}

function cite(
  citationMap: Map<string, CitationEntry>,
  evidenceId: string | undefined | null
): string {
  if (!evidenceId) return "";
  const entry = citationMap.get(evidenceId);
  return entry ? ` [${entry.number}]` : "";
}

function citeMultiple(
  citationMap: Map<string, CitationEntry>,
  evidenceIds: string[] | undefined | null
): string {
  if (!evidenceIds || evidenceIds.length === 0) return "";
  const nums = evidenceIds
    .map((id) => citationMap.get(id)?.number)
    .filter(Boolean);
  return nums.length > 0 ? ` [${nums.join(", ")}]` : "";
}

function renderSourceLink(
  title: string,
  url: string | null | undefined
): string {
  if (!url) return `**${title}**`;
  // Local file paths --- display as-is, no hyperlink
  if (url.startsWith("/") || url.startsWith("~")) return `**${title}** (${url})`;
  return `[**${title}**](${url})`;
}

function renderSourcesList(citationMap: Map<string, CitationEntry>): string {
  const entries = Array.from(citationMap.values()).sort(
    (a, b) => a.number - b.number
  );
  if (entries.length === 0) return "";

  const lines = entries.map((e) => {
    if (!e.url) return `${e.number}. **${e.title}** · ${e.sourceType} (no source URL)`;
    if (e.url.startsWith("/") || e.url.startsWith("~"))
      return `${e.number}. **${e.title}** · ${e.sourceType} (${e.url})`;
    return `${e.number}. [${e.title}](${e.url}) · ${e.sourceType}`;
  });

  return `**Sources**\n${lines.join("\n")}`;
}

/**
 * Collect all evidence IDs referenced anywhere in a parsed JSON result.
 */
function collectEvidenceIds(obj: unknown): string[] {
  const ids: string[] = [];
  if (obj === null || obj === undefined) return ids;
  if (typeof obj === "string") return ids;
  if (Array.isArray(obj)) {
    for (const item of obj) ids.push(...collectEvidenceIds(item));
    return ids;
  }
  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key === "evidence_id" && typeof value === "string") {
        ids.push(value);
      } else if (key === "evidence_ids" && Array.isArray(value)) {
        ids.push(...(value as string[]));
      } else {
        ids.push(...collectEvidenceIds(value));
      }
    }
  }
  return ids;
}

// --- Retrieval Artifact ---------------------------------------------------

/**
 * Shared retrieval artifact block appended to all outputs.
 */
export function buildRetrievalArtifact(meta: RetrievalMeta): string {
  const tokens = Math.round(meta.totalChars / 4 / 1000);
  const total = meta.documentOnly + meta.claimsOnly + meta.both;

  const pct = (n: number) =>
    total > 0 ? `${Math.round((n / total) * 100)}%` : "0%";

  const lines: string[] = [];
  lines.push(
    `**${meta.totalRecords} records retrieved** | ${meta.totalChars.toLocaleString()} chars (~${tokens}K tokens) | Synced ${meta.syncedAgo}`
  );
  lines.push("");
  lines.push(
    `**Document** ${meta.documentOnly} (${pct(meta.documentOnly)}) | **Subsurface insight** ${meta.claimsOnly} (${pct(meta.claimsOnly)}) | **Overlap** ${meta.both} (${pct(meta.both)})`
  );

  if (meta.sources.length > 0) {
    lines.push("");
    lines.push("**Sources**");
    for (const s of meta.sources) {
      if (!s.url) {
        lines.push(`${s.number}. **${s.title}** · ${s.sourceType}`);
      } else if (s.url.startsWith("/") || s.url.startsWith("~")) {
        lines.push(`${s.number}. **${s.title}** · ${s.sourceType} (${s.url})`);
      } else {
        lines.push(`${s.number}. [${s.title}](${s.url}) · ${s.sourceType}`);
      }
    }
  }

  if (meta.warnings.length > 0) {
    lines.push("");
    for (const w of meta.warnings) {
      lines.push(w);
    }
  }

  return lines.join("\n");
}

// --- Brief Formatter ------------------------------------------------------

export function formatBriefOutput(
  json: Record<string, unknown>,
  retrievalMeta: RetrievalMeta,
  topic: string,
  evidenceRecords: Array<{
    id: string;
    title: string;
    source_ref?: string | null;
    type?: string;
  }>
): string {
  const allIds = collectEvidenceIds(json);
  const citationMap = buildCitationMap(allIds, evidenceRecords);

  const lines: string[] = [];

  // Header
  lines.push(`## Brief --- "${topic}"`);
  lines.push("");
  lines.push(`**TL;DR:** ${json.tldr ?? "No summary available."}`);

  // Customer Signals
  const signals = (json.customer_signals as Array<Record<string, string>>) ?? [];
  if (signals.length > 0) {
    lines.push("");
    lines.push("### Customer Signals");
    lines.push("");
    for (const s of signals) {
      lines.push(
        `- **${s.signal}** --- ${s.source_summary} (${s.recency})${cite(citationMap, s.evidence_id)}`
      );
    }
  }

  // Prior Work
  const priorWork =
    (json.prior_work as Array<Record<string, string>>) ?? [];
  if (priorWork.length > 0) {
    lines.push("");
    lines.push("### Prior Work");
    lines.push("");
    lines.push("| Initiative | Summary | Outcome |");
    lines.push("|---|---|---|");
    for (const p of priorWork) {
      const titleCell = p.source_url
        ? `[**${p.title}**](${p.source_url})`
        : `**${p.title}**`;
      lines.push(`| ${titleCell} | ${p.summary} | ${p.outcome} |`);
    }
  }

  // Active Constraints
  const constraints =
    (json.active_constraints as Array<Record<string, string>>) ?? [];
  if (constraints.length > 0) {
    lines.push("");
    lines.push("### Active Constraints");
    lines.push("");
    for (const c of constraints) {
      lines.push(
        `- **${c.constraint}** --- ${c.authority}${cite(citationMap, c.evidence_id)}`
      );
    }
  }

  // Settled Decisions
  const settled =
    (json.debates_settled as Array<Record<string, unknown>>) ?? [];
  if (settled.length > 0) {
    lines.push("");
    lines.push("### Settled Decisions");
    lines.push("");
    for (const d of settled) {
      lines.push(
        `- ${d.topic}: ${d.resolution}${citeMultiple(citationMap, d.evidence_ids as string[])}`
      );
    }
  }

  // Open Debates
  const unsettled =
    (json.debates_unsettled as Array<Record<string, unknown>>) ?? [];
  if (unsettled.length > 0) {
    lines.push("");
    lines.push("### Open Debates");
    lines.push("");
    for (const d of unsettled) {
      lines.push(
        `- ${d.topic}: ${d.positions}${citeMultiple(citationMap, d.evidence_ids as string[])}`
      );
    }
  }

  // Dependencies
  const deps = (json.dependencies as Array<Record<string, string>>) ?? [];
  if (deps.length > 0) {
    lines.push("");
    lines.push("### Dependencies");
    lines.push("");
    for (const d of deps) {
      lines.push(`- **${d.dependency}** --- ${d.status}`);
    }
  }

  // Open Questions
  const questions =
    (json.open_questions as Array<Record<string, string>>) ?? [];
  if (questions.length > 0) {
    lines.push("");
    lines.push("### Open Questions");
    lines.push("");
    for (const q of questions) {
      lines.push(`- **${q.question}** --- ${q.why_it_matters}`);
    }
  }

  // Evidence Quality
  const eq = json.evidence_quality as Record<string, unknown> | undefined;
  if (eq) {
    lines.push("");
    lines.push("### Evidence Quality");
    lines.push("");
    const rd = eq.recency_distribution as Record<string, unknown> | undefined;
    const recencySummary = rd
      ? `${rd.recent ?? 0} recent, ${rd.aging ?? 0} aging, ${rd.stale ?? 0} stale, ${rd.unknown_date ?? 0} unknown date`
      : "recency unknown";
    const srcDist = eq.source_type_distribution
      ? Object.entries(eq.source_type_distribution as Record<string, unknown>)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ")
      : "unknown";
    lines.push(
      `${eq.total_records ?? "?"} records. ${recencySummary}. Sources: ${srcDist}. ${eq.quality_note ?? ""}`
    );
  }

  // Sources
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(renderSourcesList(citationMap));

  // Retrieval Artifact
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(buildRetrievalArtifact(retrievalMeta));

  return lines.join("\n");
}

// --- Scan Formatter -------------------------------------------------------

const SIGNAL_EMOJI: Record<string, string> = {
  support: "SUPPORT",
  caution: "CAUTION",
  blocker: "BLOCKER",
  context: "CONTEXT",
};

export function formatScanOutput(
  json: Record<string, unknown>,
  retrievalMeta: RetrievalMeta,
  topic: string,
  evidenceRecords: Array<{
    id: string;
    title: string;
    source_ref?: string | null;
    type?: string;
  }>
): string {
  const allIds = collectEvidenceIds(json);
  const citationMap = buildCitationMap(allIds, evidenceRecords);

  const lines: string[] = [];

  lines.push(`## Scan --- "${topic}"`);
  lines.push("");
  lines.push(`**TL;DR:** ${json.tldr ?? "No signals detected."}`);

  // Signals
  const scanSignals = (json.signals as Array<Record<string, string>>) ?? [];
  if (scanSignals.length > 0) {
    lines.push("");
    lines.push("### Signals");
    lines.push("");
    for (const s of scanSignals) {
      const label = SIGNAL_EMOJI[s.type] ?? s.type.toUpperCase();
      lines.push(
        `- ${label}: ${s.signal}${cite(citationMap, s.evidence_id)}`
      );
    }
  }

  // Verdict
  lines.push("");
  lines.push(
    `**Verdict:** ${(json.verdict as string)?.toUpperCase() ?? "UNKNOWN"} --- ${json.verdict_reason ?? ""}`
  );

  // Sources
  const sourcesList = renderSourcesList(citationMap);
  if (sourcesList) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(sourcesList);
  }

  // Retrieval Artifact
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(buildRetrievalArtifact(retrievalMeta));

  return lines.join("\n");
}

// --- Stress Test Formatter ------------------------------------------------

const SEVERITY_LABEL: Record<string, string> = {
  critical: "CRITICAL",
  significant: "SIGNIFICANT",
  minor: "MINOR",
  positive: "POSITIVE",
};

export function formatStressTestOutput(
  json: Record<string, unknown>,
  retrievalMeta: RetrievalMeta,
  topic: string,
  evidenceRecords: Array<{
    id: string;
    title: string;
    source_ref?: string | null;
    type?: string;
  }>
): string {
  const allIds = collectEvidenceIds(json);
  const citationMap = buildCitationMap(allIds, evidenceRecords);

  const lines: string[] = [];

  // Header + TL;DR
  lines.push(`## Stress Test --- "${topic}"`);
  lines.push("");
  lines.push(`**TL;DR:** ${json.tldr ?? "No assessment available."}`);

  // Proposal Reconstruction
  const pr = json.proposal_reconstruction as Record<string, unknown> | undefined;
  if (pr) {
    lines.push("");
    lines.push("### Proposal Reconstruction");
    lines.push("");
    lines.push(`**Core intent:** ${pr.core_intent ?? "Unknown"}`);
    lines.push(`**Stated problem:** ${pr.stated_problem ?? "Unknown"}`);
    const assumptions = (pr.key_assumptions as string[]) ?? [];
    if (assumptions.length > 0) {
      lines.push("**Key assumptions:**");
      for (const a of assumptions) {
        lines.push(`- ${a}`);
      }
    }
    lines.push(`**Success criteria:** ${pr.success_criteria ?? "Unknown"}`);
  }

  // Lenses Applied / Skipped
  const lensesApplied = (json.lenses_applied as string[]) ?? [];
  const lensesSkipped =
    (json.lenses_skipped as Record<string, string>) ?? {};
  if (lensesApplied.length > 0 || Object.keys(lensesSkipped).length > 0) {
    lines.push("");
    lines.push("### Lenses");
    lines.push("");
    if (lensesApplied.length > 0) {
      lines.push(
        `**Applied:** ${lensesApplied.join(", ")}`
      );
    }
    if (Object.keys(lensesSkipped).length > 0) {
      lines.push(
        `**Skipped:** ${Object.entries(lensesSkipped)
          .map(([lens, reason]) => `${lens} (${reason})`)
          .join(", ")}`
      );
    }
  }

  // Analysis
  const analysis =
    (json.analysis as Array<Record<string, unknown>>) ?? [];
  if (analysis.length > 0) {
    lines.push("");
    lines.push("### Analysis");
    lines.push("");
    for (const a of analysis) {
      const severity =
        SEVERITY_LABEL[(a.severity as string) ?? ""] ?? (a.severity as string)?.toUpperCase() ?? "";
      const quality = a.evidence_quality
        ? ` (${a.evidence_quality})`
        : "";
      lines.push(
        `- **${severity}:** ${a.finding} --- ${a.implication}${quality}${citeMultiple(citationMap, a.evidence_ids as string[])}`
      );
    }
  }

  // Failure Modes
  const failureModes =
    (json.failure_modes as Array<Record<string, unknown>>) ?? [];
  if (failureModes.length > 0) {
    lines.push("");
    lines.push("### Failure Modes");
    lines.push("");
    for (const f of failureModes) {
      lines.push(
        `- **${f.scenario}** --- Likelihood: ${f.likelihood}. Preventability: ${f.preventability}${citeMultiple(citationMap, f.evidence_ids as string[])}`
      );
    }
  }

  // Supporting Evidence
  const supporting =
    (json.supporting_evidence as Array<Record<string, string>>) ?? [];
  if (supporting.length > 0) {
    lines.push("");
    lines.push("### Supporting Evidence");
    lines.push("");
    for (const s of supporting) {
      lines.push(
        `- ${s.description} (${s.strength})${cite(citationMap, s.evidence_id)}`
      );
    }
  }

  // Verdict
  lines.push("");
  lines.push("### Verdict");
  lines.push("");
  const verdictStr = (json.verdict as string)?.toUpperCase().replace(/_/g, " ") ?? "UNKNOWN";
  lines.push(`**${verdictStr}**`);
  if (json.verdict_summary) {
    lines.push("");
    lines.push(json.verdict_summary as string);
  }

  // Conditions
  const conditions = (json.conditions as string[]) ?? [];
  if (conditions.length > 0) {
    lines.push("");
    lines.push("**Conditions:**");
    for (const c of conditions) {
      lines.push(`- ${c}`);
    }
  }

  // Confidence
  lines.push("");
  lines.push(
    `**Confidence:** ${(json.confidence as string)?.toUpperCase() ?? "UNKNOWN"}${json.confidence_rationale ? ` --- ${json.confidence_rationale}` : ""}`
  );

  // Sources
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(renderSourcesList(citationMap));

  // Retrieval Artifact
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(buildRetrievalArtifact(retrievalMeta));

  return lines.join("\n");
}
