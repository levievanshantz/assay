// Assay MCP server bundle entry. esbuild bundles this file (+ all imports
// except better-sqlite3, which is external and resolved at runtime from
// plugin/node_modules/) into plugin/scripts/mcp-server.cjs.
//
// stdio transport. Exposes 3 tools:
//   - assay_decision_recall
//   - assay_decision_expand
//   - assay_brief_render
// plus __IMPORTANT, which carries the capture protocol (src/mcp/protocol.ts).
//
// Run as a script (node mcp-server.cjs) it opens ~/.assay/decisions.db and
// serves over stdio. require()d, it only exports TOOLS / callTool /
// createServer / main, so tests can load the built bundle without it opening
// a database or taking over stdin/stdout.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { AssayMCPServer } from "../dist/mcp/server.js";
import {
  DECISION_CAPTURE_PROTOCOL,
  IMPORTANT_TOOL_DESCRIPTION,
} from "../dist/mcp/protocol.js";

export { AssayMCPServer, DECISION_CAPTURE_PROTOCOL };

// scripts/build-plugin.mjs replaces __ASSAY_VERSION__ with package.json's version.
// eslint-disable-next-line no-undef
export const VERSION = typeof __ASSAY_VERSION__ === "string" ? __ASSAY_VERSION__ : "0.0.0-dev";

// __IMPORTANT is a behavior-coercion tool inspired by claude-mem. Its
// description is the short form of the capture protocol — Claude reads it as
// part of the tool list at session start. Calling it returns the full
// protocol text. The leading underscores sort it first lexicographically so
// it appears at the top of the tool listing.
export const TOOLS = [
  {
    name: "__IMPORTANT",
    description: IMPORTANT_TOOL_DESCRIPTION,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "assay_decision_recall",
    description:
      "Recall typed decisions from the Assay decision graph. Returns cited decisions with supersession chains and (when available) enrichment from the claude-mem memory substrate. Use when asked 'what did we decide about X' or before re-deriving a past decision.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language query about a past decision" },
        limit: { type: "number", description: "Max results (default 10)", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "assay_decision_expand",
    description:
      "Lazily fetch enrichment for ranks 4-10 of a prior recall. Use after assay_decision_recall when the top-3 enriched results aren't enough.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Original recall query" },
        decision_ids: {
          type: "array",
          items: { type: "string" },
          description: "Decision IDs from the prior recall result to enrich",
        },
      },
      required: ["query", "decision_ids"],
    },
  },
  {
    name: "assay_brief_render",
    description:
      "Compose a cited brief from the decision graph on a given topic. Returns a synthesized verdict with citations to specific decisions and evidence. Returns a refusal envelope when confidence is low.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic to brief on" },
      },
      required: ["topic"],
    },
  },
];

/** Handle one tools/call. Returns an MCP CallTool result. */
export async function callTool(assay, name, args) {
  try {
    if (name === "__IMPORTANT") {
      return { content: [{ type: "text", text: DECISION_CAPTURE_PROTOCOL }] };
    }
    let payload;
    if (name === "assay_decision_recall") {
      payload = await assay.recall(args.query, { limit: args.limit });
    } else if (name === "assay_decision_expand") {
      payload = await assay.expand(args.query, args.decision_ids);
    } else if (name === "assay_brief_render") {
      payload = await assay.brief(args.topic);
    } else {
      return {
        content: [{ type: "text", text: `unknown tool: ${name}` }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `error: ${err.message}` }],
      isError: true,
    };
  }
}

export function createServer(assay) {
  const server = new Server(
    { name: "assay", version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    callTool(assay, req.params.name, req.params.arguments),
  );
  return server;
}

export async function main() {
  const assay = new AssayMCPServer();
  const server = createServer(assay);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    try { await assay.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[assay] mcp server crashed: ${err.message}\n`);
    process.exit(1);
  });
}
