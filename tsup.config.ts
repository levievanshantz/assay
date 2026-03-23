import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "es2022",
  outDir: "dist",
  noExternal: [/^(?!pg$|@anthropic-ai|openai|@modelcontextprotocol|zod|uuid|dotenv)/],
  splitting: false,
  sourcemap: true,
  clean: true,
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});
