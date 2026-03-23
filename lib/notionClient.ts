/**
 * Notion API Client — Shared functions for fetching, parsing, and chunking Notion pages.
 * Used by: MCP server (ingest_from_notion), Notion sync polling (PRD 9.1)
 */

const CHUNK_CHAR_LIMIT = 12000;

// ─── Notion API Helpers ─────────────────────────────────────────

export function parseNotionPageId(input: string): string {
  const cleaned = input.trim();

  // Raw 32-char hex ID (with or without dashes)
  const hexOnly = cleaned.replace(/-/g, "");
  if (/^[a-f0-9]{32}$/i.test(hexOnly)) return hexOnly;

  // Extract from URL — last 32 hex chars
  const match = cleaned.match(/([a-f0-9]{32})\s*$/i);
  if (match) return match[1];

  // Try extracting from hyphenated UUID in URL
  const uuidMatch = cleaned.match(
    /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i
  );
  if (uuidMatch) return uuidMatch[1].replace(/-/g, "");

  throw new Error(`Cannot extract Notion page ID from: ${input}`);
}

export async function fetchNotionBlocks(
  blockId: string,
  apiKey: string
): Promise<any[]> {
  const blocks: any[] = [];
  let cursor: string | undefined;

  do {
    const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`);
    url.searchParams.set("page_size", "100");
    if (cursor) url.searchParams.set("start_cursor", cursor);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Notion-Version": "2022-06-28",
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Notion API error ${res.status}: ${body}`);
    }

    const json = (await res.json()) as {
      results: any[];
      has_more: boolean;
      next_cursor: string | null;
    };

    for (const block of json.results) {
      blocks.push(block);
      if (
        block.has_children &&
        !["child_page", "child_database"].includes(block.type)
      ) {
        const children = await fetchNotionBlocks(block.id, apiKey);
        block._children = children;
      }
    }

    cursor = json.has_more ? (json.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return blocks;
}

export async function fetchNotionPageTitle(
  pageId: string,
  apiKey: string
): Promise<string> {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": "2022-06-28",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion page fetch error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as { properties: Record<string, any> };
  for (const prop of Object.values(json.properties)) {
    if (prop.type === "title" && Array.isArray(prop.title)) {
      return prop.title.map((t: any) => t.plain_text).join("") || "Untitled";
    }
  }
  return "Untitled";
}

export async function fetchNotionPageMeta(
  pageId: string,
  apiKey: string
): Promise<{ title: string; lastEditedTime: string; inTrash: boolean }> {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": "2022-06-28",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion page fetch error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    last_edited_time: string;
    in_trash: boolean;
    properties: Record<string, any>;
  };

  let title = "Untitled";
  for (const prop of Object.values(json.properties)) {
    if (prop.type === "title" && Array.isArray(prop.title)) {
      title = prop.title.map((t: any) => t.plain_text).join("") || "Untitled";
      break;
    }
  }

  return {
    title,
    lastEditedTime: json.last_edited_time,
    inTrash: json.in_trash ?? false,
  };
}

// ─── Text Conversion ────────────────────────────────────────────

export function richTextToPlain(richText: any[]): string {
  if (!Array.isArray(richText)) return "";
  return richText.map((t: any) => t.plain_text ?? "").join("");
}

export function blocksToText(blocks: any[], depth = 0): string[] {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);

  for (const block of blocks) {
    const type = block.type;

    switch (type) {
      case "heading_1":
        lines.push(`# ${richTextToPlain(block.heading_1?.rich_text)}`);
        break;
      case "heading_2":
        lines.push(`## ${richTextToPlain(block.heading_2?.rich_text)}`);
        break;
      case "heading_3":
        lines.push(`### ${richTextToPlain(block.heading_3?.rich_text)}`);
        break;
      case "paragraph":
        lines.push(`${indent}${richTextToPlain(block.paragraph?.rich_text)}`);
        break;
      case "bulleted_list_item":
        lines.push(
          `${indent}- ${richTextToPlain(block.bulleted_list_item?.rich_text)}`
        );
        break;
      case "numbered_list_item":
        lines.push(
          `${indent}1. ${richTextToPlain(block.numbered_list_item?.rich_text)}`
        );
        break;
      case "to_do": {
        const checked = block.to_do?.checked ? "x" : " ";
        lines.push(
          `${indent}- [${checked}] ${richTextToPlain(block.to_do?.rich_text)}`
        );
        break;
      }
      case "toggle":
        lines.push(
          `${indent}${richTextToPlain(block.toggle?.rich_text)}`
        );
        break;
      case "quote":
        lines.push(
          `${indent}> ${richTextToPlain(block.quote?.rich_text)}`
        );
        break;
      case "callout":
        lines.push(
          `${indent}> ${richTextToPlain(block.callout?.rich_text)}`
        );
        break;
      case "code":
        lines.push(
          `${indent}\`\`\`\n${indent}${richTextToPlain(block.code?.rich_text)}\n${indent}\`\`\``
        );
        break;
      case "divider":
        lines.push("---");
        break;
      default:
        break;
    }

    if (block._children && block._children.length > 0) {
      lines.push(...blocksToText(block._children, depth + 1));
    }
  }

  return lines;
}

// ─── Chunking ───────────────────────────────────────────────────

export function chunkAtHeadings(
  fullText: string,
  pageTitle: string
): { title: string; text: string }[] {
  const lines = fullText.split("\n");
  const chunks: { title: string; text: string }[] = [];
  let currentHeading = "";
  let currentLines: string[] = [];

  function flushChunk() {
    const text = currentLines.join("\n").trim();
    if (!text) return;

    const title = currentHeading
      ? `${pageTitle} — ${currentHeading}`
      : pageTitle;

    if (text.length <= CHUNK_CHAR_LIMIT) {
      chunks.push({ title, text });
    } else {
      let start = 0;
      let subIndex = 0;
      while (start < text.length) {
        let end = start + CHUNK_CHAR_LIMIT;
        if (end < text.length) {
          const paraBreak = text.lastIndexOf("\n\n", end);
          if (paraBreak > start + CHUNK_CHAR_LIMIT * 0.5) end = paraBreak;
        }
        const subText = text.slice(start, Math.min(end, text.length)).trim();
        if (subText) {
          const subTitle =
            subIndex === 0 ? title : `${title} (cont. ${subIndex + 1})`;
          chunks.push({ title: subTitle, text: subText });
          subIndex++;
        }
        start = end;
      }
    }
  }

  for (const line of lines) {
    if (/^#{1,2}\s/.test(line)) {
      flushChunk();
      currentHeading = line.replace(/^#{1,2}\s+/, "").trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  flushChunk();
  return chunks;
}
