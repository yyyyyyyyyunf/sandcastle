import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["acceptance/fixtures/*.test.ts"],
    setupFiles: ["src/testSetup.ts"],
    testTimeout: 60000,
  },
});
