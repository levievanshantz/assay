/**
 * Confluence API Client — Fetch and parse Confluence pages for ingestion.
 * Handles both Confluence Cloud (Atlassian) and Server/Data Center.
 *
 * ADF (Atlassian Document Format) parsing is intentionally simple —
 * we extract text content from the most common block types PMs use.
 * Complex elements (macros, inline cards, media) are skipped.
 */

// ─── Types ──────────────────────────────────────────────────────

export interface ConfluenceConfig {
  baseUrl: string; // e.g. https://mycompany.atlassian.net/wiki
  email: string; // Atlassian account email
  apiToken: string; // API token (Cloud) or PAT (Server)
}

interface ConfluencePage {
  id: string;
  title: string;
  body: string; // Plaintext extracted from ADF/storage format
  url: string;
  lastModified: string;
  spaceKey: string;
}

// ─── Page Fetching ──────────────────────────────────────────────

export function parseConfluencePageId(input: string): string {
  const cleaned = input.trim();

  // Numeric page ID
  if (/^\d+$/.test(cleaned)) return cleaned;

  // Extract from Cloud URL: /wiki/spaces/SPACE/pages/12345/Title
  const cloudMatch = cleaned.match(/\/pages\/(\d+)/);
  if (cloudMatch) return cloudMatch[1];

  // Extract from Server URL: /display/SPACE/Title or /pages/viewpage.action?pageId=12345
  const serverMatch = cleaned.match(/pageId=(\d+)/);
  if (serverMatch) return serverMatch[1];

  throw new Error(`Cannot extract Confluence page ID from: ${input}`);
}

export async function fetchConfluencePage(
  pageId: string,
  config: ConfluenceConfig
): Promise<ConfluencePage> {
  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString(
    "base64"
  );

  // Try v2 API first (Cloud), fall back to v1
  const url = `${config.baseUrl}/api/v2/pages/${pageId}?body-format=atlas_doc_format`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    // Fall back to v1 API (storage format)
    return fetchConfluencePageV1(pageId, config, auth);
  }

  const json = (await res.json()) as {
    id: string;
    title: string;
    body: { atlas_doc_format: { value: string } };
    version: { modifiedAt: string };
    spaceId: string;
    _links: { webui: string };
  };

  const adfBody = JSON.parse(json.body.atlas_doc_format.value);
  const plaintext = adfToPlaintext(adfBody);

  return {
    id: json.id,
    title: json.title,
    body: plaintext,
    url: `${config.baseUrl}${json._links.webui}`,
    lastModified: json.version.modifiedAt,
    spaceKey: json.spaceId,
  };
}

async function fetchConfluencePageV1(
  pageId: string,
  config: ConfluenceConfig,
  auth: string
): Promise<ConfluencePage> {
  const url = `${config.baseUrl}/rest/api/content/${pageId}?expand=body.storage,version,space`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Confluence API error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    id: string;
    title: string;
    body: { storage: { value: string } };
    version: { when: string };
    space: { key: string };
    _links: { webui: string; base: string };
  };

  // Storage format is HTML-like — strip tags for plaintext
  const plaintext = storageFormatToPlaintext(json.body.storage.value);

  return {
    id: json.id,
    title: json.title,
    body: plaintext,
    url: `${json._links.base}${json._links.webui}`,
    lastModified: json.version.when,
    spaceKey: json.space.key,
  };
}

// ─── ADF Parser (Atlassian Document Format) ─────────────────────

function adfToPlaintext(doc: any): string {
  if (!doc || !doc.content) return "";
  return extractAdfContent(doc.content).join("\n");
}

function extractAdfContent(nodes: any[], depth = 0): string[] {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);

  for (const node of nodes) {
    switch (node.type) {
      case "heading": {
        const level = node.attrs?.level ?? 1;
        const prefix = "#".repeat(level);
        const text = extractInlineText(node.content);
        lines.push(`${prefix} ${text}`);
        break;
      }

      case "paragraph": {
        const text = extractInlineText(node.content);
        if (text) lines.push(`${indent}${text}`);
        break;
      }

      case "bulletList":
        if (node.content) {
          for (const item of node.content) {
            if (item.type === "listItem" && item.content) {
              const text = extractInlineText(
                item.content.flatMap((c: any) => c.content || [])
              );
              lines.push(`${indent}- ${text}`);
              // Recurse for nested lists
              for (const child of item.content) {
                if (
                  child.type === "bulletList" ||
                  child.type === "orderedList"
                ) {
                  lines.push(...extractAdfContent([child], depth + 1));
                }
              }
            }
          }
        }
        break;

      case "orderedList":
        if (node.content) {
          let idx = 1;
          for (const item of node.content) {
            if (item.type === "listItem" && item.content) {
              const text = extractInlineText(
                item.content.flatMap((c: any) => c.content || [])
              );
              lines.push(`${indent}${idx}. ${text}`);
              idx++;
            }
          }
        }
        break;

      case "codeBlock": {
        const text = extractInlineText(node.content);
        lines.push(`\`\`\`\n${text}\n\`\`\``);
        break;
      }

      case "blockquote":
        if (node.content) {
          const quoted = extractAdfContent(node.content, depth);
          lines.push(...quoted.map((l) => `> ${l}`));
        }
        break;

      case "table":
        if (node.content) {
          for (const row of node.content) {
            if (row.type === "tableRow" && row.content) {
              const cells = row.content.map((cell: any) => {
                const text = extractInlineText(
                  (cell.content || []).flatMap((c: any) => c.content || [])
                );
                return text;
              });
              lines.push(`| ${cells.join(" | ")} |`);
            }
          }
        }
        break;

      case "rule":
        lines.push("---");
        break;

      case "expand": {
        // Confluence expand/collapse block
        const title = node.attrs?.title || "";
        if (title) lines.push(`${indent}${title}`);
        if (node.content) {
          lines.push(...extractAdfContent(node.content, depth));
        }
        break;
      }

      case "panel": {
        // Info/warning/note panels
        if (node.content) {
          lines.push(...extractAdfContent(node.content, depth));
        }
        break;
      }

      case "taskList":
        if (node.content) {
          for (const item of node.content) {
            if (item.type === "taskItem") {
              const checked = item.attrs?.state === "DONE" ? "x" : " ";
              const text = extractInlineText(item.content);
              lines.push(`${indent}- [${checked}] ${text}`);
            }
          }
        }
        break;

      // Skip: media, mediaGroup, mediaSingle, inlineCard, blockCard,
      // extension, bodiedExtension, layoutSection, layoutColumn
      default:
        // Try to extract text from unknown nodes with content
        if (node.content && Array.isArray(node.content)) {
          lines.push(...extractAdfContent(node.content, depth));
        }
        break;
    }
  }

  return lines;
}

function extractInlineText(content: any[]): string {
  if (!content || !Array.isArray(content)) return "";

  return content
    .map((node) => {
      if (node.type === "text") return node.text ?? "";
      if (node.type === "hardBreak") return "\n";
      if (node.type === "mention") return `@${node.attrs?.text ?? ""}`;
      if (node.type === "emoji") return node.attrs?.shortName ?? "";
      if (node.type === "status") return `[${node.attrs?.text ?? ""}]`;
      if (node.type === "date") return node.attrs?.timestamp ?? "";
      if (node.type === "inlineCard") return node.attrs?.url ?? "";
      // Recurse into inline nodes with content
      if (node.content) return extractInlineText(node.content);
      return "";
    })
    .join("");
}

// ─── Storage Format Parser (v1 API fallback) ────────────────────

function storageFormatToPlaintext(html: string): string {
  // Simple HTML tag stripping — not a full parser but handles common cases
  return (
    html
      // Convert headings
      .replace(/<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi, (_, level, text) => {
        return "#".repeat(parseInt(level)) + " " + stripTags(text) + "\n";
      })
      // Convert lists
      .replace(/<li[^>]*>(.*?)<\/li>/gi, (_, text) => `- ${stripTags(text)}\n`)
      // Convert paragraphs
      .replace(/<p[^>]*>(.*?)<\/p>/gi, (_, text) => stripTags(text) + "\n")
      // Convert line breaks
      .replace(/<br\s*\/?>/gi, "\n")
      // Strip remaining tags
      .replace(/<[^>]+>/g, "")
      // Decode entities
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      // Clean up whitespace
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}
