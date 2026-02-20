import { describe, expect, it, vi } from "vitest";

import type { TriggerPtyAdapter } from "./pty-adapter.js";
import { InMemoryRuntimeRegistryStore } from "./runtime-registry.js";
import { ManagedRuntimeTriggerJobExecutor } from "./runtime-trigger-executor.js";
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
  reason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}): TriggerJobRecord => ({
  triggerId: input.triggerId,
  threadId: input.threadId ?? "th_01",
  workspaceId: "wk_01",
  targetAgentId: input.targetAgentId ?? "reviewer_agent",
  targetSessionId: "sess_01",
  reason: input.reason ?? "new_unread_messages",
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

  it("persists explicit force-override audit details in trigger attempts", async () => {
    const store = new InMemoryTriggerQueueStore([
      queuedJob({
        triggerId: "trg_09",
        maxRetries: 2,
        reason: "human_override:urgent_escalation"
      })
    ]);
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    await runtimeStore.upsertFromHeartbeat({
      agentId: "reviewer_agent",
      workspaceId: "wk_01",
      sessionId: "sess_01",
      runtime: "tmux:agents_mobile_core:reviewer.0",
      managementMode: "managed",
      resumable: true,
      status: "active",
      heartbeatAt: new Date("2026-02-18T10:00:00.000Z")
    });
    const deliver = vi.fn<TriggerPtyAdapter["deliver"]>(() =>
      Promise.resolve({
        delivered: true,
        details: {
          target: "agents_mobile_core:reviewer.0"
        }
      })
    );
    const executor = new ManagedRuntimeTriggerJobExecutor(runtimeStore, { deliver });
    const processor = new TriggerQueueProcessor(store, executor, new NoopTriggerFallbackExecutor());

    const result = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: new Date("2026-02-18T10:01:00.000Z")
    });

    expect(result.delivered).toBe(1);
    const attempts = store.getAttemptsByTrigger("trg_09");
    expect(attempts).toHaveLength(1);
    const details = attempts[0]?.details;
    const audit = details?.["force_override_audit"] as Record<string, unknown> | undefined;
    expect(audit).toEqual({
      force_override_requested: true,
      force_override_applied: true,
      override_intent: "human_override",
      override_reason_prefix: "human_override:",
      collision_gate: "bypassed"
    });
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerId: "trg_09",
        forceOverride: true
      })
    );
  });

  it("preserves prior attempt details when loop guard auto-blocks", async () => {
    const store = new InMemoryTriggerQueueStore([
      queuedJob({
        triggerId: "trg_10",
        maxRetries: 2
      })
    ]);
    const executor: TriggerJobExecutor = {
      execute: () =>
        Promise.resolve({
          attemptResult: "timeout",
          retryable: true,
          errorCode: "SAME_FINDING",
          details: {
            force_override_audit: {
              force_override_requested: true,
              force_override_applied: true,
              override_intent: "human_override",
              override_reason_prefix: "human_override:",
              collision_gate: "bypassed"
            }
          }
        } satisfies TriggerExecutionOutcome)
    };
    const processor = new TriggerQueueProcessor(store, executor, new NoopTriggerFallbackExecutor(), {
      deferRecheckMs: 5000,
      rateLimitPerMinute: 10,
      loopMaxTurns: 1,
      loopMaxRepeatedFindings: 3
    });

    const result = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: new Date("2026-02-18T10:01:00.000Z")
    });

    expect(result.autoBlocked).toBe(1);
    const attempts = store.getAttemptsByTrigger("trg_10");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.errorCode).toBe("THREAD_AUTO_BLOCKED");
    const details = attempts[0]?.details;
    const priorOutcome = details?.["prior_outcome"] as Record<string, unknown> | undefined;
    const audit = priorOutcome?.["force_override_audit"] as Record<string, unknown> | undefined;
    expect(audit?.["force_override_requested"]).toBe(true);
    expect(audit?.["force_override_applied"]).toBe(true);
    expect(details?.["reason"]).toBe("no_progress_turns:1");
  });
});
