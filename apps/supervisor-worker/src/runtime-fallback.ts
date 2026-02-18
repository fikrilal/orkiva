import { isSessionStale } from "@orkiva/domain";

import type { RuntimeRegistryStore } from "./runtime-registry.js";
import type {
  TriggerExecutionOutcome,
  TriggerFallbackExecutor,
  TriggerFallbackOutcome,
  TriggerJobRecord
} from "./trigger-queue.js";
import type { CommandExecutor } from "./tmux-adapter.js";

export interface CodexFallbackConfig {
  resumeMaxAttempts: number;
  staleAfterHours: number;
  crashLoopThreshold: number;
  crashLoopWindowMs: number;
}

const DEFAULT_CODEX_FALLBACK_CONFIG: CodexFallbackConfig = {
  resumeMaxAttempts: 2,
  staleAfterHours: 12,
  crashLoopThreshold: 3,
  crashLoopWindowMs: 15 * 60 * 1000
};

export class CodexFallbackExecutor implements TriggerFallbackExecutor {
  private readonly recentResumeFailuresByAgent = new Map<string, Date[]>();

  public constructor(
    private readonly runtimeRegistryStore: Pick<RuntimeRegistryStore, "getRuntime">,
    private readonly commandExecutor: CommandExecutor,
    private readonly config: CodexFallbackConfig = DEFAULT_CODEX_FALLBACK_CONFIG
  ) {}

  private canAttemptResume(input: { job: TriggerJobRecord; now: Date }): Promise<{
    canResume: boolean;
    reason: string;
  }> {
    return this.runtimeRegistryStore
      .getRuntime(input.job.targetAgentId, input.job.workspaceId)
      .then((runtime) => {
        if (input.job.targetSessionId === null) {
          return {
            canResume: false,
            reason: "NO_TARGET_SESSION"
          };
        }
        if (runtime === null) {
          return {
            canResume: false,
            reason: "RUNTIME_NOT_FOUND"
          };
        }
        if (runtime.sessionId !== input.job.targetSessionId) {
          return {
            canResume: false,
            reason: "RUNTIME_SESSION_MISMATCH"
          };
        }
        if (isSessionStale(runtime, this.config.staleAfterHours, input.now)) {
          return {
            canResume: false,
            reason: "SESSION_STALE"
          };
        }

        const failureKey = `${input.job.workspaceId}:${input.job.targetAgentId}`;
        const failures = this.recentResumeFailuresByAgent.get(failureKey) ?? [];
        const windowStart = input.now.getTime() - this.config.crashLoopWindowMs;
        const recentFailures = failures.filter((at) => at.getTime() >= windowStart);
        this.recentResumeFailuresByAgent.set(failureKey, recentFailures);
        if (recentFailures.length >= this.config.crashLoopThreshold) {
          return {
            canResume: false,
            reason: "CRASH_LOOP_SHORTCUT"
          };
        }

        return {
          canResume: true,
          reason: "OK"
        };
      });
  }

  private recordResumeFailure(job: TriggerJobRecord, now: Date): void {
    const key = `${job.workspaceId}:${job.targetAgentId}`;
    const failures = this.recentResumeFailuresByAgent.get(key) ?? [];
    this.recentResumeFailuresByAgent.set(key, [...failures, now]);
  }

  private async runSpawn(job: TriggerJobRecord): Promise<TriggerFallbackOutcome> {
    const spawnPrompt = `[THREAD_SUMMARY thread=${job.threadId}] ${job.prompt}`;
    const spawnResult = await this.commandExecutor.run({
      command: "codex",
      args: ["exec", spawnPrompt]
    });
    if (spawnResult.exitCode === 0) {
      return {
        attemptResult: "fallback_spawned",
        nextStatus: "fallback_spawn",
        details: {
          command: "codex exec <thread_summary_prompt>"
        }
      };
    }

    return {
      attemptResult: "fallback_resume_failed",
      nextStatus: "failed",
      errorCode: "FALLBACK_SPAWN_FAILED",
      details: {
        exitCode: spawnResult.exitCode,
        stderr: spawnResult.stderr.trim()
      }
    };
  }

  public async execute(input: {
    job: TriggerJobRecord;
    attemptNo: number;
    initialOutcome: TriggerExecutionOutcome;
    now: Date;
  }): Promise<TriggerFallbackOutcome> {
    const resumeDecision = await this.canAttemptResume({
      job: input.job,
      now: input.now
    });
    if (resumeDecision.canResume) {
      const targetSessionId = input.job.targetSessionId;
      if (targetSessionId === null) {
        return this.runSpawn(input.job);
      }
      for (
        let resumeAttempt = 1;
        resumeAttempt <= this.config.resumeMaxAttempts;
        resumeAttempt += 1
      ) {
        const resumeResult = await this.commandExecutor.run({
          command: "codex",
          args: ["exec", "resume", targetSessionId, input.job.prompt]
        });
        if (resumeResult.exitCode === 0) {
          return {
            attemptResult: "fallback_resume_succeeded",
            nextStatus: "fallback_resume",
            details: {
              resumeAttempt,
              resumeMaxAttempts: this.config.resumeMaxAttempts
            }
          };
        }
        this.recordResumeFailure(input.job, input.now);
      }
    }

    const spawnOutcome = await this.runSpawn(input.job);
    if (spawnOutcome.attemptResult === "fallback_spawned") {
      return {
        ...spawnOutcome,
        details: {
          resumeSkippedReason: resumeDecision.reason,
          ...(spawnOutcome.details === undefined ? {} : spawnOutcome.details)
        }
      };
    }

    return {
      ...spawnOutcome,
      details: {
        resumeSkippedReason: resumeDecision.reason,
        ...(spawnOutcome.details === undefined ? {} : spawnOutcome.details),
        ...(input.initialOutcome.errorCode === undefined
          ? {}
          : { initialErrorCode: input.initialOutcome.errorCode })
      }
    };
  }
}
