import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@orkiva/auth",
        replacement: fileURLToPath(new URL("./packages/auth/src/index.ts", import.meta.url))
      },
      {
        find: "@orkiva/db",
        replacement: fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url))
      },
      {
        find: "@orkiva/domain",
        replacement: fileURLToPath(new URL("./packages/domain/src/index.ts", import.meta.url))
      },
      {
        find: "@orkiva/protocol",
        replacement: fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url))
      },
      {
        find: "@orkiva/observability",
        replacement: fileURLToPath(
          new URL("./packages/observability/src/index.ts", import.meta.url)
        )
      },
      {
        find: "@orkiva/shared",
        replacement: fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url))
      }
    ]
  },
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
