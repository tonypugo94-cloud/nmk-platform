import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globalSetup: ["./tests/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 20000,
    include: ["tests/**/*.test.ts", "services/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
  },
});
