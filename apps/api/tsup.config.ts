import { defineConfig } from "tsup";

// Workspace packages (@uap/*) ship TypeScript source, so they are bundled in.
// Every npm package stays external and must be a direct dependency of this app
// so it resolves at runtime (pnpm does not hoist transitive deps).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node24",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  noExternal: [/^@uap\//],
  external: [/^(?!@uap\/)(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*(\/.*)?$/],
});
