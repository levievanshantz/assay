// Parse <assay-decision> tags from raw agent transcript text.
// Independent of claude-mem — claude-mem strips memory tags before
// persistence, so AssayLabs must parse the original transcript directly.
//
// Tag shape (eng-decision, the v2 baseline):
//   <assay-decision kind="decision" supersedes="abc12345" confidence="0.8">
//     Decision text body.
//   </assay-decision>
//
// The Stop hook hands this parser the RAW transcript file. Claude Code writes
// transcripts as JSONL, so inside the file every tag's quotes arrive JSON-escaped
// (kind=\"decision\") and its body carries JSON escapes (\n, \", \\). The parser
// accepts both the escaped form and plain text.
//
// PM-shape tags (migration 035) are deferred until a PM asks.

/** Kinds the decisions table accepts (CHECK constraint in schema.ts). */
export const DECISION_KINDS = ["decision", "conflict"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/**
 * Kinds taught by the alpha.2 capture protocol. The storage schema only has
 * decision|conflict, so these are stored as kind="decision" instead of being
 * rejected: a tag written by an agent that followed the earlier protocol is
 * still a correctly tagged decision.
 */
export const LEGACY_KIND_ALIASES: Readonly<Record<string, DecisionKind>> = {
  constraint: "decision",
  "trade-off": "decision",
  "scope-change": "decision",
  "open-question": "decision",
  finding: "decision",
};

/**
 * Real decisions are one sentence. A body past this size is an unpaired-tag
 * span (an opener with no closer of its own swallowing transcript up to the
 * next closer), never a decision.
 */
export const MAX_BODY_CHARS = 2000;

export interface ParsedDecision {
  kind: DecisionKind;
  body: string;
  supersedes_raw?: string;
  confidence?: number;
  layer?: string;
  /** The kind as written, when it was a legacy alias mapped onto `kind`. */
  kind_alias?: string;
  /**
   * The same raw span decoded the way the Jul 2026 hotfix build did (trim, then
   * sequential \n, \", \\ replaces), when that differs from `body`. The store's
   * cross-run dedupe also matches it, so a session that continues after an
   * upgrade from that build does not store a second copy of its earlier tags.
   */
  legacy_body?: string;
  source_span: { start: number; end: number };
}

export interface ParseResult {
  decisions: ParsedDecision[];
  errors: Array<{ message: string; span?: { start: number; end: number } }>;
}

// The body may not contain another opener, so a match always starts at the
// innermost opener before its closer. That keeps the scan linear: an attempt
// from an unclosed opener stops at the next opener instead of running to the
// end of the transcript.
const TAG_RE = /<assay-decision\b([^>]*)>((?:(?!<assay-decision\b)[\s\S])*?)<\/assay-decision>/g;
const OPENER_RE = /<assay-decision\b/g;

// An opener between the previous match and this one never closed on its own,
// so it would have run on into this tag. Where it sits decides what it is:
//
// - On an EARLIER raw line (an earlier JSONL record: a grep hit, a doc
//   excerpt, a half-written example). It is stray text, not part of this tag,
//   and the tag parses.
// - On the SAME raw line as this tag's opener. One JSONL record holds both, so
//   the text really does contain tag syntax (a decision that names the tag, or
//   a document such as the capture protocol that mentions the tag and then
//   shows an example). The tag is rejected as tag syntax, as the Jul 2026
//   hotfix build did.
function strayOpenerOnSameLine(gap: string): boolean {
  let last = -1;
  let m: RegExpExecArray | null;
  OPENER_RE.lastIndex = 0;
  while ((m = OPENER_RE.exec(gap))) last = m.index;
  return last >= 0 && !gap.slice(last).includes("\n");
}

// What the Jul 2026 hotfix build stored for a raw body (see legacy_body).
function hotfixDecode(raw: string): string {
  return raw.trim().replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

// Transcripts are raw JSONL: quotes inside message content arrive JSON-escaped (\").
// The optional backslash before each quote lets attributes parse from both raw
// transcripts and plain text. (Before 2026-07-03 attributes NEVER parsed from real
// transcripts — kind always defaulted, supersedes/layer/confidence were silently lost.)
const ATTR_RE = /(\w[\w-]*)\s*=\s*\\?"([^"\\]*)\\?"/g;

// One pass over JSON string escapes. A single pass matters: sequential
// replace() calls turn an escaped backslash followed by "n" (\\n, the text
// "\n" written literally) into a backslash plus a newline.
const JSON_ESCAPE_RE = /\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g;

function unescapeJsonEscapes(s: string): string {
  return s.replace(JSON_ESCAPE_RE, (_m, e: string) => {
    switch (e[0]) {
      case '"': return '"';
      case "\\": return "\\";
      case "/": return "/";
      case "b": return "\b";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      default: return String.fromCharCode(parseInt(e.slice(1), 16)); // uXXXX
    }
  });
}

function parseAttrs(attrString: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrString))) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

function normalizeKind(raw: string): { kind: DecisionKind; alias?: string } | null {
  if ((DECISION_KINDS as readonly string[]).includes(raw)) return { kind: raw as DecisionKind };
  const mapped = Object.prototype.hasOwnProperty.call(LEGACY_KIND_ALIASES, raw)
    ? LEGACY_KIND_ALIASES[raw]
    : undefined;
  return mapped ? { kind: mapped, alias: raw } : null;
}

export function parseDecisionTags(transcript: string): ParseResult {
  const decisions: ParsedDecision[] = [];
  const errors: ParseResult["errors"] = [];
  const seen = new Set<string>(); // idempotency: dedupe by body+kind hash

  let match: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  let prevEnd = 0;
  while ((match = TAG_RE.exec(transcript))) {
    const start = match.index;
    const end = match.index + match[0].length;
    const gap = transcript.slice(prevEnd, start);
    prevEnd = end;

    if (strayOpenerOnSameLine(gap)) {
      errors.push({ message: "body contains tag syntax — parse artifact, skipped", span: { start, end } });
      continue;
    }

    const attrs = parseAttrs(match[1] ?? "");
    const raw = match[2] ?? "";
    // Unescape first, then trim: a multi-line tag in JSONL starts and ends with
    // the two-character escape \n, which trim() alone does not remove.
    const body = unescapeJsonEscapes(raw).trim();

    const kindRaw = attrs.kind ?? "decision";
    const kind = normalizeKind(kindRaw);
    if (!kind) {
      errors.push({
        message: `unknown kind="${kindRaw}" (expected "decision" or "conflict")`,
        span: { start, end },
      });
      continue;
    }

    if (body.length === 0) {
      errors.push({ message: "empty <assay-decision> body", span: { start, end } });
      continue;
    }

    if (body.includes("<assay-decision") || body.includes("‹assay-decision")) {
      // A genuine decision never contains its own tag syntax; a body that does is a
      // parse artifact from tag-adjacent text (docs, edit commands, examples).
      errors.push({ message: "body contains tag syntax — parse artifact, skipped", span: { start, end } });
      continue;
    }

    if (body.length > MAX_BODY_CHARS) {
      // Unpaired-tag spans: an opener without its own closer swallows transcript until the
      // next closer, capturing megabytes as one "decision" (479 such rows quarantined
      // 2026-07-04, incl. one 43MB row re-captured per turn for a month). Real decisions
      // are one sentence; anything past 2k chars is a parse artifact, never a decision.
      errors.push({
        message: `oversized body (${body.length} chars) — unpaired-tag span, skipped`,
        span: { start, end },
      });
      continue;
    }

    const dedupeKey = `${kind.kind}:${body}`;
    if (seen.has(dedupeKey)) continue; // idempotency per F4 smoke
    seen.add(dedupeKey);

    let confidence: number | undefined;
    if (attrs.confidence !== undefined) {
      const n = Number(attrs.confidence);
      if (Number.isFinite(n) && n >= 0 && n <= 1) confidence = n;
      else errors.push({
        message: `invalid confidence="${attrs.confidence}" (expected 0..1)`,
        span: { start, end },
      });
    }

    const parsed: ParsedDecision = {
      kind: kind.kind,
      body,
      supersedes_raw: attrs.supersedes,
      confidence,
      layer: attrs.layer,
      source_span: { start, end },
    };
    if (kind.alias) parsed.kind_alias = kind.alias;
    const legacy = hotfixDecode(raw);
    if (legacy !== body) parsed.legacy_body = legacy;
    decisions.push(parsed);
  }

  return { decisions, errors };
}
