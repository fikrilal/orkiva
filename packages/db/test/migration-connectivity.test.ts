import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDbPool } from "../src/client.js";
import { loadDbRuntimeConfig } from "../src/config.js";

const runIntegration =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" && Boolean(process.env.DATABASE_URL);

const describeDb = runIntegration ? describe : describe.skip;

describeDb("database migration connectivity", () => {
  const config = loadDbRuntimeConfig(process.env);
  const pool = createDbPool(config.DATABASE_URL);

  beforeAll(async () => {
    await pool.query("select 1");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("contains the required MVP tables", async () => {
    const result = await pool.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'threads',
            'thread_participants',
            'messages',
            'participant_cursors',
            'session_registry',
            'trigger_jobs',
            'trigger_attempts',
            'trigger_fallback_runs',
            'audit_events'
          )`
    );

    const actual = new Set(result.rows.map((row) => row.table_name));

    expect(actual.has("threads")).toBe(true);
    expect(actual.has("thread_participants")).toBe(true);
    expect(actual.has("messages")).toBe(true);
    expect(actual.has("participant_cursors")).toBe(true);
    expect(actual.has("session_registry")).toBe(true);
    expect(actual.has("trigger_jobs")).toBe(true);
    expect(actual.has("trigger_attempts")).toBe(true);
    expect(actual.has("trigger_fallback_runs")).toBe(true);
    expect(actual.has("audit_events")).toBe(true);
  });
});
