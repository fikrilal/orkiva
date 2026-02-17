import { createDbPool } from "./client.js";
import {
  DbConfigValidationError,
  formatDbConfigValidationError,
  loadDbRuntimeConfig
} from "./config.js";
import type { Pool } from "pg";

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const run = async (): Promise<void> => {
  let pool: Pool | undefined;
  try {
    const config = loadDbRuntimeConfig(process.env);
    pool = createDbPool(config.DATABASE_URL);

    for (let attempt = 1; attempt <= config.DB_READY_MAX_ATTEMPTS; attempt += 1) {
      try {
        await pool.query("select 1");
        console.log(`[db:ready] database is ready after ${attempt} attempt(s)`);
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (attempt === config.DB_READY_MAX_ATTEMPTS) {
          throw new Error(`[db:ready] exhausted retries: ${reason}`);
        }

        console.log(
          `[db:ready] attempt ${attempt}/${config.DB_READY_MAX_ATTEMPTS} failed (${reason}), retrying in ${config.DB_READY_INTERVAL_MS}ms`
        );
        await sleep(config.DB_READY_INTERVAL_MS);
      }
    }
  } catch (error) {
    if (error instanceof DbConfigValidationError) {
      console.error(formatDbConfigValidationError(error));
    } else if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("Database readiness probe failed with an unknown error.");
    }
    throw error;
  } finally {
    await pool?.end();
  }
};

run().catch(() => {
  process.exit(1);
});
