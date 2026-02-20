import { describe, expect, it } from "vitest";

import type { UnreadReconciliationCandidate } from "./unread-reconciliation.js";
import { InMemoryTriggerQueueStore } from "./trigger-queue.js";
import { buildUnreadCandidateTriggerId, UnreadTriggerJobScheduler } from "./unread-trigger-jobs.js";

const scheduledAt = new Date("2026-02-20T00:00:00.000Z");

const createCandidate = (
  overrides: Partial<UnreadReconciliationCandidate> = {}
): UnreadReconciliationCandidate => ({
  threadId: "th_01",
  workspaceId: "wk_01",
  participantAgentId: "reviewer_agent",
  unreadCount: 3,
  latestSeq: 10,
  lastReadSeq: 7,
  sessionStatus: "active",
  sessionId: "sess_01",
  managementMode: "managed",
  resumable: true,
  staleSession: false,
  reason: "new_unread_dormant_participant",
  ...overrides
});

describe("unread trigger job scheduler", () => {
  it("enqueues candidates and skips participants with pending jobs", async () => {
    const pendingCandidate = createCandidate();
    const pendingTriggerId = buildUnreadCandidateTriggerId({
      workspaceId: pendingCandidate.workspaceId,
      threadId: pendingCandidate.threadId,
      participantAgentId: pendingCandidate.participantAgentId,
      latestSeq: pendingCandidate.latestSeq
    });
    const store = new InMemoryTriggerQueueStore([
      {
        triggerId: pendingTriggerId,
        threadId: pendingCandidate.threadId,
        workspaceId: pendingCandidate.workspaceId,
        targetAgentId: pendingCandidate.participantAgentId,
        targetSessionId: pendingCandidate.sessionId ?? null,
        reason: pendingCandidate.reason,
        prompt: "already pending",
        status: "queued",
        attempts: 0,
        maxRetries: 2,
        nextRetryAt: null,
        createdAt: scheduledAt,
        updatedAt: scheduledAt
      }
    ]);
    const scheduler = new UnreadTriggerJobScheduler(store);

    const newCandidate = createCandidate({
      threadId: "th_02",
      participantAgentId: "security_agent",
      latestSeq: 8,
      lastReadSeq: 4,
      sessionStatus: "idle"
    });

    const result = await scheduler.schedule({
      workspaceId: "wk_01",
      candidates: [pendingCandidate, newCandidate],
      triggerMaxRetries: 2,
      scheduledAt
    });

    expect(result).toEqual({
      workspaceId: "wk_01",
      scheduledAt,
      candidates: 2,
      enqueued: 1,
      skippedPending: 1,
      reusedExisting: 0
    });

    const newTriggerId = buildUnreadCandidateTriggerId({
      workspaceId: newCandidate.workspaceId,
      threadId: newCandidate.threadId,
      participantAgentId: newCandidate.participantAgentId,
      latestSeq: newCandidate.latestSeq
    });
    const created = await store.getJobById(newTriggerId);
    expect(created).not.toBeNull();
    expect(created?.status).toBe("queued");
    expect(created?.reason).toBe("new_unread_dormant_participant");
  });

  it("reuses existing deterministic trigger ids when state dedupe resets", async () => {
    const candidate = createCandidate({
      threadId: "th_03",
      participantAgentId: "reviewer_agent",
      latestSeq: 13,
      lastReadSeq: 12
    });
    const existingTriggerId = buildUnreadCandidateTriggerId({
      workspaceId: candidate.workspaceId,
      threadId: candidate.threadId,
      participantAgentId: candidate.participantAgentId,
      latestSeq: candidate.latestSeq
    });
    const store = new InMemoryTriggerQueueStore([
      {
        triggerId: existingTriggerId,
        threadId: candidate.threadId,
        workspaceId: candidate.workspaceId,
        targetAgentId: candidate.participantAgentId,
        targetSessionId: candidate.sessionId ?? null,
        reason: candidate.reason,
        prompt: "already completed",
        status: "delivered",
        attempts: 1,
        maxRetries: 2,
        nextRetryAt: null,
        createdAt: scheduledAt,
        updatedAt: scheduledAt
      }
    ]);
    const scheduler = new UnreadTriggerJobScheduler(store);

    const result = await scheduler.schedule({
      workspaceId: "wk_01",
      candidates: [candidate],
      triggerMaxRetries: 2,
      scheduledAt
    });

    expect(result.enqueued).toBe(0);
    expect(result.skippedPending).toBe(0);
    expect(result.reusedExisting).toBe(1);

    const existing = await store.getJobById(existingTriggerId);
    expect(existing?.status).toBe("delivered");
    expect(existing?.attempts).toBe(1);
  });
});
