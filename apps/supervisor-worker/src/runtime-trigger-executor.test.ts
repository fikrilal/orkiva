import { describe, expect, it, vi } from "vitest";

import { InMemoryRuntimeRegistryStore } from "./runtime-registry.js";
import { ManagedRuntimeTriggerJobExecutor } from "./runtime-trigger-executor.js";
import type { TriggerPtyAdapter } from "./pty-adapter.js";
import type { TriggerJobRecord } from "./trigger-queue.js";

const baseJob = (overrides: Partial<TriggerJobRecord> = {}): TriggerJobRecord => ({
  triggerId: "trg_01",
  threadId: "th_01",
  workspaceId: "wk_01",
  targetAgentId: "reviewer_agent",
  targetSessionId: "sess_01",
  reason: "new_unread_messages",
  prompt: "continue",
  status: "triggering",
  attempts: 0,
  maxRetries: 2,
  nextRetryAt: null,
  createdAt: new Date("2026-02-18T10:00:00.000Z"),
  updatedAt: new Date("2026-02-18T10:00:00.000Z"),
  ...overrides
});

const seedRuntime = async (
  store: InMemoryRuntimeRegistryStore,
  input?: {
    managementMode?: "managed" | "unmanaged";
    status?: "active" | "idle" | "offline";
    sessionId?: string;
    runtime?: string;
  }
): Promise<void> => {
  await store.upsertFromHeartbeat({
    agentId: "reviewer_agent",
    workspaceId: "wk_01",
    sessionId: input?.sessionId ?? "sess_01",
    runtime: input?.runtime ?? "tmux:agents_mobile_core:reviewer.0",
    managementMode: input?.managementMode ?? "managed",
    resumable: true,
    status: input?.status ?? "active",
    heartbeatAt: new Date("2026-02-18T10:00:00.000Z")
  });
};

describe("ManagedRuntimeTriggerJobExecutor", () => {
  it("fails non-retryable when runtime is not found", async () => {
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    const deliver = vi.fn();
    const ptyAdapter: TriggerPtyAdapter = {
      deliver
    };
    const executor = new ManagedRuntimeTriggerJobExecutor(runtimeStore, ptyAdapter);

    const result = await executor.execute({
      job: baseJob(),
      attemptNo: 1,
      now: new Date("2026-02-18T10:00:00.000Z")
    });

    expect(result).toEqual({
      attemptResult: "failed",
      retryable: false,
      errorCode: "RUNTIME_NOT_FOUND",
      details: {
        triggerId: "trg_01",
        targetAgentId: "reviewer_agent",
        workspaceId: "wk_01",
        targetSessionId: "sess_01"
      }
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("fails non-retryable when runtime session mismatches", async () => {
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    await seedRuntime(runtimeStore, {
      sessionId: "sess_latest"
    });
    const deliver = vi.fn();
    const ptyAdapter: TriggerPtyAdapter = {
      deliver
    };
    const executor = new ManagedRuntimeTriggerJobExecutor(runtimeStore, ptyAdapter);

    const result = await executor.execute({
      job: baseJob({
        targetSessionId: "sess_old"
      }),
      attemptNo: 1,
      now: new Date("2026-02-18T10:00:00.000Z")
    });

    expect(result).toEqual({
      attemptResult: "failed",
      retryable: false,
      errorCode: "RUNTIME_SESSION_MISMATCH",
      details: {
        triggerId: "trg_01",
        targetAgentId: "reviewer_agent",
        workspaceId: "wk_01",
        targetSessionId: "sess_old",
        runtimeSessionId: "sess_latest"
      }
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("fails non-retryable when runtime is unmanaged", async () => {
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    await seedRuntime(runtimeStore, {
      managementMode: "unmanaged"
    });
    const deliver = vi.fn();
    const ptyAdapter: TriggerPtyAdapter = {
      deliver
    };
    const executor = new ManagedRuntimeTriggerJobExecutor(runtimeStore, ptyAdapter);

    const result = await executor.execute({
      job: baseJob(),
      attemptNo: 1,
      now: new Date("2026-02-18T10:00:00.000Z")
    });

    expect(result).toEqual({
      attemptResult: "failed",
      retryable: false,
      errorCode: "RUNTIME_UNMANAGED",
      details: {
        triggerId: "trg_01",
        targetAgentId: "reviewer_agent",
        workspaceId: "wk_01",
        targetSessionId: "sess_01",
        managementMode: "unmanaged"
      }
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("returns retryable timeout when runtime is offline", async () => {
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    await seedRuntime(runtimeStore, {
      status: "offline"
    });
    const deliver = vi.fn();
    const ptyAdapter: TriggerPtyAdapter = {
      deliver
    };
    const executor = new ManagedRuntimeTriggerJobExecutor(runtimeStore, ptyAdapter);

    const result = await executor.execute({
      job: baseJob(),
      attemptNo: 1,
      now: new Date("2026-02-18T10:00:00.000Z")
    });

    expect(result).toEqual({
      attemptResult: "timeout",
      retryable: true,
      errorCode: "RUNTIME_OFFLINE",
      details: {
        triggerId: "trg_01",
        targetAgentId: "reviewer_agent",
        workspaceId: "wk_01",
        targetSessionId: "sess_01",
        status: "offline"
      }
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("maps retryable adapter failures to timeout", async () => {
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    await seedRuntime(runtimeStore);
    const ptyAdapter: TriggerPtyAdapter = {
      deliver: () =>
        Promise.resolve({
          delivered: false,
          errorCode: "TARGET_NOT_FOUND",
          details: {
            target: "agents_mobile_core:reviewer.0"
          }
        })
    };
    const executor = new ManagedRuntimeTriggerJobExecutor(runtimeStore, ptyAdapter);

    const result = await executor.execute({
      job: baseJob(),
      attemptNo: 1,
      now: new Date("2026-02-18T10:00:00.000Z")
    });

    expect(result).toEqual({
      attemptResult: "timeout",
      retryable: true,
      errorCode: "TARGET_NOT_FOUND",
      details: {
        target: "agents_mobile_core:reviewer.0"
      }
    });
  });

  it("maps non-retryable adapter failures to failed", async () => {
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    await seedRuntime(runtimeStore);
    const ptyAdapter: TriggerPtyAdapter = {
      deliver: () =>
        Promise.resolve({
          delivered: false,
          errorCode: "TRIGGER_PAYLOAD_TOO_LARGE",
          details: {
            payloadBytes: 16000
          }
        })
    };
    const executor = new ManagedRuntimeTriggerJobExecutor(runtimeStore, ptyAdapter);

    const result = await executor.execute({
      job: baseJob(),
      attemptNo: 1,
      now: new Date("2026-02-18T10:00:00.000Z")
    });

    expect(result).toEqual({
      attemptResult: "failed",
      retryable: false,
      errorCode: "TRIGGER_PAYLOAD_TOO_LARGE",
      details: {
        payloadBytes: 16000
      }
    });
  });

  it("returns delivered when adapter delivery succeeds", async () => {
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    await seedRuntime(runtimeStore);
    const ptyAdapter: TriggerPtyAdapter = {
      deliver: () =>
        Promise.resolve({
          delivered: true,
          details: {
            target: "agents_mobile_core:reviewer.0"
          }
        })
    };
    const executor = new ManagedRuntimeTriggerJobExecutor(runtimeStore, ptyAdapter);

    const result = await executor.execute({
      job: baseJob(),
      attemptNo: 1,
      now: new Date("2026-02-18T10:00:00.000Z")
    });

    expect(result).toEqual({
      attemptResult: "delivered",
      retryable: false,
      details: {
        target: "agents_mobile_core:reviewer.0"
      }
    });
  });

  it("bypasses quiet-window defer with explicit force override and emits audit details", async () => {
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    await seedRuntime(runtimeStore);
    const deliver = vi
      .fn<TriggerPtyAdapter["deliver"]>()
      .mockResolvedValueOnce({
        delivered: false,
        errorCode: "OPERATOR_BUSY",
        details: {
          target: "agents_mobile_core:reviewer.0"
        }
      })
      .mockResolvedValueOnce({
        delivered: true,
        details: {
          target: "agents_mobile_core:reviewer.0"
        }
      });
    const ptyAdapter: TriggerPtyAdapter = {
      deliver
    };
    const executor = new ManagedRuntimeTriggerJobExecutor(runtimeStore, ptyAdapter, {
      quietWindowMs: 20_000,
      recheckMs: 5_000,
      maxDeferMs: 60_000
    });

    const first = await executor.execute({
      job: baseJob({
        triggerId: "trg_09",
        reason: "new_unread_messages",
        createdAt: new Date("2026-02-18T10:00:00.000Z")
      }),
      attemptNo: 1,
      now: new Date("2026-02-18T10:00:05.000Z")
    });
    expect(first.attemptResult).toBe("deferred");

    const second = await executor.execute({
      job: baseJob({
        triggerId: "trg_10",
        reason: "human_override:urgent_escalation",
        createdAt: new Date("2026-02-18T10:00:00.000Z")
      }),
      attemptNo: 1,
      now: new Date("2026-02-18T10:00:06.000Z")
    });

    expect(second).toEqual({
      attemptResult: "delivered",
      retryable: false,
      details: {
        target: "agents_mobile_core:reviewer.0",
        force_override_audit: {
          force_override_requested: true,
          force_override_applied: true,
          override_intent: "human_override",
          override_reason_prefix: "human_override:",
          collision_gate: "bypassed"
        }
      }
    });
    expect(deliver).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        triggerId: "trg_10",
        reason: "human_override:urgent_escalation",
        forceOverride: true
      })
    );
  });

  it("defers when operator is busy and respects defer timeout", async () => {
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    await seedRuntime(runtimeStore);
    const ptyAdapter: TriggerPtyAdapter = {
      deliver: () =>
        Promise.resolve({
          delivered: false,
          errorCode: "OPERATOR_BUSY",
          details: {
            target: "agents_mobile_core:reviewer.0"
          }
        })
    };
    const executor = new ManagedRuntimeTriggerJobExecutor(runtimeStore, ptyAdapter, {
      quietWindowMs: 20_000,
      recheckMs: 5_000,
      maxDeferMs: 60_000
    });

    const deferred = await executor.execute({
      job: baseJob({
        createdAt: new Date("2026-02-18T10:00:00.000Z")
      }),
      attemptNo: 1,
      now: new Date("2026-02-18T10:00:05.000Z")
    });
    expect(deferred).toEqual({
      attemptResult: "deferred",
      retryable: true,
      retryAfterMs: 5000,
      errorCode: "OPERATOR_BUSY",
      details: {
        runtime: "tmux:agents_mobile_core:reviewer.0",
        deferredMs: 5000,
        quietWindowMs: 20000,
        maxDeferMs: 60000,
        delivery: {
          target: "agents_mobile_core:reviewer.0"
        }
      }
    });

    const timeout = await executor.execute({
      job: baseJob({
        createdAt: new Date("2026-02-18T10:00:00.000Z")
      }),
      attemptNo: 2,
      now: new Date("2026-02-18T10:01:00.000Z")
    });
    expect(timeout).toEqual({
      attemptResult: "timeout",
      retryable: false,
      errorCode: "DEFER_TIMEOUT",
      details: {
        runtime: "tmux:agents_mobile_core:reviewer.0",
        deferredMs: 60000,
        maxDeferMs: 60000,
        delivery: {
          target: "agents_mobile_core:reviewer.0"
        }
      }
    });
  });
});
