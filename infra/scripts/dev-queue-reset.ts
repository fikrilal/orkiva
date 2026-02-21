import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { createDb, createDbPool } from "../../packages/db/src/client.js";
import { loadDbRuntimeConfig } from "../../packages/db/src/config.js";
import { triggerJobs } from "../../packages/db/src/schema.js";

const EXECUTION_PENDING_STATUSES = [
  "queued",
  "triggering",
  "deferred",
  "timeout",
  "fallback_resume",
  "fallback_spawn"
] as const;
const CALLBACK_PENDING_STATUSES = ["callback_pending", "callback_retry"] as const;
const RESETTABLE_PENDING_STATUSES = [
  ...EXECUTION_PENDING_STATUSES,
  ...CALLBACK_PENDING_STATUSES
] as const;

type PendingStatus = (typeof RESETTABLE_PENDING_STATUSES)[number];

interface CliArgs {
  workspaceId: string;
  dryRun: boolean;
  apply: boolean;
}

interface PendingSummaryRow {
  status: PendingStatus;
  targetAgentId: string;
  count: number;
}

const usage = (): string =>
  [
    "Usage:",
    "  pnpm run dev:queue:reset -- --workspace-id <id> [--dry-run] [--apply]",
    "",
    "Examples:",
    "  pnpm run dev:queue:reset -- --workspace-id wk_local",
    "  pnpm run dev:queue:reset -- --workspace-id wk_local --apply"
  ].join("\n");

const parseCliArgs = (argv: readonly string[]): CliArgs => {
  let workspaceId: string | null = null;
  let dryRun = true;
  let apply = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--workspace-id") {
      workspaceId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--apply") {
      apply = true;
      dryRun = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (workspaceId === null || workspaceId.trim().length === 0) {
    throw new Error("--workspace-id is required");
  }

  return {
    workspaceId,
    dryRun,
    apply
  };
};

const loadPendingSummary = async (workspaceId: string): Promise<readonly PendingSummaryRow[]> => {
  const config = loadDbRuntimeConfig(process.env);
  const dbPool = createDbPool(config.DATABASE_URL);
  const db = createDb(dbPool);

  try {
    const rows = await db
      .select({
        status: triggerJobs.status,
        targetAgentId: triggerJobs.targetAgentId,
        count: sql<number>`count(*)::int`
      })
      .from(triggerJobs)
      .where(
        and(
          eq(triggerJobs.workspaceId, workspaceId),
          inArray(triggerJobs.status, [...RESETTABLE_PENDING_STATUSES])
        )
      )
      .groupBy(triggerJobs.status, triggerJobs.targetAgentId)
      .orderBy(asc(triggerJobs.status), asc(triggerJobs.targetAgentId));

    return rows.map((row) => ({
      status: row.status as PendingStatus,
      targetAgentId: row.targetAgentId,
      count: Number(row.count)
    }));
  } finally {
    await dbPool.end();
  }
};

const printSummary = (rows: readonly PendingSummaryRow[]): void => {
  if (rows.length === 0) {
    process.stdout.write("No resettable pending jobs found.\n");
    return;
  }

  process.stdout.write("Pending jobs by status and target agent:\n");
  process.stdout.write("status\ttarget_agent_id\tcount\n");
  for (const row of rows) {
    process.stdout.write(`${row.status}\t${row.targetAgentId}\t${row.count}\n`);
  }

  const totalsByStatus = new Map<PendingStatus, number>();
  for (const row of rows) {
    totalsByStatus.set(row.status, (totalsByStatus.get(row.status) ?? 0) + row.count);
  }

  process.stdout.write("\nTotals by status:\n");
  for (const status of RESETTABLE_PENDING_STATUSES) {
    const total = totalsByStatus.get(status) ?? 0;
    process.stdout.write(`- ${status}: ${total}\n`);
  }
};

const applyReset = async (
  workspaceId: string
): Promise<{
  executionResetCount: number;
  callbackResetCount: number;
}> => {
  const config = loadDbRuntimeConfig(process.env);
  const dbPool = createDbPool(config.DATABASE_URL);
  const db = createDb(dbPool);
  const now = new Date();

  try {
    const result = await db.transaction(async (tx) => {
      const executionResetRows = await tx
        .update(triggerJobs)
        .set({
          status: "failed",
          updatedAt: now
        })
        .where(
          and(
            eq(triggerJobs.workspaceId, workspaceId),
            inArray(triggerJobs.status, [...EXECUTION_PENDING_STATUSES])
          )
        )
        .returning({
          triggerId: triggerJobs.triggerId
        });

      const callbackResetRows = await tx
        .update(triggerJobs)
        .set({
          status: "callback_failed",
          updatedAt: now
        })
        .where(
          and(
            eq(triggerJobs.workspaceId, workspaceId),
            inArray(triggerJobs.status, [...CALLBACK_PENDING_STATUSES])
          )
        )
        .returning({
          triggerId: triggerJobs.triggerId
        });

      return {
        executionResetCount: executionResetRows.length,
        callbackResetCount: callbackResetRows.length
      };
    });

    return result;
  } finally {
    await dbPool.end();
  }
};

const main = async (): Promise<void> => {
  const args = parseCliArgs(process.argv.slice(2));

  process.stdout.write(`workspace_id=${args.workspaceId}\n`);
  process.stdout.write(`mode=${args.apply ? "apply" : "dry-run"}\n\n`);

  const before = await loadPendingSummary(args.workspaceId);
  process.stdout.write("Before reset:\n");
  printSummary(before);

  if (!args.apply && args.dryRun) {
    process.stdout.write("\nDry run complete. Re-run with --apply to persist changes.\n");
    return;
  }

  const result = await applyReset(args.workspaceId);
  process.stdout.write(
    `\nApplied reset: execution->failed=${result.executionResetCount}, callback->callback_failed=${result.callbackResetCount}\n`
  );

  const after = await loadPendingSummary(args.workspaceId);
  process.stdout.write("\nAfter reset:\n");
  printSummary(after);
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n\n${usage()}\n`);
  process.exitCode = 1;
});
