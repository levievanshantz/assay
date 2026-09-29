// Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0), using only
// node: builtins, for driving the built plugin/scripts/mcp-server.cjs the way
// Claude Code does: spawn `node mcp-server.cjs`, initialize, then call tools.

import { spawn } from "node:child_process";
import { once } from "node:events";

export function startMcpServer(script, env) {
  const child = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buf = "";
  let stderr = "";
  let nextId = 1;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    stderr += d;
  });

  function request(method, params = {}, timeoutMs = 15_000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out; server stderr: ${stderr}`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`MCP ${method} error: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  return {
    child,
    get stderr() {
      return stderr;
    },
    async initialize() {
      const result = await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "assay-tests", version: "0" },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return result;
    },
    listTools() {
      return request("tools/list");
    },
    /** Returns { isError, text, json } for a tools/call. */
    async callTool(name, args = {}) {
      const result = await request("tools/call", { name, arguments: args });
      const text = result?.content?.[0]?.text ?? "";
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON (e.g. __IMPORTANT returns markdown)
      }
      return { isError: result?.isError === true, text, json };
    },
    async close() {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.stdin.end();
      child.kill("SIGTERM");
      await exited;
    },
  };
}
