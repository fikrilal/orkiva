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
        autoBlocked: 0,
        deadLetterJobIds: []
      })
    );

    const loop = new SupervisorWorkerLoop(
      { reconcile: unreadReconcile },
      { reconcileWorkspaceRuntimes: runtimeReconcile },
      { processDueJobs }
    );

    const result = await loop.runTick({
      workspaceId: "wk_01",
      staleAfterHours: 12,
      maxJobsPerTick: 10,
      tickAt
    });

    expect(unreadReconcile).toHaveBeenCalledWith({
      workspaceId: "wk_01",
      staleAfterHours: 12,
      polledAt: tickAt
    });
    expect(runtimeReconcile).toHaveBeenCalledWith({
      workspaceId: "wk_01",
      staleAfterHours: 12,
      reconciledAt: tickAt
    });
    expect(processDueJobs).toHaveBeenCalledWith({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: tickAt
    });
    expect(result.unreadReconciliation.stats.participantsScanned).toBe(4);
    expect(result.runtimeReconciliation.transitionedOffline).toBe(1);
    expect(result.triggerQueueProcessing.claimedJobs).toBe(2);
  });
});
