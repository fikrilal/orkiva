import type { DbClient } from "@orkiva/db";
import { threads, triggerAttempts, triggerJobs } from "@orkiva/db";
import { extractRequestIdFromTriggerId } from "@orkiva/protocol";
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

export interface TriggerAttemptRecord {
  attemptNo: number;
  attemptResult: TriggerAttemptResult;
  errorCode?: string;
  details?: Record<string, unknown>;
  createdAt: Date;
}

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

export interface ListPendingTriggerJobsInput {
  workspaceId: string;
  reason: string;
  threadIds: readonly string[];
  targetAgentIds: readonly string[];
}

export const PENDING_TRIGGER_JOB_STATUSES: readonly TriggerJobStatus[] = [
  "queued",
  "triggering",
  "deferred",
  "timeout",
  "fallback_resume",
  "fallback_spawn"
];

const RETRY_DUE_TRIGGER_STATUSES: readonly TriggerJobStatus[] = ["queued", "timeout", "deferred"];
const INITIAL_FALLBACK_DUE_TRIGGER_STATUSES: readonly TriggerJobStatus[] = [
  "fallback_resume",
  "fallback_spawn"
];

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
  listPendingJobs(input: ListPendingTriggerJobsInput): Promise<readonly TriggerJobRecord[]>;
  createOrReuseTriggerJob(
    input: CreateOrReuseTriggerJobInput
  ): Promise<CreateOrReuseTriggerJobResult>;
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
  markThreadBlocked(input: { threadId: string; blockedAt: Date; reason: string }): Promise<boolean>;
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

const isClaimEligible = (job: TriggerJobRecord, claimedAt: Date): boolean => {
  const dueByRetryWindow =
    job.nextRetryAt === null || job.nextRetryAt.getTime() <= claimedAt.getTime();
  if (!dueByRetryWindow) {
    return false;
  }

  if (RETRY_DUE_TRIGGER_STATUSES.includes(job.status)) {
    return true;
  }

  if (INITIAL_FALLBACK_DUE_TRIGGER_STATUSES.includes(job.status)) {
    return job.attempts === 0;
  }

  return false;
};

const toDirectFallbackRequiredOutcome = (
  sourceStatus: "fallback_resume" | "fallback_spawn"
): TriggerExecutionOutcome => ({
  attemptResult: "failed",
  retryable: false,
  errorCode: "FALLBACK_REQUIRED",
  details: {
    source_status: sourceStatus
  }
});

export interface TriggerExecutionOutcome {
  attemptResult: TriggerAttemptResult;
  retryable: boolean;
  retryAfterMs?: number;
  errorCode?: string;
  details?: Record<string, unknown>;
}

export interface TriggerFallbackOutcome {
  attemptResult: "fallback_resume_succeeded" | "fallback_resume_failed" | "fallback_spawned";
  nextStatus: TriggerJobStatus;
  errorCode?: string;
  details?: Record<string, unknown>;
}

export interface TriggerFallbackExecutor {
  execute(input: {
    job: TriggerJobRecord;
    attemptNo: number;
    initialOutcome: TriggerExecutionOutcome;
    now: Date;
  }): Promise<TriggerFallbackOutcome>;
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

export class NoopTriggerFallbackExecutor implements TriggerFallbackExecutor {
  public execute(input: {
    job: TriggerJobRecord;
    attemptNo: number;
    initialOutcome: TriggerExecutionOutcome;
    now: Date;
  }): Promise<TriggerFallbackOutcome> {
    return Promise.resolve({
      attemptResult: "fallback_resume_failed",
      nextStatus: "failed",
      errorCode: input.initialOutcome.errorCode ?? "FALLBACK_NOT_IMPLEMENTED",
      details: {
        triggerId: input.job.triggerId,
        attemptNo: input.attemptNo,
        ...(input.initialOutcome.details === undefined
          ? {}
          : { initialOutcome: input.initialOutcome.details }),
        now: input.now.toISOString()
      }
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
  fallbackResumed: number;
  fallbackSpawned: number;
  autoBlocked: number;
  deadLetterJobIds: readonly string[];
}

export interface TriggerQueueSafeguardsConfig {
  deferRecheckMs: number;
  rateLimitPerMinute: number;
  loopMaxTurns: number;
  loopMaxRepeatedFindings: number;
}

type TriggerQueueLogContext = Record<string, string | number | boolean | null | undefined>;

interface TriggerQueueLogger {
  info(message: string, context?: TriggerQueueLogContext): void;
}

const DEFAULT_TRIGGER_QUEUE_SAFEGUARDS: TriggerQueueSafeguardsConfig = {
  deferRecheckMs: 5_000,
  rateLimitPerMinute: 10,
  loopMaxTurns: 20,
  loopMaxRepeatedFindings: 3
};

export class TriggerQueueProcessor {
  private readonly rateLimitEvents = new Map<string, Date[]>();
  private readonly threadLoopState = new Map<
    string,
    {
      noProgressTurns: number;
      repeatedErrorCode: string | null;
      repeatedFindingCycles: number;
    }
  >();

  public constructor(
    private readonly store: TriggerQueueStore,
    private readonly executor: TriggerJobExecutor,
    private readonly fallbackExecutor: TriggerFallbackExecutor = new NoopTriggerFallbackExecutor(),
    private readonly safeguards: TriggerQueueSafeguardsConfig = DEFAULT_TRIGGER_QUEUE_SAFEGUARDS,
    private readonly backoffBaseMs = 2000,
    private readonly backoffMaxMs = 60000,
    private readonly logger?: TriggerQueueLogger,
    private readonly executionTimeoutMs = 8000
  ) {}

  private timeoutOutcome(input: {
    phase: "executor" | "fallback";
    triggerId: string;
    attemptNo: number;
  }): TriggerExecutionOutcome {
    if (input.phase === "executor") {
      return {
        attemptResult: "timeout",
        retryable: true,
        errorCode: "TRIGGER_EXECUTOR_TIMEOUT",
        details: {
          phase: input.phase,
          triggerId: input.triggerId,
          attemptNo: input.attemptNo,
          timeoutMs: this.executionTimeoutMs
        }
      };
    }

    return {
      attemptResult: "failed",
      retryable: false,
      errorCode: "TRIGGER_FALLBACK_TIMEOUT",
      details: {
        phase: input.phase,
        triggerId: input.triggerId,
        attemptNo: input.attemptNo,
        timeoutMs: this.executionTimeoutMs
      }
    };
  }

  private exceptionOutcome(input: {
    phase: "executor" | "fallback";
    triggerId: string;
    attemptNo: number;
    error: unknown;
  }): TriggerExecutionOutcome {
    const errorMessage = input.error instanceof Error ? input.error.message : String(input.error);
    const errorCode =
      input.phase === "executor" ? "TRIGGER_EXECUTOR_EXCEPTION" : "TRIGGER_FALLBACK_EXCEPTION";

    return {
      attemptResult: "failed",
      retryable: false,
      errorCode,
      details: {
        phase: input.phase,
        triggerId: input.triggerId,
        attemptNo: input.attemptNo,
        errorMessage
      }
    };
  }

  private async runWithTimeout<T>(input: {
    phase: "executor" | "fallback";
    triggerId: string;
    attemptNo: number;
    execute: () => Promise<T>;
    onTimeout: () => T;
  }): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<T>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve(input.onTimeout());
      }, this.executionTimeoutMs);
    });

    try {
      return await Promise.race([input.execute(), timeoutPromise]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private computeBackoffMs(attemptNo: number): number {
    const raw = this.backoffBaseMs * 2 ** Math.max(attemptNo - 1, 0);
    return Math.min(raw, this.backoffMaxMs);
  }

  private rateLimitKey(job: TriggerJobRecord): string {
    return `${job.workspaceId}:${job.threadId}:${job.targetAgentId}`;
  }

  private applyRateLimit(job: TriggerJobRecord, now: Date): TriggerExecutionOutcome | null {
    const key = this.rateLimitKey(job);
    const windowStart = now.getTime() - 60_000;
    const existing = this.rateLimitEvents.get(key) ?? [];
    const recent = existing.filter((eventAt) => eventAt.getTime() >= windowStart);
    if (recent.length >= this.safeguards.rateLimitPerMinute) {
      const oldest = recent[0];
      const retryAfterMs =
        oldest === undefined
          ? this.safeguards.deferRecheckMs
          : oldest.getTime() + 60_000 - now.getTime();
      this.rateLimitEvents.set(key, recent);
      return {
        attemptResult: "deferred",
        retryable: true,
        retryAfterMs: Math.max(retryAfterMs, this.safeguards.deferRecheckMs),
        errorCode: "TRIGGER_RATE_LIMITED",
        details: {
          rateLimitPerMinute: this.safeguards.rateLimitPerMinute
        }
      };
    }

    this.rateLimitEvents.set(key, [...recent, now]);
    return null;
  }

  private clearLoopState(threadId: string): void {
    this.threadLoopState.delete(threadId);
  }

  private updateLoopState(input: { threadId: string; outcome: TriggerExecutionOutcome }): {
    shouldAutoBlock: boolean;
    reason: string | null;
  } {
    const isProgress =
      input.outcome.attemptResult === "delivered" ||
      input.outcome.attemptResult === "fallback_resume_succeeded" ||
      input.outcome.attemptResult === "fallback_spawned";
    if (isProgress) {
      this.clearLoopState(input.threadId);
      return {
        shouldAutoBlock: false,
        reason: null
      };
    }

    const previous = this.threadLoopState.get(input.threadId) ?? {
      noProgressTurns: 0,
      repeatedErrorCode: null,
      repeatedFindingCycles: 0
    };
    const nextNoProgressTurns = previous.noProgressTurns + 1;
    const errorCode = input.outcome.errorCode ?? "UNKNOWN_TRIGGER_ERROR";
    const nextRepeatedFindingCycles =
      previous.repeatedErrorCode === errorCode ? previous.repeatedFindingCycles + 1 : 1;
    this.threadLoopState.set(input.threadId, {
      noProgressTurns: nextNoProgressTurns,
      repeatedErrorCode: errorCode,
      repeatedFindingCycles: nextRepeatedFindingCycles
    });

    if (nextNoProgressTurns >= this.safeguards.loopMaxTurns) {
      return {
        shouldAutoBlock: true,
        reason: `no_progress_turns:${nextNoProgressTurns}`
      };
    }
    if (nextRepeatedFindingCycles >= this.safeguards.loopMaxRepeatedFindings) {
      return {
        shouldAutoBlock: true,
        reason: `repeated_identical_findings:${nextRepeatedFindingCycles}:${errorCode}`
      };
    }

    return {
      shouldAutoBlock: false,
      reason: null
    };
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
    let fallbackResumed = 0;
    let fallbackSpawned = 0;
    let autoBlocked = 0;

    for (const job of claimedJobs) {
      const attemptNo = job.attempts + 1;
      const requestId = extractRequestIdFromTriggerId(job.triggerId);
      const correlationContext: TriggerQueueLogContext = {
        trigger_id: job.triggerId,
        ...(requestId === null ? {} : { request_id: requestId }),
        thread_id: job.threadId,
        workspace_id: job.workspaceId,
        target_agent_id: job.targetAgentId
      };
      this.logger?.info("trigger.job.claimed", {
        ...correlationContext,
        attempt_no: attemptNo
      });
      const requiresDirectFallback =
        job.status === "fallback_resume" || job.status === "fallback_spawn";
      const rateLimitedOutcome = this.applyRateLimit(job, processedAt);
      const outcome =
        requiresDirectFallback
          ? toDirectFallbackRequiredOutcome(
              job.status === "fallback_resume" ? "fallback_resume" : "fallback_spawn"
            )
          : rateLimitedOutcome ??
            (await this.runWithTimeout({
              phase: "executor",
              triggerId: job.triggerId,
              attemptNo,
              execute: () =>
                this.executor.execute({
                  job,
                  attemptNo,
                  now: processedAt
                }),
              onTimeout: () =>
                this.timeoutOutcome({
                  phase: "executor",
                  triggerId: job.triggerId,
                  attemptNo
                })
            }).catch((error: unknown) =>
              this.exceptionOutcome({
                phase: "executor",
                triggerId: job.triggerId,
                attemptNo,
                error
              })
            ));

      const shouldRetry =
        outcome.attemptResult === "deferred"
          ? outcome.retryable
          : outcome.retryable && attemptNo <= job.maxRetries;
      let finalOutcome: TriggerExecutionOutcome = outcome;
      let nextStatus: TriggerJobStatus =
        outcome.attemptResult === "delivered"
          ? "delivered"
          : shouldRetry
            ? toTransitionStatusForRetry(outcome.attemptResult)
            : "failed";
      let nextRetryAt =
        outcome.attemptResult === "delivered" || !shouldRetry
          ? null
          : new Date(
              processedAt.getTime() +
                (outcome.attemptResult === "deferred"
                  ? (outcome.retryAfterMs ?? this.safeguards.deferRecheckMs)
                  : this.computeBackoffMs(attemptNo))
            );

      if (!shouldRetry && outcome.attemptResult !== "delivered") {
        const fallback = await this.runWithTimeout<TriggerFallbackOutcome>({
          phase: "fallback",
          triggerId: job.triggerId,
          attemptNo,
          execute: () =>
            this.fallbackExecutor.execute({
              job,
              attemptNo,
              initialOutcome: outcome,
              now: processedAt
            }),
          onTimeout: () =>
            ({
              attemptResult: "fallback_resume_failed",
              nextStatus: "failed",
              errorCode: "TRIGGER_FALLBACK_TIMEOUT",
              details: {
                triggerId: job.triggerId,
                attemptNo,
                timeoutMs: this.executionTimeoutMs
              }
            }) satisfies TriggerFallbackOutcome
        }).catch(
          (error: unknown): TriggerFallbackOutcome => ({
            attemptResult: "fallback_resume_failed",
            nextStatus: "failed",
            errorCode: "TRIGGER_FALLBACK_EXCEPTION",
            details: {
              triggerId: job.triggerId,
              attemptNo,
              errorMessage: error instanceof Error ? error.message : String(error)
            }
          })
        );
        finalOutcome = {
          attemptResult: fallback.attemptResult,
          retryable: false,
          ...(fallback.errorCode === undefined ? {} : { errorCode: fallback.errorCode }),
          ...(fallback.details === undefined ? {} : { details: fallback.details })
        };
        nextStatus = fallback.nextStatus;
        nextRetryAt = null;
      }

      const loopGuard = this.updateLoopState({
        threadId: job.threadId,
        outcome: finalOutcome
      });
      if (loopGuard.shouldAutoBlock && loopGuard.reason !== null) {
        const blocked = await this.store.markThreadBlocked({
          threadId: job.threadId,
          blockedAt: processedAt,
          reason: loopGuard.reason
        });
        if (blocked) {
          autoBlocked += 1;
        }
        const priorOutcomeDetails = finalOutcome.details;
        finalOutcome = {
          attemptResult: "failed",
          retryable: false,
          errorCode: "THREAD_AUTO_BLOCKED",
          details: {
            threadId: job.threadId,
            reason: loopGuard.reason,
            ...(priorOutcomeDetails === undefined ? {} : { prior_outcome: priorOutcomeDetails })
          }
        };
        nextStatus = "failed";
        nextRetryAt = null;
      }

      const correlatedDetails: Record<string, unknown> = {
        ...(finalOutcome.details === undefined ? {} : finalOutcome.details),
        trigger_id: job.triggerId,
        ...(requestId === null ? {} : { request_id: requestId })
      };

      await this.store.recordAttemptAndTransition({
        triggerId: job.triggerId,
        attemptNo,
        attemptResult: finalOutcome.attemptResult,
        ...(finalOutcome.errorCode === undefined ? {} : { errorCode: finalOutcome.errorCode }),
        details: correlatedDetails,
        nextStatus,
        nextRetryAt,
        transitionedAt: processedAt
      });
      this.logger?.info("trigger.attempt.recorded", {
        ...correlationContext,
        attempt_no: attemptNo,
        attempt_result: finalOutcome.attemptResult,
        next_status: nextStatus,
        ...(finalOutcome.errorCode === undefined ? {} : { error_code: finalOutcome.errorCode })
      });

      if (
        finalOutcome.attemptResult === "delivered" ||
        finalOutcome.attemptResult === "fallback_resume_succeeded" ||
        finalOutcome.attemptResult === "fallback_spawned"
      ) {
        delivered += 1;
        if (finalOutcome.attemptResult === "fallback_resume_succeeded") {
          fallbackResumed += 1;
        }
        if (finalOutcome.attemptResult === "fallback_spawned") {
          fallbackSpawned += 1;
        }
      } else if (shouldRetry && finalOutcome.attemptResult !== "fallback_resume_failed") {
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
      fallbackResumed,
      fallbackSpawned,
      autoBlocked,
      deadLetterJobIds: deadLetter.map((job) => job.triggerId)
    };
  }
}

const triggerKey = (triggerId: string): string => triggerId;

export class InMemoryTriggerQueueStore implements TriggerQueueStore {
  private readonly jobs = new Map<string, TriggerJobRecord>();
  private readonly blockedThreads = new Map<string, { blockedAt: Date; reason: string }>();
  private readonly attemptsByTrigger = new Map<string, TriggerAttemptRecord[]>();

  public constructor(seedJobs: readonly TriggerJobRecord[] = []) {
    for (const job of seedJobs) {
      this.jobs.set(triggerKey(job.triggerId), { ...job });
    }
  }

  public listPendingJobs(input: ListPendingTriggerJobsInput): Promise<readonly TriggerJobRecord[]> {
    const threadIds = new Set(input.threadIds);
    const targetAgentIds = new Set(input.targetAgentIds);
    return Promise.resolve(
      [...this.jobs.values()].filter((job) => {
        if (job.workspaceId !== input.workspaceId) {
          return false;
        }
        if (job.reason !== input.reason) {
          return false;
        }
        if (!PENDING_TRIGGER_JOB_STATUSES.includes(job.status)) {
          return false;
        }
        if (!threadIds.has(job.threadId)) {
          return false;
        }
        if (!targetAgentIds.has(job.targetAgentId)) {
          return false;
        }
        return true;
      })
    );
  }

  public createOrReuseTriggerJob(
    input: CreateOrReuseTriggerJobInput
  ): Promise<CreateOrReuseTriggerJobResult> {
    const existing = this.jobs.get(triggerKey(input.triggerId));
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

  public claimDueJobs(input: {
    workspaceId: string;
    limit: number;
    claimedAt: Date;
  }): Promise<readonly TriggerJobRecord[]> {
    const due = [...this.jobs.values()]
      .filter((job) => job.workspaceId === input.workspaceId)
      .filter((job) => isClaimEligible(job, input.claimedAt))
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
      claimed.push({
        ...triggering,
        status: candidate.status
      });
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

  public getAttemptsByTrigger(triggerId: string): readonly TriggerAttemptRecord[] {
    const attempts = this.attemptsByTrigger.get(triggerId) ?? [];
    return attempts.map((attempt) => ({ ...attempt }));
  }

  public markThreadBlocked(input: {
    threadId: string;
    blockedAt: Date;
    reason: string;
  }): Promise<boolean> {
    const existing = this.blockedThreads.get(input.threadId);
    if (existing !== undefined) {
      return Promise.resolve(false);
    }
    this.blockedThreads.set(input.threadId, {
      blockedAt: input.blockedAt,
      reason: input.reason
    });
    return Promise.resolve(true);
  }
}

export class DbTriggerQueueStore implements TriggerQueueStore {
  public constructor(private readonly db: DbClient) {}

  public async listPendingJobs(
    input: ListPendingTriggerJobsInput
  ): Promise<readonly TriggerJobRecord[]> {
    if (input.threadIds.length === 0 || input.targetAgentIds.length === 0) {
      return [];
    }

    const rows = await this.db.query.triggerJobs.findMany({
      where: (table) =>
        and(
          eq(table.workspaceId, input.workspaceId),
          eq(table.reason, input.reason),
          inArray(table.status, [...PENDING_TRIGGER_JOB_STATUSES]),
          inArray(table.threadId, [...input.threadIds]),
          inArray(table.targetAgentId, [...input.targetAgentIds])
        )
    });
    return rows.map((row) => toTriggerJobRecord(row));
  }

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
        targetSessionId: input.targetSessionId,
        reason: input.reason,
        prompt: input.prompt,
        status: input.status,
        attempts: input.attempts,
        maxRetries: input.maxRetries,
        nextRetryAt: input.nextRetryAt,
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
    if (firstInserted !== undefined) {
      return {
        record: toTriggerJobRecord(firstInserted),
        created: true
      };
    }

    const existing = await this.db.query.triggerJobs.findFirst({
      where: (table) => eq(table.triggerId, input.triggerId)
    });
    if (existing === undefined) {
      throw new Error(`Failed to read trigger job after conflict: ${input.triggerId}`);
    }
    return {
      record: toTriggerJobRecord(existing),
      created: false
    };
  }

  public async claimDueJobs(input: {
    workspaceId: string;
    limit: number;
    claimedAt: Date;
  }): Promise<readonly TriggerJobRecord[]> {
    const candidates = await this.db.query.triggerJobs.findMany({
      where: (table) =>
        and(
          eq(table.workspaceId, input.workspaceId),
          or(
            inArray(table.status, [...RETRY_DUE_TRIGGER_STATUSES]),
            and(
              inArray(table.status, [...INITIAL_FALLBACK_DUE_TRIGGER_STATUSES]),
              eq(table.attempts, 0)
            )
          ),
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

      claimed.push(
        toTriggerJobRecord({
          ...firstUpdated,
          status: candidate.status
        })
      );
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

  public async markThreadBlocked(input: {
    threadId: string;
    blockedAt: Date;
    reason: string;
  }): Promise<boolean> {
    void input.reason;
    const updated = await this.db
      .update(threads)
      .set({
        status: "blocked",
        updatedAt: input.blockedAt
      })
      .where(and(eq(threads.threadId, input.threadId), eq(threads.status, "active")))
      .returning({
        threadId: threads.threadId
      });
    return updated.length > 0;
  }
}
