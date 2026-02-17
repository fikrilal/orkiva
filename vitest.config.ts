import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    passWithNoTests: true,
    include: [
      "**/test/**/*.test.ts",
      "**/test/**/*.spec.ts",
      "**/src/**/*.test.ts",
      "**/src/**/*.spec.ts"
    ]
  }
});
