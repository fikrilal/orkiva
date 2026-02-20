import { describe, expect, it, vi } from "vitest";

import {
  InMemoryTriggerQueueStore,
  NoopTriggerFallbackExecutor,
  TriggerQueueProcessor,
  type TriggerExecutionOutcome,
  type TriggerFallbackExecutor,
  type TriggerJobExecutor,
  type TriggerJobRecord
} from "./trigger-queue.js";

const queuedJob = (input: {
  triggerId: string;
  maxRetries: number;
  attempts?: number;
  status?: "queued" | "timeout" | "deferred";
  nextRetryAt?: Date | null;
  threadId?: string;
  targetAgentId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}): TriggerJobRecord => ({
  triggerId: input.triggerId,
  threadId: input.threadId ?? "th_01",
  workspaceId: "wk_01",
  targetAgentId: input.targetAgentId ?? "reviewer_agent",
  targetSessionId: "sess_01",
  reason: "new_unread_messages",
  prompt: "Read unread and continue.",
  status: input.status ?? "queued",
  attempts: input.attempts ?? 0,
  maxRetries: input.maxRetries,
  nextRetryAt: input.nextRetryAt ?? null,
  createdAt: input.createdAt ?? new Date("2026-02-18T10:00:00.000Z"),
  updatedAt: input.updatedAt ?? new Date("2026-02-18T10:00:00.000Z")
});

describe("trigger queue processing", () => {
  it("retries transient timeout and then delivers successfully", async () => {
    const store = new InMemoryTriggerQueueStore([
      queuedJob({
        triggerId: "trg_01",
        maxRetries: 2
      })
    ]);
    const outcomes: TriggerExecutionOutcome[] = [
      {
        attemptResult: "timeout",
        retryable: true,
        errorCode: "ACK_TIMEOUT"
      },
      {
        attemptResult: "delivered",
        retryable: false
      }
    ];
    const executor: TriggerJobExecutor = {
      execute: vi.fn(() => Promise.resolve(outcomes.shift() ?? outcomes[1]!))
    };
    const processor = new TriggerQueueProcessor(
      store,
      executor,
      new NoopTriggerFallbackExecutor(),
      {
        deferRecheckMs: 5000,
        rateLimitPerMinute: 10,
        loopMaxTurns: 20,
        loopMaxRepeatedFindings: 3
      },
      1000,
      10000
    );

    const firstTick = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: new Date("2026-02-18T10:01:00.000Z")
    });
    expect(firstTick.claimedJobs).toBe(1);
    expect(firstTick.retried).toBe(1);
    expect(firstTick.fallbackResumed).toBe(0);
    const afterFirst = await store.getJobById("trg_01");
    expect(afterFirst?.status).toBe("timeout");
    expect(afterFirst?.attempts).toBe(1);
    expect(afterFirst?.nextRetryAt?.toISOString()).toBe("2026-02-18T10:01:01.000Z");

    const secondTick = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: new Date("2026-02-18T10:01:02.000Z")
    });
    expect(secondTick.claimedJobs).toBe(1);
    expect(secondTick.delivered).toBe(1);
    const afterSecond = await store.getJobById("trg_01");
    expect(afterSecond?.status).toBe("delivered");
    expect(afterSecond?.attempts).toBe(2);
    expect(afterSecond?.nextRetryAt).toBeNull();
  });

  it("executes fallback chain after max retry exhaustion", async () => {
    const store = new InMemoryTriggerQueueStore([
      queuedJob({
        triggerId: "trg_02",
        maxRetries: 1
      })
    ]);
    const executor: TriggerJobExecutor = {
      execute: () =>
        Promise.resolve({
          attemptResult: "timeout",
          retryable: true,
          errorCode: "ACK_TIMEOUT"
        })
    };
    const fallbackExecutor: TriggerFallbackExecutor = {
      execute: () =>
        Promise.resolve({
          attemptResult: "fallback_resume_succeeded",
          nextStatus: "fallback_resume"
        })
    };
    const processor = new TriggerQueueProcessor(store, executor, fallbackExecutor, {
      deferRecheckMs: 5000,
      rateLimitPerMinute: 10,
      loopMaxTurns: 20,
      loopMaxRepeatedFindings: 3
    });

    await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: new Date("2026-02-18T10:01:00.000Z")
    });
    const second = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: new Date("2026-02-18T10:01:02.000Z")
    });

    expect(second.failed).toBe(0);
    expect(second.fallbackResumed).toBe(1);
    const final = await store.getJobById("trg_02");
    expect(final?.status).toBe("fallback_resume");
    expect(final?.attempts).toBe(2);
  });

  it("applies per-thread+agent rate limits with deferred retries", async () => {
    const store = new InMemoryTriggerQueueStore([
      queuedJob({
        triggerId: "trg_03",
        maxRetries: 2
      }),
      queuedJob({
        triggerId: "trg_04",
        maxRetries: 2
      })
    ]);
    const executor: TriggerJobExecutor = {
      execute: vi.fn(() =>
        Promise.resolve({
          attemptResult: "delivered",
          retryable: false
        } satisfies TriggerExecutionOutcome)
      )
    };
    const processor = new TriggerQueueProcessor(
      store,
      executor,
      new NoopTriggerFallbackExecutor(),
      {
        deferRecheckMs: 5000,
        rateLimitPerMinute: 1,
        loopMaxTurns: 20,
        loopMaxRepeatedFindings: 3
      }
    );

    const result = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: new Date("2026-02-18T10:01:00.000Z")
    });

    expect(result.claimedJobs).toBe(2);
    expect(result.delivered).toBe(1);
    expect(result.retried).toBe(1);
    const second = await store.getJobById("trg_04");
    expect(second?.status).toBe("deferred");
    expect(second?.nextRetryAt?.toISOString()).toBe("2026-02-18T10:02:00.000Z");
  });

  it("auto-blocks thread when repeated identical findings exceed threshold", async () => {
    const store = new InMemoryTriggerQueueStore([
      queuedJob({
        triggerId: "trg_05",
        maxRetries: 0,
        threadId: "th_loop"
      }),
      queuedJob({
        triggerId: "trg_06",
        maxRetries: 0,
        threadId: "th_loop"
      }),
      queuedJob({
        triggerId: "trg_07",
        maxRetries: 0,
        threadId: "th_loop"
      })
    ]);
    const executor: TriggerJobExecutor = {
      execute: () =>
        Promise.resolve({
          attemptResult: "failed",
          retryable: false,
          errorCode: "SAME_FINDING"
        })
    };
    const processor = new TriggerQueueProcessor(
      store,
      executor,
      new NoopTriggerFallbackExecutor(),
      {
        deferRecheckMs: 5000,
        rateLimitPerMinute: 10,
        loopMaxTurns: 20,
        loopMaxRepeatedFindings: 3
      }
    );

    const first = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 1,
      processedAt: new Date("2026-02-18T10:01:00.000Z")
    });
    expect(first.autoBlocked).toBe(0);
    const second = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 1,
      processedAt: new Date("2026-02-18T10:01:10.000Z")
    });
    expect(second.autoBlocked).toBe(0);
    const third = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 1,
      processedAt: new Date("2026-02-18T10:01:20.000Z")
    });
    expect(third.autoBlocked).toBe(1);
  });

  it("prevents double processing under concurrent workers", async () => {
    const store = new InMemoryTriggerQueueStore([
      queuedJob({
        triggerId: "trg_08",
        maxRetries: 2
      })
    ]);
    const execute = vi.fn(() =>
      Promise.resolve({
        attemptResult: "delivered",
        retryable: false
      } satisfies TriggerExecutionOutcome)
    );
    const executor: TriggerJobExecutor = {
      execute
    };
    const workerA = new TriggerQueueProcessor(store, executor);
    const workerB = new TriggerQueueProcessor(store, executor);

    const [left, right] = await Promise.all([
      workerA.processDueJobs({
        workspaceId: "wk_01",
        limit: 1,
        processedAt: new Date("2026-02-18T10:01:00.000Z")
      }),
      workerB.processDueJobs({
        workspaceId: "wk_01",
        limit: 1,
        processedAt: new Date("2026-02-18T10:01:00.000Z")
      })
    ]);

    expect(left.claimedJobs + right.claimedJobs).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const final = await store.getJobById("trg_08");
    expect(final?.status).toBe("delivered");
    expect(final?.attempts).toBe(1);
  });
});
