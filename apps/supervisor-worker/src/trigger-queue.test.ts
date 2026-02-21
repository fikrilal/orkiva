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
  status?:
    | "queued"
    | "timeout"
    | "deferred"
    | "fallback_resume"
    | "fallback_spawn"
    | "callback_pending"
    | "callback_retry";
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
    expect(afterSecond?.status).toBe("callback_pending");
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
    expect(final?.status).toBe("callback_pending");
    expect(final?.attempts).toBe(2);
  });

  it("claims fallback-required jobs and routes them directly to fallback executor", async () => {
    const store = new InMemoryTriggerQueueStore([
      queuedJob({
        triggerId: "trg_fallback_queued_01",
        maxRetries: 0,
        status: "fallback_spawn"
      })
    ]);
    const execute = vi.fn<TriggerJobExecutor["execute"]>(() =>
      Promise.resolve({
        attemptResult: "delivered",
        retryable: false
      })
    );
    const executor: TriggerJobExecutor = { execute };
    const fallbackExecutor: TriggerFallbackExecutor = {
      execute: () =>
        Promise.resolve({
          attemptResult: "fallback_spawned",
          nextStatus: "fallback_spawn"
        })
    };
    const processor = new TriggerQueueProcessor(store, executor, fallbackExecutor, {
      deferRecheckMs: 5000,
      rateLimitPerMinute: 10,
      loopMaxTurns: 20,
      loopMaxRepeatedFindings: 3
    });

    const result = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: new Date("2026-02-18T10:01:00.000Z")
    });

    expect(result.claimedJobs).toBe(1);
    expect(result.fallbackSpawned).toBe(1);
    expect(execute).toHaveBeenCalledTimes(0);
    const final = await store.getJobById("trg_fallback_queued_01");
    expect(final?.status).toBe("callback_pending");
    expect(final?.attempts).toBe(1);

    const second = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: new Date("2026-02-18T10:01:05.000Z")
    });
    expect(second.claimedJobs).toBe(1);
    expect(second.fallbackSpawned).toBe(0);
    expect(second.callbackFailed).toBe(1);
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
    const execute = vi.fn(() =>
      Promise.resolve({
        attemptResult: "delivered",
        retryable: false
      } satisfies TriggerExecutionOutcome)
    );
    const executor: TriggerJobExecutor = { execute };
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
    expect(final?.status).toBe("callback_pending");
    expect(final?.attempts).toBe(1);
  });

  it("propagates request correlation ids into attempt details and worker logs", async () => {
    const store = new InMemoryTriggerQueueStore([
      queuedJob({
        triggerId: "trg_req_corr_01",
        maxRetries: 0
      })
    ]);
    const executor: TriggerJobExecutor = {
      execute: () =>
        Promise.resolve({
          attemptResult: "delivered",
          retryable: false
        })
    };
    const info = vi.fn();
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
      2000,
      60000,
      { info }
    );

    const result = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: new Date("2026-02-18T10:01:00.000Z")
    });

    expect(result.delivered).toBe(1);
    const attempts = store.getAttemptsByTrigger("trg_req_corr_01");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.details?.["request_id"]).toBe("req_corr_01");
    expect(attempts[0]?.details?.["trigger_id"]).toBe("trg_req_corr_01");
    expect(info).toHaveBeenCalledWith(
      "trigger.job.claimed",
      expect.objectContaining({
        request_id: "req_corr_01",
        trigger_id: "trg_req_corr_01"
      })
    );
    expect(info).toHaveBeenCalledWith(
      "trigger.attempt.recorded",
      expect.objectContaining({
        request_id: "req_corr_01",
        trigger_id: "trg_req_corr_01",
        attempt_result: "delivered"
      })
    );
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

  it("delivers callback events from callback_pending jobs", async () => {
    const job = queuedJob({
      triggerId: "trg_callback_pending_01",
      maxRetries: 0,
      status: "callback_pending",
      attempts: 2
    });
    const store = new InMemoryTriggerQueueStore([job]);

    const executor: TriggerJobExecutor = {
      execute: () =>
        Promise.resolve({
          attemptResult: "delivered",
          retryable: false
        })
    };
    const callbackExecutor = {
      execute: () =>
        Promise.resolve({
          attemptResult: "callback_post_succeeded",
          retryable: false
        } as const)
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
      2000,
      60000,
      undefined,
      8000,
      45000,
      3,
      callbackExecutor
    );

    const result = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: new Date("2026-02-18T10:01:00.000Z")
    });

    expect(result.callbackDelivered).toBe(1);
    const final = await store.getJobById(job.triggerId);
    expect(final?.status).toBe("callback_delivered");
  });

  it("reclaims stale triggering jobs into callback retry path when execution already succeeded", async () => {
    const reclaimedAt = new Date("2026-02-18T10:05:00.000Z");
    const triggerId = "trg_reclaim_callback_01";
    const store = new InMemoryTriggerQueueStore([
      {
        ...queuedJob({
          triggerId,
          maxRetries: 2,
          status: "queued",
          attempts: 0
        }),
        status: "triggering",
        attempts: 1,
        updatedAt: new Date("2026-02-18T10:00:00.000Z")
      }
    ]);
    (
      store as unknown as {
        attemptsByTrigger: Map<string, Array<Record<string, unknown>>>;
      }
    ).attemptsByTrigger.set(triggerId, [
      {
        attemptNo: 1,
        attemptResult: "delivered",
        createdAt: new Date("2026-02-18T10:00:00.000Z")
      }
    ]);

    const execute = vi.fn(() =>
      Promise.resolve({
        attemptResult: "delivered",
        retryable: false
      } satisfies TriggerExecutionOutcome)
    );
    const executor: TriggerJobExecutor = { execute };
    const executeCallback = vi.fn(() =>
      Promise.resolve({
        attemptResult: "callback_post_succeeded",
        retryable: false
      } as const)
    );
    const callbackExecutor = { execute: executeCallback };
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
      2000,
      60000,
      undefined,
      8000,
      45000,
      3,
      callbackExecutor
    );

    const result = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: reclaimedAt
    });

    expect(result.callbackDelivered).toBe(1);
    expect(execute).toHaveBeenCalledTimes(0);
    expect(executeCallback).toHaveBeenCalledTimes(1);
    const final = await store.getJobById(triggerId);
    expect(final?.status).toBe("callback_delivered");
  });

  it("reclaims stale triggering jobs into executor retry path when execution phase is unknown", async () => {
    const triggerId = "trg_reclaim_executor_01";
    const store = new InMemoryTriggerQueueStore([
      {
        ...queuedJob({
          triggerId,
          maxRetries: 2
        }),
        status: "triggering",
        attempts: 0,
        updatedAt: new Date("2026-02-18T10:00:00.000Z")
      }
    ]);
    const execute = vi.fn(() =>
      Promise.resolve({
        attemptResult: "delivered",
        retryable: false
      } satisfies TriggerExecutionOutcome)
    );
    const executor: TriggerJobExecutor = { execute };
    const processor = new TriggerQueueProcessor(store, executor, new NoopTriggerFallbackExecutor(), {
      deferRecheckMs: 5000,
      rateLimitPerMinute: 10,
      loopMaxTurns: 20,
      loopMaxRepeatedFindings: 3
    });

    const result = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: new Date("2026-02-18T10:05:00.000Z")
    });

    expect(result.delivered).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const final = await store.getJobById(triggerId);
    expect(final?.status).toBe("callback_pending");
    expect(final?.attempts).toBe(1);
  });

  it("records deterministic failure when executor throws", async () => {
    const store = new InMemoryTriggerQueueStore([
      queuedJob({
        triggerId: "trg_executor_throw_01",
        maxRetries: 0
      })
    ]);
    const executor: TriggerJobExecutor = {
      execute: () => Promise.reject(new Error("executor blew up"))
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

    const result = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: new Date("2026-02-18T10:01:00.000Z")
    });

    expect(result.claimedJobs).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(1);
    const final = await store.getJobById("trg_executor_throw_01");
    expect(final?.status).toBe("failed");
    const attempts = store.getAttemptsByTrigger("trg_executor_throw_01");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.errorCode).toBe("TRIGGER_EXECUTOR_EXCEPTION");
  });

  it("times out hanging fallback execution and persists attempt", async () => {
    const store = new InMemoryTriggerQueueStore([
      queuedJob({
        triggerId: "trg_fallback_timeout_01",
        maxRetries: 0
      })
    ]);
    const executor: TriggerJobExecutor = {
      execute: () =>
        Promise.resolve({
          attemptResult: "failed",
          retryable: false,
          errorCode: "RUNTIME_NOT_FOUND"
        })
    };
    const hangingFallback: TriggerFallbackExecutor = {
      execute: () => new Promise(() => undefined)
    };
    const processor = new TriggerQueueProcessor(
      store,
      executor,
      hangingFallback,
      {
        deferRecheckMs: 5000,
        rateLimitPerMinute: 10,
        loopMaxTurns: 20,
        loopMaxRepeatedFindings: 3
      },
      2000,
      60000,
      undefined,
      20
    );

    const result = await processor.processDueJobs({
      workspaceId: "wk_01",
      limit: 10,
      processedAt: new Date("2026-02-18T10:01:00.000Z")
    });

    expect(result.claimedJobs).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(1);
    const final = await store.getJobById("trg_fallback_timeout_01");
    expect(final?.status).toBe("failed");
    const attempts = store.getAttemptsByTrigger("trg_fallback_timeout_01");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.errorCode).toBe("TRIGGER_FALLBACK_TIMEOUT");
  });
});
