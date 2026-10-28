import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/test/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
      "agents/*/test/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    environment: "node",
    // MongoMemoryServer downloads a mongod binary on first run.
    hookTimeout: 120_000,
    testTimeout: 20_000,
  },
});
