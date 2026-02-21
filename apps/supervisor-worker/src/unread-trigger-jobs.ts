import { createHash } from "node:crypto";

import { buildTriggerId } from "@orkiva/protocol";

import type { UnreadReconciliationCandidate } from "./unread-reconciliation.js";
import type {
  CreateOrReuseTriggerJobInput,
  CreateOrReuseTriggerJobResult,
  ListPendingTriggerJobsInput,
  TriggerJobRecord
} from "./trigger-queue.js";

const unreadCandidateKey = (threadId: string, targetAgentId: string): string =>
  `${threadId}::${targetAgentId}`;

export const buildUnreadCandidateTriggerId = (input: {
  workspaceId: string;
  threadId: string;
  participantAgentId: string;
  latestSeq: number;
}): string => {
  const digest = createHash("sha256")
    .update(
      `${input.workspaceId}|${input.threadId}|${input.participantAgentId}|${input.latestSeq}`
    )
    .digest("hex")
    .slice(0, 24);
  return buildTriggerId(`auto_unread_${digest}`);
};

const buildUnreadCandidatePrompt = (candidate: UnreadReconciliationCandidate): string =>
  [
    `[BRIDGE_TRIGGER_AUTO reason=${candidate.reason} thread=${candidate.threadId}]`,
    `Read unread messages in thread ${candidate.threadId}. Latest seq is ${candidate.latestSeq} and your last read seq is ${candidate.lastReadSeq}.`,
    "Continue your assigned workflow and post a status update in the same thread when done.",
    "[/BRIDGE_TRIGGER_AUTO]"
  ].join("\n");

const resolveInitialJobStatus = (
  candidate: UnreadReconciliationCandidate
): TriggerJobRecord["status"] => {
  const managedRuntimeAvailable =
    candidate.sessionStatus !== "missing" &&
    candidate.managementMode === "managed" &&
    candidate.sessionStatus !== "offline" &&
    !candidate.staleSession;
  if (managedRuntimeAvailable) {
    return "queued";
  }

  const shouldResume = candidate.resumable === true && !candidate.staleSession;
  return shouldResume ? "fallback_resume" : "fallback_spawn";
};

export interface UnreadTriggerJobStore {
  listPendingJobs(input: ListPendingTriggerJobsInput): Promise<readonly TriggerJobRecord[]>;
  listRecentAutoTriggerJobs(input: {
    workspaceId: string;
    reason: string;
    threadIds: readonly string[];
    targetAgentIds: readonly string[];
    since: Date;
  }): Promise<readonly TriggerJobRecord[]>;
  createOrReuseTriggerJob(
    input: CreateOrReuseTriggerJobInput
  ): Promise<CreateOrReuseTriggerJobResult>;
}

export interface UnreadSchedulerGuardConfig {
  maxTriggersPerWindow: number;
  windowMs: number;
  minIntervalMs: number;
  breakerBacklogThreshold: number;
  breakerCooldownMs: number;
}

const DEFAULT_UNREAD_SCHEDULER_GUARDS: UnreadSchedulerGuardConfig = {
  maxTriggersPerWindow: 3,
  windowMs: 5 * 60 * 1000,
  minIntervalMs: 30 * 1000,
  breakerBacklogThreshold: 50,
  breakerCooldownMs: 60 * 1000
};

export interface ScheduleUnreadCandidatesInput {
  workspaceId: string;
  candidates: readonly UnreadReconciliationCandidate[];
  triggerMaxRetries: number;
  pendingJobs: number;
  scheduledAt?: Date;
}

export interface ScheduleUnreadCandidatesResult {
  workspaceId: string;
  scheduledAt: Date;
  candidates: number;
  enqueued: number;
  skippedPending: number;
  reusedExisting: number;
  suppressedByBudget: number;
  suppressedByBreaker: number;
  breakerOpen: boolean;
  pendingJobs: number;
}

export class UnreadTriggerJobScheduler {
  private breakerOpenUntil: Date | null = null;

  public constructor(
    private readonly store: UnreadTriggerJobStore,
    private readonly guardConfig: UnreadSchedulerGuardConfig = DEFAULT_UNREAD_SCHEDULER_GUARDS
  ) {}

  private isBreakerOpen(at: Date): boolean {
    return this.breakerOpenUntil !== null && this.breakerOpenUntil.getTime() > at.getTime();
  }

  public async schedule(input: ScheduleUnreadCandidatesInput): Promise<ScheduleUnreadCandidatesResult> {
    const scheduledAt = input.scheduledAt ?? new Date();
    const scheduledAtMs = scheduledAt.getTime();
    const pendingJobCount = input.pendingJobs;
    const breakerWasOpen = this.isBreakerOpen(scheduledAt);
    if (
      !breakerWasOpen &&
      pendingJobCount >= this.guardConfig.breakerBacklogThreshold
    ) {
      this.breakerOpenUntil = new Date(scheduledAt.getTime() + this.guardConfig.breakerCooldownMs);
    }
    const breakerOpen = this.isBreakerOpen(scheduledAt);
    if (input.candidates.length === 0) {
      return {
        workspaceId: input.workspaceId,
        scheduledAt,
        candidates: 0,
        enqueued: 0,
        skippedPending: 0,
        reusedExisting: 0,
        suppressedByBudget: 0,
        suppressedByBreaker: 0,
        breakerOpen,
        pendingJobs: pendingJobCount
      };
    }
    if (breakerOpen) {
      return {
        workspaceId: input.workspaceId,
        scheduledAt,
        candidates: input.candidates.length,
        enqueued: 0,
        skippedPending: 0,
        reusedExisting: 0,
        suppressedByBudget: 0,
        suppressedByBreaker: input.candidates.length,
        breakerOpen,
        pendingJobs: pendingJobCount
      };
    }

    const threadIds = [...new Set(input.candidates.map((candidate) => candidate.threadId))];
    const targetAgentIds = [
      ...new Set(input.candidates.map((candidate) => candidate.participantAgentId))
    ];
    const existingPendingJobs = await this.store.listPendingJobs({
      workspaceId: input.workspaceId,
      reason: "new_unread_dormant_participant",
      threadIds,
      targetAgentIds
    });
    const pendingKeys = new Set(
      existingPendingJobs.map((job) => unreadCandidateKey(job.threadId, job.targetAgentId))
    );
    const recentJobs = await this.store.listRecentAutoTriggerJobs({
      workspaceId: input.workspaceId,
      reason: "new_unread_dormant_participant",
      threadIds,
      targetAgentIds,
      since: new Date(scheduledAtMs - this.guardConfig.windowMs)
    });
    const recentActivityByParticipant = new Map<string, Date[]>();
    for (const job of recentJobs) {
      const key = unreadCandidateKey(job.threadId, job.targetAgentId);
      const existing = recentActivityByParticipant.get(key) ?? [];
      existing.push(job.updatedAt);
      recentActivityByParticipant.set(key, existing);
    }
    for (const [key, timestamps] of recentActivityByParticipant.entries()) {
      timestamps.sort((left, right) => right.getTime() - left.getTime());
      recentActivityByParticipant.set(key, timestamps);
    }

    let enqueued = 0;
    let skippedPending = 0;
    let reusedExisting = 0;
    let suppressedByBudget = 0;

    for (const candidate of input.candidates) {
      const participantKey = unreadCandidateKey(candidate.threadId, candidate.participantAgentId);
      if (pendingKeys.has(participantKey)) {
        skippedPending += 1;
        continue;
      }
      const recentActivity = recentActivityByParticipant.get(participantKey) ?? [];
      const latestActivity = recentActivity[0];
      if (
        latestActivity !== undefined &&
        scheduledAtMs - latestActivity.getTime() < this.guardConfig.minIntervalMs
      ) {
        suppressedByBudget += 1;
        continue;
      }
      const recentCountInWindow = recentActivity.filter(
        (eventAt) => scheduledAtMs - eventAt.getTime() <= this.guardConfig.windowMs
      ).length;
      if (recentCountInWindow >= this.guardConfig.maxTriggersPerWindow) {
        suppressedByBudget += 1;
        continue;
      }

      const result = await this.store.createOrReuseTriggerJob({
        triggerId: buildUnreadCandidateTriggerId({
          workspaceId: candidate.workspaceId,
          threadId: candidate.threadId,
          participantAgentId: candidate.participantAgentId,
          latestSeq: candidate.latestSeq
        }),
        threadId: candidate.threadId,
        workspaceId: candidate.workspaceId,
        targetAgentId: candidate.participantAgentId,
        targetSessionId: candidate.sessionId ?? null,
        reason: candidate.reason,
        prompt: buildUnreadCandidatePrompt(candidate),
        status: resolveInitialJobStatus(candidate),
        attempts: 0,
        maxRetries: input.triggerMaxRetries,
        nextRetryAt: null,
        createdAt: scheduledAt,
        updatedAt: scheduledAt
      });
      if (result.created) {
        enqueued += 1;
        pendingKeys.add(participantKey);
        recentActivityByParticipant.set(participantKey, [scheduledAt, ...recentActivity]);
      } else {
        reusedExisting += 1;
      }
    }

    return {
      workspaceId: input.workspaceId,
      scheduledAt,
      candidates: input.candidates.length,
      enqueued,
      skippedPending,
      reusedExisting,
      suppressedByBudget,
      suppressedByBreaker: 0,
      breakerOpen: false,
      pendingJobs: pendingJobCount
    };
  }
}
