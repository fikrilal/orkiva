import { describe, expect, it, vi } from "vitest";

import {
  InMemoryTriggerQueueStore,
  TriggerQueueProcessor,
  type TriggerExecutionOutcome,
  type TriggerJobExecutor,
  type TriggerJobRecord
} from "./trigger-queue.js";

const queuedJob = (input: {
  triggerId: string;
  maxRetries: number;
  attempts?: number;
  status?: "queued" | "timeout" | "deferred";
  nextRetryAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}): TriggerJobRecord => ({
  triggerId: input.triggerId,
  threadId: "th_01",
  workspaceId: "wk_01",
  targetAgentId: "reviewer_agent",
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
    const fallbackOutcome: TriggerExecutionOutcome = {
      attemptResult: "delivered",
      retryable: false
    };
    const executor: TriggerJobExecutor = {
      execute: vi.fn((input) => {
        void input;
        return Promise.resolve(outcomes.shift() ?? fallbackOutcome);
      })
    };
    const processor = new TriggerQueueProcessor(store, executor, 1000, 10000);

    const firstTick = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: new Date("2026-02-18T10:01:00.000Z")
    });
    expect(firstTick.claimedJobs).toBe(1);
    expect(firstTick.retried).toBe(1);
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

  it("moves jobs to dead-letter after max retry exhaustion", async () => {
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
    const processor = new TriggerQueueProcessor(store, executor, 1000, 10000);

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

    expect(second.failed).toBe(1);
    expect(second.deadLettered).toBe(1);
    expect(second.deadLetterJobIds).toContain("trg_02");
    const final = await store.getJobById("trg_02");
    expect(final?.status).toBe("failed");
    expect(final?.attempts).toBe(2);
  });

  it("prevents double processing under concurrent workers", async () => {
    const store = new InMemoryTriggerQueueStore([
      queuedJob({
        triggerId: "trg_03",
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
    const workerA = new TriggerQueueProcessor(store, executor, 1000, 10000);
    const workerB = new TriggerQueueProcessor(store, executor, 1000, 10000);

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
    const final = await store.getJobById("trg_03");
    expect(final?.status).toBe("delivered");
    expect(final?.attempts).toBe(1);
  });
});
