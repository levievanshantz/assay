#!/usr/bin/env node

/**
 * Notion Workspace Crawler — PRD 16
 *
 * Recursively walks a Notion workspace via the official API,
 * extracts all text content, chunks at heading boundaries,
 * and outputs structured JSON ready for the ingestion pipeline.
 *
 * Usage:
 *   node scripts/notion-crawl.mjs                    # full crawl
 *   node scripts/notion-crawl.mjs --incremental      # only pages modified since last crawl
 *   node scripts/notion-crawl.mjs --dry-run          # list pages, don't extract content
 *   node scripts/notion-crawl.mjs --page <id|url>    # crawl a single page
 *
 * Output: scripts/output/notion-crawl-<timestamp>.json
 *
 * Env vars (reads from .env.local):
 *   NOTION_API_KEY  — Notion integration token
 *   PRODUCT_ID      — default product UUID
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import crypto from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
config({ path: resolve(PROJECT_ROOT, ".env.local") });

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const PRODUCT_ID = process.env.PRODUCT_ID || "default";
const NOTION_VERSION = "2022-06-28";
const RATE_LIMIT_MS = 340; // ~3 req/sec
const CHUNK_CHAR_LIMIT = 12_000;
const OUTPUT_DIR = resolve(__dirname, "output");
const STATE_FILE = resolve(OUTPUT_DIR, "notion-crawl-state.json");

// ─── CLI Args ────────────────────────────────────────────────
const args = process.argv.slice(2);
const FLAG_INCREMENTAL = args.includes("--incremental");
const FLAG_DRY_RUN = args.includes("--dry-run");
const FLAG_SINGLE_PAGE = args.includes("--page");
const SINGLE_PAGE_ID = FLAG_SINGLE_PAGE ? args[args.indexOf("--page") + 1] : null;
const FLAG_VERBOSE = args.includes("--verbose") || args.includes("-v");

// ─── State (for incremental crawls) ─────────────────────────
let previousState = {};
if (FLAG_INCREMENTAL && existsSync(STATE_FILE)) {
  try {
    previousState = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    console.warn("⚠ Could not parse state file, doing full crawl");
  }
}

// ─── Notion API Helpers ─────────────────────────────────────
let requestCount = 0;

async function notionFetch(path, body = null) {
  // Rate limiting
  await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
  requestCount++;

  const url = `https://api.notion.com/v1${path}`;
  const opts = {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) {
      // Rate limited — wait and retry
      const retryAfter = parseInt(res.headers.get("retry-after") || "2", 10);
      console.warn(`  ⏳ Rate limited, waiting ${retryAfter}s...`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return notionFetch(path, body);
    }
    throw new Error(`Notion API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Search All Pages ───────────────────────────────────────
async function searchAllPages() {
  const pages = [];
  let cursor = undefined;
  let batch = 0;

  do {
    batch++;
    const body = { page_size: 100, filter: { value: "page", property: "object" } };
    if (cursor) body.start_cursor = cursor;

    const result = await notionFetch("/search", body);
    for (const page of result.results) {
      let title = "Untitled";
      for (const prop of Object.values(page.properties || {})) {
        if (prop.type === "title" && Array.isArray(prop.title)) {
          title = prop.title.map((t) => t.plain_text).join("") || "Untitled";
          break;
        }
      }

      pages.push({
        id: page.id.replace(/-/g, ""),
        title,
        lastEditedTime: page.last_edited_time,
        createdTime: page.created_time,
        inTrash: page.in_trash || false,
        parentType: page.parent?.type || "unknown",
        parentId: page.parent?.page_id || page.parent?.database_id || page.parent?.workspace_id || null,
        url: `https://www.notion.so/${page.id.replace(/-/g, "")}`,
      });
    }

    cursor = result.has_more ? result.next_cursor : undefined;
    if (FLAG_VERBOSE) console.log(`  Batch ${batch}: ${result.results.length} pages (total: ${pages.length})`);
  } while (cursor);

  return pages;
}

// ─── Fetch Blocks (recursive) ───────────────────────────────
async function fetchBlocks(blockId, depth = 0) {
  const blocks = [];
  let cursor = undefined;

  do {
    const path = `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`;
    const result = await notionFetch(path);

    for (const block of result.results) {
      blocks.push(block);
      // Recurse into children (skip child pages and databases — those are separate pages)
      if (block.has_children && !["child_page", "child_database"].includes(block.type) && depth < 5) {
        try {
          block._children = await fetchBlocks(block.id, depth + 1);
        } catch (err) {
          if (FLAG_VERBOSE) console.warn(`    ⚠ Failed to fetch children of ${block.id}: ${err.message}`);
          block._children = [];
        }
      }
    }

    cursor = result.has_more ? result.next_cursor : undefined;
  } while (cursor);

  return blocks;
}

// ─── Block → Text Conversion ────────────────────────────────
function richTextToPlain(richText) {
  if (!Array.isArray(richText)) return "";
  return richText.map((t) => t.plain_text ?? "").join("");
}

function blocksToText(blocks, depth = 0) {
  const lines = [];
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
        lines.push(`${indent}- ${richTextToPlain(block.bulleted_list_item?.rich_text)}`);
        break;
      case "numbered_list_item":
        lines.push(`${indent}1. ${richTextToPlain(block.numbered_list_item?.rich_text)}`);
        break;
      case "to_do": {
        const checked = block.to_do?.checked ? "x" : " ";
        lines.push(`${indent}- [${checked}] ${richTextToPlain(block.to_do?.rich_text)}`);
        break;
      }
      case "toggle":
        lines.push(`${indent}${richTextToPlain(block.toggle?.rich_text)}`);
        break;
      case "quote":
        lines.push(`${indent}> ${richTextToPlain(block.quote?.rich_text)}`);
        break;
      case "callout":
        lines.push(`${indent}> ${richTextToPlain(block.callout?.rich_text)}`);
        break;
      case "code":
        lines.push(`${indent}\`\`\`\n${indent}${richTextToPlain(block.code?.rich_text)}\n${indent}\`\`\``);
        break;
      case "table": {
        if (block._children) {
          for (const row of block._children) {
            if (row.type === "table_row" && row.table_row?.cells) {
              const cells = row.table_row.cells.map((cell) => richTextToPlain(cell));
              lines.push(`${indent}| ${cells.join(" | ")} |`);
            }
          }
        }
        break;
      }
      case "divider":
        lines.push("---");
        break;
      case "bookmark":
        lines.push(`${indent}[Bookmark: ${block.bookmark?.url || ""}]`);
        break;
      case "image":
        lines.push(`${indent}[Image: ${block.image?.external?.url || block.image?.file?.url || ""}]`);
        break;
      default:
        break;
    }

    if (block._children && block._children.length > 0 && block.type !== "table") {
      lines.push(...blocksToText(block._children, depth + 1));
    }
  }

  return lines;
}

// ─── Chunking ───────────────────────────────────────────────
function chunkAtHeadings(fullText, pageTitle) {
  const lines = fullText.split("\n");
  const chunks = [];
  let currentHeading = "";
  let currentLines = [];

  function flushChunk() {
    const text = currentLines.join("\n").trim();
    if (!text) return;

    const title = currentHeading ? `${pageTitle} — ${currentHeading}` : pageTitle;

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
          const subTitle = subIndex === 0 ? title : `${title} (cont. ${subIndex + 1})`;
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

function computeContentHash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  if (!NOTION_API_KEY) {
    console.error("❌ NOTION_API_KEY not set. Add it to .env.local");
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════════════════");
  console.log("  NOTION WORKSPACE CRAWLER");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Mode: ${FLAG_DRY_RUN ? "DRY RUN" : FLAG_INCREMENTAL ? "INCREMENTAL" : FLAG_SINGLE_PAGE ? "SINGLE PAGE" : "FULL CRAWL"}`);
  console.log(`  Product ID: ${PRODUCT_ID}`);
  console.log("");

  // Ensure output dir
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  // Step 1: Discover pages
  let pages;
  if (FLAG_SINGLE_PAGE) {
    const pageId = SINGLE_PAGE_ID.replace(/-/g, "").replace(/.*([a-f0-9]{32})$/i, "$1");
    console.log(`📄 Fetching single page: ${pageId}`);
    const meta = await notionFetch(`/pages/${pageId}`);
    let title = "Untitled";
    for (const prop of Object.values(meta.properties || {})) {
      if (prop.type === "title" && Array.isArray(prop.title)) {
        title = prop.title.map((t) => t.plain_text).join("") || "Untitled";
        break;
      }
    }
    pages = [{
      id: pageId,
      title,
      lastEditedTime: meta.last_edited_time,
      createdTime: meta.created_time,
      inTrash: meta.in_trash || false,
      parentType: meta.parent?.type || "unknown",
      parentId: null,
      url: `https://www.notion.so/${pageId}`,
    }];
  } else {
    console.log("🔍 Searching workspace for all pages...");
    pages = await searchAllPages();
  }

  // Filter trashed pages
  const activePages = pages.filter((p) => !p.inTrash);
  const trashedPages = pages.filter((p) => p.inTrash);
  console.log(`\n📊 Found ${pages.length} total pages (${activePages.length} active, ${trashedPages.length} trashed)`);

  // Incremental: filter to only modified pages
  let pagesToCrawl = activePages;
  if (FLAG_INCREMENTAL && Object.keys(previousState).length > 0) {
    pagesToCrawl = activePages.filter((p) => {
      const prev = previousState[p.id];
      if (!prev) return true; // new page
      return new Date(p.lastEditedTime).getTime() > new Date(prev.lastEditedTime).getTime();
    });
    console.log(`🔄 Incremental: ${pagesToCrawl.length} pages modified since last crawl (${activePages.length - pagesToCrawl.length} unchanged)`);
  }

  if (FLAG_DRY_RUN) {
    console.log("\n📋 Pages that would be crawled:");
    for (const p of pagesToCrawl) {
      console.log(`  ${p.id.slice(0, 8)}... ${p.title} (edited: ${p.lastEditedTime})`);
    }
    console.log(`\n  Total: ${pagesToCrawl.length} pages`);
    console.log(`  API requests used: ${requestCount}`);
    return;
  }

  // Step 2: Extract content from each page
  console.log(`\n📥 Extracting content from ${pagesToCrawl.length} pages...`);
  const results = [];
  const errors = [];
  const newState = { ...previousState };

  for (let i = 0; i < pagesToCrawl.length; i++) {
    const page = pagesToCrawl[i];
    const progress = `[${i + 1}/${pagesToCrawl.length}]`;

    try {
      process.stdout.write(`  ${progress} ${page.title.slice(0, 50).padEnd(50)} `);

      const blocks = await fetchBlocks(page.id);
      const textLines = blocksToText(blocks);
      const fullText = textLines.join("\n").trim();

      if (!fullText) {
        console.log("⏭  (empty)");
        continue;
      }

      const chunks = chunkAtHeadings(fullText, page.title);
      const contentHash = computeContentHash(fullText);

      // Check if content actually changed (hash comparison)
      if (FLAG_INCREMENTAL && previousState[page.id]?.contentHash === contentHash) {
        console.log("⏭  (unchanged content)");
        newState[page.id] = { lastEditedTime: page.lastEditedTime, contentHash };
        continue;
      }

      results.push({
        pageId: page.id,
        title: page.title,
        url: page.url,
        lastEditedTime: page.lastEditedTime,
        createdTime: page.createdTime,
        contentHash,
        fullText,
        fullTextLength: fullText.length,
        blockCount: blocks.length,
        chunks: chunks.map((c, idx) => ({
          index: idx,
          title: c.title,
          text: c.text,
          charCount: c.text.length,
          contentHash: computeContentHash(c.text),
        })),
      });

      newState[page.id] = { lastEditedTime: page.lastEditedTime, contentHash };
      console.log(`✅ ${chunks.length} chunks, ${fullText.length} chars`);
    } catch (err) {
      console.log(`❌ ${err.message.slice(0, 60)}`);
      errors.push({ pageId: page.id, title: page.title, error: err.message });
    }
  }

  // Step 3: Write output
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outputFile = resolve(OUTPUT_DIR, `notion-crawl-${timestamp}.json`);

  const output = {
    metadata: {
      crawledAt: new Date().toISOString(),
      mode: FLAG_INCREMENTAL ? "incremental" : "full",
      productId: PRODUCT_ID,
      totalPagesInWorkspace: pages.length,
      activePages: activePages.length,
      trashedPages: trashedPages.length,
      pagesCrawled: pagesToCrawl.length,
      pagesExtracted: results.length,
      pagesSkipped: pagesToCrawl.length - results.length - errors.length,
      pagesErrored: errors.length,
      totalChunks: results.reduce((sum, r) => sum + r.chunks.length, 0),
      totalChars: results.reduce((sum, r) => sum + r.fullTextLength, 0),
      apiRequests: requestCount,
    },
    pages: results,
    errors,
  };

  writeFileSync(outputFile, JSON.stringify(output, null, 2));

  // Save state for incremental crawls
  writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2));

  // Summary
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  CRAWL COMPLETE");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Pages extracted: ${results.length}`);
  console.log(`  Total chunks: ${output.metadata.totalChunks}`);
  console.log(`  Total characters: ${output.metadata.totalChars.toLocaleString()}`);
  console.log(`  Errors: ${errors.length}`);
  console.log(`  API requests: ${requestCount}`);
  console.log(`  Output: ${outputFile}`);
  console.log(`  State: ${STATE_FILE}`);

  if (errors.length > 0) {
    console.log("\n  ⚠ Errors:");
    for (const e of errors) {
      console.log(`    ${e.title}: ${e.error.slice(0, 80)}`);
    }
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
