import type { DbClient } from "@orkiva/db";
import { triggerJobs } from "@orkiva/db";
import { eq } from "drizzle-orm";

export type TriggerJobStatus =
  | "queued"
  | "triggering"
  | "deferred"
  | "delivered"
  | "timeout"
  | "failed"
  | "fallback_resume"
  | "fallback_spawn"
  | "callback_pending"
  | "callback_retry"
  | "callback_delivered"
  | "callback_failed";

export interface TriggerJobRecord {
  triggerId: string;
  threadId: string;
  workspaceId: string;
  targetAgentId: string;
  targetSessionId: string | null;
  reason: string;
  prompt: string;
  status: TriggerJobStatus;
  attempts: number;
  maxRetries: number;
  nextRetryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOrReuseTriggerJobInput {
  triggerId: string;
  threadId: string;
  workspaceId: string;
  targetAgentId: string;
  targetSessionId: string | null;
  reason: string;
  prompt: string;
  status: TriggerJobStatus;
  attempts: number;
  maxRetries: number;
  nextRetryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOrReuseTriggerJobResult {
  record: TriggerJobRecord;
  created: boolean;
}

export interface TriggerStore {
  createOrReuseTriggerJob(
    input: CreateOrReuseTriggerJobInput
  ): Promise<CreateOrReuseTriggerJobResult>;
}

const toTriggerJobRecord = (row: {
  triggerId: string;
  threadId: string;
  workspaceId: string;
  targetAgentId: string;
  targetSessionId: string | null;
  reason: string;
  prompt: string;
  status: TriggerJobStatus;
  attempts: number;
  maxRetries: number;
  nextRetryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): TriggerJobRecord => ({
  triggerId: row.triggerId,
  threadId: row.threadId,
  workspaceId: row.workspaceId,
  targetAgentId: row.targetAgentId,
  targetSessionId: row.targetSessionId,
  reason: row.reason,
  prompt: row.prompt,
  status: row.status,
  attempts: row.attempts,
  maxRetries: row.maxRetries,
  nextRetryAt: row.nextRetryAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

export class InMemoryTriggerStore implements TriggerStore {
  private readonly jobs = new Map<string, TriggerJobRecord>();

  public createOrReuseTriggerJob(
    input: CreateOrReuseTriggerJobInput
  ): Promise<CreateOrReuseTriggerJobResult> {
    const existing = this.jobs.get(input.triggerId);
    if (existing !== undefined) {
      return Promise.resolve({
        record: existing,
        created: false
      });
    }

    const created = toTriggerJobRecord(input);
    this.jobs.set(created.triggerId, created);

    return Promise.resolve({
      record: created,
      created: true
    });
  }
}

export class DbTriggerStore implements TriggerStore {
  public constructor(private readonly db: DbClient) {}

  public async createOrReuseTriggerJob(
    input: CreateOrReuseTriggerJobInput
  ): Promise<CreateOrReuseTriggerJobResult> {
    const inserted = await this.db
      .insert(triggerJobs)
      .values({
        triggerId: input.triggerId,
        threadId: input.threadId,
        workspaceId: input.workspaceId,
        targetAgentId: input.targetAgentId,
        ...(input.targetSessionId === null
          ? { targetSessionId: null }
          : { targetSessionId: input.targetSessionId }),
        reason: input.reason,
        prompt: input.prompt,
        status: input.status,
        attempts: input.attempts,
        maxRetries: input.maxRetries,
        ...(input.nextRetryAt === null
          ? { nextRetryAt: null }
          : { nextRetryAt: input.nextRetryAt }),
        createdAt: input.createdAt,
        updatedAt: input.updatedAt
      })
      .onConflictDoNothing()
      .returning({
        triggerId: triggerJobs.triggerId,
        threadId: triggerJobs.threadId,
        workspaceId: triggerJobs.workspaceId,
        targetAgentId: triggerJobs.targetAgentId,
        targetSessionId: triggerJobs.targetSessionId,
        reason: triggerJobs.reason,
        prompt: triggerJobs.prompt,
        status: triggerJobs.status,
        attempts: triggerJobs.attempts,
        maxRetries: triggerJobs.maxRetries,
        nextRetryAt: triggerJobs.nextRetryAt,
        createdAt: triggerJobs.createdAt,
        updatedAt: triggerJobs.updatedAt
      });

    const firstInserted = inserted[0];
    if (firstInserted) {
      return {
        record: toTriggerJobRecord(firstInserted),
        created: true
      };
    }

    const existing = await this.db.query.triggerJobs.findFirst({
      where: (table) => eq(table.triggerId, input.triggerId),
      columns: {
        triggerId: true,
        threadId: true,
        workspaceId: true,
        targetAgentId: true,
        targetSessionId: true,
        reason: true,
        prompt: true,
        status: true,
        attempts: true,
        maxRetries: true,
        nextRetryAt: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (!existing) {
      throw new Error(`Failed to read trigger job after conflict: ${input.triggerId}`);
    }

    return {
      record: toTriggerJobRecord(existing),
      created: false
    };
  }
}
