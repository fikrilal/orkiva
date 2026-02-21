import { describe, expect, it, vi } from "vitest";

import { SupervisorWorkerLoop } from "./worker-loop.js";

describe("supervisor worker loop", () => {
  it("runs unread and runtime reconciliation in one deterministic tick", async () => {
    const tickAt = new Date("2026-02-18T10:30:00.000Z");
    const unreadReconcile = vi.fn(() =>
      Promise.resolve({
        workspaceId: "wk_01",
        polledAt: tickAt,
        candidates: [],
        stats: {
          participantsScanned: 4,
          unreadParticipants: 1,
          dormantUnreadParticipants: 1,
          deduplicatedParticipants: 0
        }
      })
    );
    const runtimeReconcile = vi.fn(() =>
      Promise.resolve({
        workspaceId: "wk_01",
        reconciledAt: tickAt,
        checkedRuntimes: 3,
        transitionedOffline: 1
      })
    );
    const schedule = vi.fn(() =>
      Promise.resolve({
        workspaceId: "wk_01",
        scheduledAt: tickAt,
        candidates: 0,
        enqueued: 0,
        skippedPending: 0,
        reusedExisting: 0,
        suppressedByBudget: 0,
        suppressedByBreaker: 0,
        breakerOpen: false,
        pendingJobs: 4
      })
    );
    const countPendingJobs = vi.fn(() => Promise.resolve(4));
    const processDueJobs = vi.fn(() =>
      Promise.resolve({
        workspaceId: "wk_01",
        processedAt: tickAt,
        claimedJobs: 2,
        delivered: 1,
        retried: 1,
        deadLettered: 0,
        failed: 0,
        fallbackResumed: 0,
        fallbackSpawned: 0,
        callbackDelivered: 0,
        callbackRetried: 0,
        callbackFailed: 0,
        autoBlocked: 0,
        fallbackRunsScanned: 0,
        fallbackRunsQueuedForCompletion: 0,
        fallbackRunsTimedOut: 0,
        fallbackRunsKilled: 0,
        fallbackRunsOrphaned: 0,
        deadLetterJobIds: []
      })
    );
    const reconcileFallbackRuns = vi.fn(() =>
      Promise.resolve({
        workspaceId: "wk_01",
        processedAt: tickAt,
        scanned: 1,
        queuedForCompletion: 1,
        timedOut: 0,
        killed: 0,
        orphaned: 1
      })
    );

    const loop = new SupervisorWorkerLoop(
      { reconcile: unreadReconcile },
      { schedule },
      { reconcileWorkspaceRuntimes: runtimeReconcile },
      { countPendingJobs },
      { processDueJobs, reconcileFallbackRuns }
    );

    const result = await loop.runTick({
      workspaceId: "wk_01",
      staleAfterHours: 12,
      triggerMaxRetries: 2,
      maxJobsPerTick: 10,
      tickAt
    });

    expect(unreadReconcile).toHaveBeenCalledWith({
      workspaceId: "wk_01",
      staleAfterHours: 12,
      polledAt: tickAt
    });
    expect(countPendingJobs).toHaveBeenCalledWith({
      workspaceId: "wk_01"
    });
    expect(runtimeReconcile).toHaveBeenCalledWith({
      workspaceId: "wk_01",
      staleAfterHours: 12,
      reconciledAt: tickAt
    });
    expect(schedule).toHaveBeenCalledWith({
      workspaceId: "wk_01",
      candidates: [],
      triggerMaxRetries: 2,
      pendingJobs: 4,
      scheduledAt: tickAt
    });
    expect(processDueJobs).toHaveBeenCalledWith({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: tickAt
    });
    expect(reconcileFallbackRuns).toHaveBeenCalledWith({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: tickAt
    });
    expect(result.unreadReconciliation.stats.participantsScanned).toBe(4);
    expect(result.unreadTriggerScheduling.enqueued).toBe(0);
    expect(result.runtimeReconciliation.transitionedOffline).toBe(1);
    expect(result.triggerQueueProcessing.claimedJobs).toBe(2);
    expect(result.triggerQueueProcessing.fallbackRunsOrphaned).toBe(1);
  });

  it("skips auto-unread reconciliation and scheduling when disabled", async () => {
    const tickAt = new Date("2026-02-18T10:30:00.000Z");
    const unreadReconcile = vi.fn(() =>
      Promise.resolve({
        workspaceId: "wk_01",
        polledAt: tickAt,
        candidates: [],
        stats: {
          participantsScanned: 1,
          unreadParticipants: 1,
          dormantUnreadParticipants: 1,
          deduplicatedParticipants: 0
        }
      })
    );
    const runtimeReconcile = vi.fn(() =>
      Promise.resolve({
        workspaceId: "wk_01",
        reconciledAt: tickAt,
        checkedRuntimes: 2,
        transitionedOffline: 0
      })
    );
    const schedule = vi.fn();
    const countPendingJobs = vi.fn();
    const processDueJobs = vi.fn(() =>
      Promise.resolve({
        workspaceId: "wk_01",
        processedAt: tickAt,
        claimedJobs: 0,
        delivered: 0,
        retried: 0,
        deadLettered: 0,
        failed: 0,
        fallbackResumed: 0,
        fallbackSpawned: 0,
        callbackDelivered: 0,
        callbackRetried: 0,
        callbackFailed: 0,
        autoBlocked: 0,
        fallbackRunsScanned: 0,
        fallbackRunsQueuedForCompletion: 0,
        fallbackRunsTimedOut: 0,
        fallbackRunsKilled: 0,
        fallbackRunsOrphaned: 0,
        deadLetterJobIds: []
      })
    );
    const reconcileFallbackRuns = vi.fn(() =>
      Promise.resolve({
        workspaceId: "wk_01",
        processedAt: tickAt,
        scanned: 0,
        queuedForCompletion: 0,
        timedOut: 0,
        killed: 0,
        orphaned: 0
      })
    );

    const loop = new SupervisorWorkerLoop(
      { reconcile: unreadReconcile },
      { schedule },
      { reconcileWorkspaceRuntimes: runtimeReconcile },
      { countPendingJobs },
      { processDueJobs, reconcileFallbackRuns }
    );

    const result = await loop.runTick({
      workspaceId: "wk_01",
      staleAfterHours: 12,
      triggerMaxRetries: 2,
      maxJobsPerTick: 10,
      autoUnreadEnabled: false,
      tickAt
    });

    expect(unreadReconcile).not.toHaveBeenCalled();
    expect(countPendingJobs).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(result.unreadReconciliation.stats.participantsScanned).toBe(0);
    expect(result.unreadTriggerScheduling.enqueued).toBe(0);
    expect(runtimeReconcile).toHaveBeenCalledTimes(1);
    expect(processDueJobs).toHaveBeenCalledTimes(1);
    expect(reconcileFallbackRuns).toHaveBeenCalledTimes(1);
  });
});
