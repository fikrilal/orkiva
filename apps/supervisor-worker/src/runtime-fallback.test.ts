import { describe, expect, it, vi } from "vitest";

import { InMemoryRuntimeRegistryStore } from "./runtime-registry.js";
import { CodexFallbackExecutor } from "./runtime-fallback.js";
import type { TriggerExecutionOutcome, TriggerJobRecord } from "./trigger-queue.js";
import type { CommandExecutor } from "./tmux-adapter.js";

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
  it("resumes session when runtime is healthy", async () => {
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    await seedRuntime(runtimeStore);
    const run = vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: ""
      })
    );
    const executor = new CodexFallbackExecutor(runtimeStore, { run });

    const result = await executor.execute({
      job: baseJob(),
      attemptNo: 2,
      initialOutcome,
      now: new Date("2026-02-18T10:01:00.000Z")
    });

    expect(result).toEqual({
      attemptResult: "fallback_resume_succeeded",
      nextStatus: "fallback_resume",
      details: {
        resumeAttempt: 1,
        resumeMaxAttempts: 2
      }
    });
    expect(run).toHaveBeenCalledWith({
      command: "codex",
      args: ["exec", "resume", "sess_01", "Read unread and continue."]
    });
  });

  it("skips resume for stale session and spawns directly", async () => {
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    await seedRuntime(runtimeStore, new Date("2026-02-17T08:00:00.000Z"));
    const run: CommandExecutor["run"] = vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: ""
      })
    );
    const executor = new CodexFallbackExecutor(
      runtimeStore,
      { run },
      {
        resumeMaxAttempts: 2,
        staleAfterHours: 12,
        crashLoopThreshold: 3,
        crashLoopWindowMs: 15 * 60 * 1000
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
  });

  it("spawns after resume failures and reports failure when spawn fails", async () => {
    const runtimeStore = new InMemoryRuntimeRegistryStore();
    await seedRuntime(runtimeStore);
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "resume failed"
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "resume failed 2"
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "spawn failed"
      });
    const executor = new CodexFallbackExecutor(runtimeStore, { run });

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
        exitCode: 1,
        stderr: "spawn failed",
        initialErrorCode: "ACK_TIMEOUT"
      }
    });
  });
});
