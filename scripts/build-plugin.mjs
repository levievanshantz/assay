#!/usr/bin/env node
// Build self-contained plugin bundles + vendor the better-sqlite3 native
// dep so the plugin works after `claude plugin install` with no other setup.
//
//   plugin/scripts/mcp-server.cjs   ← esbuild bundle of plugin-src/mcp-server-entry.mjs
//   plugin/scripts/stop-hook.cjs    ← esbuild bundle of plugin-src/stop-hook-entry.mjs
//   plugin/node_modules/better-sqlite3/  ← vendored native module
//   plugin/node_modules/bindings/        ← peer of better-sqlite3
//   plugin/node_modules/file-uri-to-path/ ← peer of bindings
//
//   node scripts/build-plugin.mjs --check
//     Rebuilds both bundles into a temp dir and exits 1 if either differs from
//     the committed plugin/scripts/*.cjs (i.e. the bundles are stale relative
//     to src/ + plugin-src/). Does not touch plugin/. Run `npm run build` first.

import { build } from "esbuild";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pluginDir = resolve(root, "plugin");
const scriptsDir = resolve(pluginDir, "scripts");
const pluginNodeModules = resolve(pluginDir, "node_modules");

const EXTERNALS = ["better-sqlite3", "bindings", "file-uri-to-path"];
const VERSION = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;

const BUNDLES = [
  ["plugin-src/mcp-server-entry.mjs", "mcp-server.cjs"],
  ["plugin-src/stop-hook-entry.mjs", "stop-hook.cjs"],
];

async function bundle(entry, outfile, { quiet = false } = {}) {
  await build({
    // Pin the working dir: esbuild writes source-path comments relative to it,
    // and --check needs byte-identical output wherever it is run from.
    absWorkingDir: root,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: EXTERNALS,
    minify: false,
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
    define: { __ASSAY_VERSION__: JSON.stringify(VERSION) },
    logLevel: "warning",
  });
  if (!quiet) console.log(`  bundled → ${outfile}`);
}

// Drop SQLite C source and other build-from-source artifacts that only
// matter when better-sqlite3 needs to be compiled (we ship the prebuilt
// .node binary, so they're dead weight). Keeps the vendored size to ~3MB
// instead of ~12MB.
const PRUNE_PATHS = ["deps", "src", "binding.gyp", "README.md"];

async function vendor(dep) {
  const src = resolve(root, "node_modules", dep);
  const dst = resolve(pluginNodeModules, dep);
  if (!existsSync(src)) {
    throw new Error(`missing node_modules/${dep} — run \`npm install\` first`);
  }
  await rm(dst, { recursive: true, force: true });
  await cp(src, dst, { recursive: true, dereference: true });
  for (const p of PRUNE_PATHS) {
    await rm(resolve(dst, p), { recursive: true, force: true });
  }
  console.log(`  vendored → plugin/node_modules/${dep}`);
}

async function check() {
  const out = await mkdtemp(join(tmpdir(), "assay-bundle-check-"));
  let stale = 0;
  try {
    for (const [entry, name] of BUNDLES) {
      await bundle(resolve(root, entry), join(out, name), { quiet: true });
      const fresh = await readFile(join(out, name));
      const committedPath = resolve(scriptsDir, name);
      const committed = existsSync(committedPath) ? await readFile(committedPath) : null;
      if (committed && committed.equals(fresh)) {
        console.log(`  up to date: plugin/scripts/${name}`);
      } else {
        stale++;
        console.log(`  STALE: plugin/scripts/${name} does not match a fresh build of ${entry}`);
      }
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
  if (stale > 0) {
    console.log("Run `npm run build:plugin` and commit plugin/scripts/.");
    process.exit(1);
  }
  console.log("Plugin bundles match source.");
}

async function main() {
  if (process.argv.includes("--check")) return check();

  console.log(`Building plugin bundles (v${VERSION})…`);
  await mkdir(scriptsDir, { recursive: true });
  for (const [entry, name] of BUNDLES) {
    await bundle(resolve(root, entry), resolve(scriptsDir, name));
  }

  console.log("Vendoring native deps…");
  await mkdir(pluginNodeModules, { recursive: true });
  for (const dep of EXTERNALS) {
    await vendor(dep);
  }

  console.log("Plugin build complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
