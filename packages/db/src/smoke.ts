import { createDbPool } from "./client.js";
import {
  DbConfigValidationError,
  formatDbConfigValidationError,
  loadDbRuntimeConfig
} from "./config.js";
import type { Pool } from "pg";

const requiredTables = [
  "threads",
  "thread_participants",
  "messages",
  "participant_cursors",
  "session_registry",
  "trigger_jobs",
  "trigger_attempts",
  "trigger_fallback_runs",
  "audit_events"
] as const;

const run = async (): Promise<void> => {
  let pool: Pool | undefined;
  try {
    const config = loadDbRuntimeConfig(process.env);
    pool = createDbPool(config.DATABASE_URL);

    const missingTables: string[] = [];
    for (const table of requiredTables) {
      const result = await pool.query<{ exists: boolean }>(
        `select exists (
          select 1 from information_schema.tables
          where table_schema = 'public'
            and table_name = $1
        ) as exists`,
        [table]
      );

      if (!result.rows[0]?.exists) {
        missingTables.push(table);
      }
    }

    if (missingTables.length > 0) {
      throw new Error(`Missing required tables: ${missingTables.join(", ")}`);
    }

    console.log(`[db:smoke] schema validation passed (${requiredTables.length} tables present)`);
  } catch (error) {
    if (error instanceof DbConfigValidationError) {
      console.error(formatDbConfigValidationError(error));
    } else if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("Database smoke check failed with an unknown error.");
    }
    throw error;
  } finally {
    await pool?.end();
  }
};

run().catch(() => {
  process.exit(1);
});
