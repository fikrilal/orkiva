import { describe, expect, it, vi } from "vitest";

import { InMemoryRuntimeRegistryStore } from "./runtime-registry.js";
import { CodexFallbackExecutor } from "./runtime-fallback.js";
import type { TriggerExecutionOutcome, TriggerJobRecord } from "./trigger-queue.js";

const baseJob = (overrides: Partial<TriggerJobRecord> = {}): TriggerJobRecord => ({
  triggerId: "trg_01",
  threadId: "th_01",
  workspaceId: "wk_01",
  targetAgentId: "reviewer_agent",
  targetSessionId: "sess_01",
  reason: "new_unread_messages",
  prompt: "Read unread and continue.",
  status: "triggering",
  attempts: 1,
  maxRetries: 2,
  nextRetryAt: null,
  createdAt: new Date("2026-02-18T10:00:00.000Z"),
  updatedAt: new Date("2026-02-18T10:00:00.000Z"),
  ...overrides
});

const seedRuntime = async (
  store: InMemoryRuntimeRegistryStore,
  heartbeatAt = new Date("2026-02-18T10:00:00.000Z")
): Promise<void> => {
  await store.upsertFromHeartbeat({
    agentId: "reviewer_agent",
    workspaceId: "wk_01",
    sessionId: "sess_01",
    runtime: "tmux:agents_mobile_core:reviewer.0",
    managementMode: "managed",
    resumable: true,
    status: "idle",
    heartbeatAt
  });
};

const initialOutcome: TriggerExecutionOutcome = {
  attemptResult: "timeout",
  retryable: false,
  errorCode: "ACK_TIMEOUT"
};

describe("CodexFallbackExecutor", () => {
  it("resumes session when runtime is healthy and start succeeds", async () => {
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    await seedRuntime(runtimeStore);
    const startDetached = vi.fn(() =>
      Promise.resolve({
        started: true,
        pid: 1234
      })
    );
    const executor = new CodexFallbackExecutor(runtimeStore, {
      run: vi.fn(),
      startDetached
    });

    const result = await executor.execute({
      job: baseJob(),
      attemptNo: 2,
      initialOutcome,
      now: new Date("2026-02-18T10:01:00.000Z")
    });

    expect(result).toEqual({
      attemptResult: "fallback_resume_succeeded",
      nextStatus: "fallback_resume",
      launchMode: "resume",
      pid: 1234,
      details: {
        resumeAttempt: 1,
        resumeMaxAttempts: 2,
        launch_mode: "detached",
        pid: 1234
      }
    });
    expect(startDetached).toHaveBeenCalledWith({
      command: "codex",
      args: ["exec", "resume", "sess_01", "Read unread and continue."]
    });
  });

  it("uses dangerous bypass flag only when explicitly enabled", async () => {
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    await seedRuntime(runtimeStore);
    const startDetached = vi.fn(() =>
      Promise.resolve({
        started: true,
        pid: 5678
      })
    );
    const executor = new CodexFallbackExecutor(
      runtimeStore,
      {
        run: vi.fn(),
        startDetached
      },
      {
        resumeMaxAttempts: 2,
        staleAfterHours: 12,
        crashLoopThreshold: 3,
        crashLoopWindowMs: 15 * 60 * 1000,
        allowDangerousBypass: true
      }
    );

    await executor.execute({
      job: baseJob(),
      attemptNo: 2,
      initialOutcome,
      now: new Date("2026-02-18T10:01:00.000Z")
    });

    expect(startDetached).toHaveBeenCalledWith({
      command: "codex",
      args: [
        "--dangerously-bypass-approvals-and-sandbox",
        "exec",
        "resume",
        "sess_01",
        "Read unread and continue."
      ]
    });
  });

  it("skips resume for stale session and spawns directly", async () => {
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    await seedRuntime(runtimeStore, new Date("2026-02-17T08:00:00.000Z"));
    const startDetached = vi.fn(() =>
      Promise.resolve({
        started: true,
        pid: 4321
      })
    );
    const executor = new CodexFallbackExecutor(
      runtimeStore,
      {
        run: vi.fn(),
        startDetached
      },
      {
        resumeMaxAttempts: 2,
        staleAfterHours: 12,
        crashLoopThreshold: 3,
        crashLoopWindowMs: 15 * 60 * 1000,
        allowDangerousBypass: false
      }
    );

    const result = await executor.execute({
      job: baseJob(),
      attemptNo: 2,
      initialOutcome,
      now: new Date("2026-02-18T10:01:00.000Z")
    });

    expect(result.attemptResult).toBe("fallback_spawned");
    expect(result.nextStatus).toBe("fallback_spawn");
    expect(result.launchMode).toBe("spawn");
    expect(result.pid).toBe(4321);
    expect(result.details).toEqual({
      resumeSkippedReason: "SESSION_STALE",
      command: "codex exec <thread_summary_prompt>",
      launch_mode: "detached",
      pid: 4321
    });
    expect(startDetached).toHaveBeenCalledTimes(1);
  });

  it("spawns after resume start failures and reports failure when spawn start fails", async () => {
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    await seedRuntime(runtimeStore);
    const startDetached = vi
      .fn()
      .mockResolvedValueOnce({
        started: false,
        errorMessage: "resume start failed"
      })
      .mockResolvedValueOnce({
        started: false,
        errorMessage: "resume start failed 2"
      })
      .mockResolvedValueOnce({
        started: false,
        errorMessage: "spawn start failed"
      });
    const executor = new CodexFallbackExecutor(runtimeStore, {
      run: vi.fn(),
      startDetached
    });

    const result = await executor.execute({
      job: baseJob(),
      attemptNo: 2,
      initialOutcome,
      now: new Date("2026-02-18T10:01:00.000Z")
    });

    expect(result).toEqual({
      attemptResult: "fallback_resume_failed",
      nextStatus: "failed",
      errorCode: "FALLBACK_SPAWN_FAILED",
      details: {
        resumeSkippedReason: "OK",
        launch_mode: "detached",
        errorMessage: "spawn start failed",
        initialErrorCode: "ACK_TIMEOUT"
      }
    });
    expect(startDetached).toHaveBeenCalledTimes(3);
  });
});
