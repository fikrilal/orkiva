import path from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";

import { createDb, createDbPool } from "./client.js";
import {
  DbConfigValidationError,
  formatDbConfigValidationError,
  loadDbRuntimeConfig
} from "./config.js";

const run = async (): Promise<void> => {
  let pool: Pool | undefined;
  try {
    const config = loadDbRuntimeConfig(process.env);
    pool = createDbPool(config.DATABASE_URL);
    const db = createDb(pool);

    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const migrationsFolder = path.resolve(currentDir, "../migrations");

    await migrate(db, { migrationsFolder });
    console.log("[db:migrate] migrations applied successfully");
  } catch (error) {
    if (error instanceof DbConfigValidationError) {
      console.error(formatDbConfigValidationError(error));
    } else if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("Database migration failed with an unknown error.");
    }
    throw error;
  } finally {
    await pool?.end();
  }
};

run().catch(() => {
  process.exit(1);
});
