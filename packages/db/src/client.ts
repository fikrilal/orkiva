import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.js";

export const createDbPool = (databaseUrl: string): Pool =>
  new Pool({
    connectionString: databaseUrl
  });

export const createDb = (pool: Pool): NodePgDatabase<typeof schema> =>
  drizzle(pool, {
    schema
  });

export type DbClient = ReturnType<typeof createDb>;
