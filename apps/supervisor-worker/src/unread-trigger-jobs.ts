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
  createOrReuseTriggerJob(
    input: CreateOrReuseTriggerJobInput
  ): Promise<CreateOrReuseTriggerJobResult>;
}

export interface ScheduleUnreadCandidatesInput {
  workspaceId: string;
  candidates: readonly UnreadReconciliationCandidate[];
  triggerMaxRetries: number;
  scheduledAt?: Date;
}

export interface ScheduleUnreadCandidatesResult {
  workspaceId: string;
  scheduledAt: Date;
  candidates: number;
  enqueued: number;
  skippedPending: number;
  reusedExisting: number;
}

export class UnreadTriggerJobScheduler {
  public constructor(private readonly store: UnreadTriggerJobStore) {}

  public async schedule(input: ScheduleUnreadCandidatesInput): Promise<ScheduleUnreadCandidatesResult> {
    const scheduledAt = input.scheduledAt ?? new Date();
    if (input.candidates.length === 0) {
      return {
        workspaceId: input.workspaceId,
        scheduledAt,
        candidates: 0,
        enqueued: 0,
        skippedPending: 0,
        reusedExisting: 0
      };
    }

    const threadIds = [...new Set(input.candidates.map((candidate) => candidate.threadId))];
    const targetAgentIds = [
      ...new Set(input.candidates.map((candidate) => candidate.participantAgentId))
    ];
    const pendingJobs = await this.store.listPendingJobs({
      workspaceId: input.workspaceId,
      reason: "new_unread_dormant_participant",
      threadIds,
      targetAgentIds
    });
    const pendingKeys = new Set(
      pendingJobs.map((job) => unreadCandidateKey(job.threadId, job.targetAgentId))
    );

    let enqueued = 0;
    let skippedPending = 0;
    let reusedExisting = 0;

    for (const candidate of input.candidates) {
      const participantKey = unreadCandidateKey(candidate.threadId, candidate.participantAgentId);
      if (pendingKeys.has(participantKey)) {
        skippedPending += 1;
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
      reusedExisting
    };
  }
}
