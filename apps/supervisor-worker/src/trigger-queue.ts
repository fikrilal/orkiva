import type { DbClient } from "@orkiva/db";
import { triggerAttempts, triggerJobs } from "@orkiva/db";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";

export type TriggerJobStatus =
  | "queued"
  | "triggering"
  | "deferred"
  | "delivered"
  | "timeout"
  | "failed"
  | "fallback_resume"
  | "fallback_spawn";
export type TriggerAttemptResult =
  | "delivered"
  | "deferred"
  | "timeout"
  | "failed"
  | "fallback_resume_started"
  | "fallback_resume_succeeded"
  | "fallback_resume_failed"
  | "fallback_spawned";

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

const DUE_TRIGGER_STATUSES: readonly TriggerJobStatus[] = ["queued", "timeout", "deferred"];

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

export interface TriggerQueueStore {
  claimDueJobs(input: {
    workspaceId: string;
    limit: number;
    claimedAt: Date;
  }): Promise<readonly TriggerJobRecord[]>;
  recordAttemptAndTransition(input: {
    triggerId: string;
    attemptNo: number;
    attemptResult: TriggerAttemptResult;
    errorCode?: string;
    details?: Record<string, unknown>;
    nextStatus: TriggerJobStatus;
    nextRetryAt: Date | null;
    transitionedAt: Date;
  }): Promise<TriggerJobRecord | null>;
  listDeadLetterJobs(input: {
    workspaceId: string;
    limit: number;
  }): Promise<readonly TriggerJobRecord[]>;
  getJobById(triggerId: string): Promise<TriggerJobRecord | null>;
}

const toTransitionStatusForRetry = (attemptResult: TriggerAttemptResult): TriggerJobStatus => {
  if (attemptResult === "deferred") {
    return "deferred";
  }

  if (attemptResult === "timeout") {
    return "timeout";
  }

  return "failed";
};

export interface TriggerExecutionOutcome {
  attemptResult: TriggerAttemptResult;
  retryable: boolean;
  errorCode?: string;
  details?: Record<string, unknown>;
}

export interface TriggerJobExecutor {
  execute(input: {
    job: TriggerJobRecord;
    attemptNo: number;
    now: Date;
  }): Promise<TriggerExecutionOutcome>;
}

export class NotImplementedTriggerJobExecutor implements TriggerJobExecutor {
  public execute(input: {
    job: TriggerJobRecord;
    attemptNo: number;
    now: Date;
  }): Promise<TriggerExecutionOutcome> {
    void input;
    return Promise.resolve({
      attemptResult: "timeout",
      retryable: true,
      errorCode: "PENDING_PTY_ADAPTER"
    });
  }
}

export interface TriggerQueueProcessingResult {
  workspaceId: string;
  processedAt: Date;
  claimedJobs: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  failed: number;
  deadLetterJobIds: readonly string[];
}

export class TriggerQueueProcessor {
  public constructor(
    private readonly store: TriggerQueueStore,
    private readonly executor: TriggerJobExecutor,
    private readonly backoffBaseMs = 2000,
    private readonly backoffMaxMs = 60000
  ) {}

  private computeBackoffMs(attemptNo: number): number {
    const raw = this.backoffBaseMs * 2 ** Math.max(attemptNo - 1, 0);
    return Math.min(raw, this.backoffMaxMs);
  }

  public async processDueJobs(input: {
    workspaceId: string;
    limit: number;
    processedAt?: Date;
  }): Promise<TriggerQueueProcessingResult> {
    const processedAt = input.processedAt ?? new Date();
    const claimedJobs = await this.store.claimDueJobs({
      workspaceId: input.workspaceId,
      limit: input.limit,
      claimedAt: processedAt
    });

    let delivered = 0;
    let retried = 0;
    let deadLettered = 0;
    let failed = 0;

    for (const job of claimedJobs) {
      const attemptNo = job.attempts + 1;
      const outcome = await this.executor.execute({
        job,
        attemptNo,
        now: processedAt
      });

      const shouldRetry = outcome.retryable && attemptNo <= job.maxRetries;
      const nextStatus: TriggerJobStatus =
        outcome.attemptResult === "delivered"
          ? "delivered"
          : shouldRetry
            ? toTransitionStatusForRetry(outcome.attemptResult)
            : "failed";
      const nextRetryAt =
        outcome.attemptResult === "delivered" || !shouldRetry
          ? null
          : new Date(processedAt.getTime() + this.computeBackoffMs(attemptNo));

      await this.store.recordAttemptAndTransition({
        triggerId: job.triggerId,
        attemptNo,
        attemptResult: outcome.attemptResult,
        ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
        ...(outcome.details === undefined ? {} : { details: outcome.details }),
        nextStatus,
        nextRetryAt,
        transitionedAt: processedAt
      });

      if (outcome.attemptResult === "delivered") {
        delivered += 1;
      } else if (shouldRetry) {
        retried += 1;
      } else {
        failed += 1;
        if (nextStatus === "failed") {
          deadLettered += 1;
        }
      }
    }

    const deadLetter = await this.store.listDeadLetterJobs({
      workspaceId: input.workspaceId,
      limit: 20
    });

    return {
      workspaceId: input.workspaceId,
      processedAt,
      claimedJobs: claimedJobs.length,
      delivered,
      retried,
      deadLettered,
      failed,
      deadLetterJobIds: deadLetter.map((job) => job.triggerId)
    };
  }
}

const triggerKey = (triggerId: string): string => triggerId;

export class InMemoryTriggerQueueStore implements TriggerQueueStore {
  private readonly jobs = new Map<string, TriggerJobRecord>();
  private readonly attemptsByTrigger = new Map<
    string,
    Array<{
      attemptNo: number;
      attemptResult: TriggerAttemptResult;
      errorCode?: string;
      details?: Record<string, unknown>;
      createdAt: Date;
    }>
  >();

  public constructor(seedJobs: readonly TriggerJobRecord[] = []) {
    for (const job of seedJobs) {
      this.jobs.set(triggerKey(job.triggerId), { ...job });
    }
  }

  public claimDueJobs(input: {
    workspaceId: string;
    limit: number;
    claimedAt: Date;
  }): Promise<readonly TriggerJobRecord[]> {
    const due = [...this.jobs.values()]
      .filter((job) => job.workspaceId === input.workspaceId)
      .filter((job) => DUE_TRIGGER_STATUSES.includes(job.status))
      .filter(
        (job) => job.nextRetryAt === null || job.nextRetryAt.getTime() <= input.claimedAt.getTime()
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .slice(0, input.limit);

    const claimed: TriggerJobRecord[] = [];
    for (const candidate of due) {
      const current = this.jobs.get(triggerKey(candidate.triggerId));
      if (!current) {
        continue;
      }
      if (current.status !== candidate.status) {
        continue;
      }
      if (current.updatedAt.getTime() !== candidate.updatedAt.getTime()) {
        continue;
      }

      const triggering: TriggerJobRecord = {
        ...current,
        status: "triggering",
        updatedAt: input.claimedAt
      };
      this.jobs.set(triggerKey(triggering.triggerId), triggering);
      claimed.push(triggering);
    }

    return Promise.resolve(claimed);
  }

  public recordAttemptAndTransition(input: {
    triggerId: string;
    attemptNo: number;
    attemptResult: TriggerAttemptResult;
    errorCode?: string;
    details?: Record<string, unknown>;
    nextStatus: TriggerJobStatus;
    nextRetryAt: Date | null;
    transitionedAt: Date;
  }): Promise<TriggerJobRecord | null> {
    const current = this.jobs.get(triggerKey(input.triggerId));
    if (!current || current.status !== "triggering") {
      return Promise.resolve(null);
    }

    const attempts = this.attemptsByTrigger.get(input.triggerId) ?? [];
    attempts.push({
      attemptNo: input.attemptNo,
      attemptResult: input.attemptResult,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.details === undefined ? {} : { details: input.details }),
      createdAt: input.transitionedAt
    });
    this.attemptsByTrigger.set(input.triggerId, attempts);

    const updated: TriggerJobRecord = {
      ...current,
      attempts: input.attemptNo,
      status: input.nextStatus,
      nextRetryAt: input.nextRetryAt,
      updatedAt: input.transitionedAt
    };
    this.jobs.set(triggerKey(input.triggerId), updated);
    return Promise.resolve(updated);
  }

  public listDeadLetterJobs(input: {
    workspaceId: string;
    limit: number;
  }): Promise<readonly TriggerJobRecord[]> {
    return Promise.resolve(
      [...this.jobs.values()]
        .filter((job) => job.workspaceId === input.workspaceId && job.status === "failed")
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
        .slice(0, input.limit)
    );
  }

  public getJobById(triggerId: string): Promise<TriggerJobRecord | null> {
    return Promise.resolve(this.jobs.get(triggerKey(triggerId)) ?? null);
  }
}

export class DbTriggerQueueStore implements TriggerQueueStore {
  public constructor(private readonly db: DbClient) {}

  public async claimDueJobs(input: {
    workspaceId: string;
    limit: number;
    claimedAt: Date;
  }): Promise<readonly TriggerJobRecord[]> {
    const candidates = await this.db.query.triggerJobs.findMany({
      where: (table) =>
        and(
          eq(table.workspaceId, input.workspaceId),
          inArray(table.status, [...DUE_TRIGGER_STATUSES]),
          or(isNull(table.nextRetryAt), lte(table.nextRetryAt, input.claimedAt))
        ),
      orderBy: (table) => [asc(table.createdAt)],
      limit: Math.max(input.limit * 3, input.limit)
    });

    const claimed: TriggerJobRecord[] = [];
    for (const candidate of candidates) {
      if (claimed.length >= input.limit) {
        break;
      }
      const updated = await this.db
        .update(triggerJobs)
        .set({
          status: "triggering",
          updatedAt: input.claimedAt
        })
        .where(
          and(
            eq(triggerJobs.triggerId, candidate.triggerId),
            eq(triggerJobs.status, candidate.status),
            eq(triggerJobs.updatedAt, candidate.updatedAt)
          )
        )
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
      const firstUpdated = updated[0];
      if (!firstUpdated) {
        continue;
      }

      claimed.push(toTriggerJobRecord(firstUpdated));
    }

    return claimed;
  }

  public async recordAttemptAndTransition(input: {
    triggerId: string;
    attemptNo: number;
    attemptResult: TriggerAttemptResult;
    errorCode?: string;
    details?: Record<string, unknown>;
    nextStatus: TriggerJobStatus;
    nextRetryAt: Date | null;
    transitionedAt: Date;
  }): Promise<TriggerJobRecord | null> {
    return this.db.transaction(async (tx) => {
      await tx.insert(triggerAttempts).values({
        triggerId: input.triggerId,
        attemptNo: input.attemptNo,
        result: input.attemptResult,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.details === undefined ? {} : { details: input.details }),
        createdAt: input.transitionedAt
      });

      const updated = await tx
        .update(triggerJobs)
        .set({
          attempts: input.attemptNo,
          status: input.nextStatus,
          nextRetryAt: input.nextRetryAt,
          updatedAt: input.transitionedAt
        })
        .where(
          and(eq(triggerJobs.triggerId, input.triggerId), eq(triggerJobs.status, "triggering"))
        )
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
      const firstUpdated = updated[0];
      return firstUpdated === undefined ? null : toTriggerJobRecord(firstUpdated);
    });
  }

  public async listDeadLetterJobs(input: {
    workspaceId: string;
    limit: number;
  }): Promise<readonly TriggerJobRecord[]> {
    const rows = await this.db.query.triggerJobs.findMany({
      where: (table) => and(eq(table.workspaceId, input.workspaceId), eq(table.status, "failed")),
      orderBy: (table, operators) => [operators.desc(table.updatedAt)],
      limit: input.limit
    });
    return rows.map((row) => toTriggerJobRecord(row));
  }

  public async getJobById(triggerId: string): Promise<TriggerJobRecord | null> {
    const row = await this.db.query.triggerJobs.findFirst({
      where: (table) => eq(table.triggerId, triggerId)
    });
    return row === undefined ? null : toTriggerJobRecord(row);
  }
}
