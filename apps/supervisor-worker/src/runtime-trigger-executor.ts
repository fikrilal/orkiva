import type { RuntimeRegistryStore } from "./runtime-registry.js";
import type { TriggerPtyAdapter } from "./pty-adapter.js";
import type {
  TriggerExecutionOutcome,
  TriggerJobExecutor,
  TriggerJobRecord
} from "./trigger-queue.js";

const RETRYABLE_DELIVERY_FAILURE_CODES = new Set([
  "TARGET_NOT_FOUND",
  "PANE_DEAD",
  "SEND_KEYS_ERROR",
  "OPERATOR_BUSY"
]);
const FORCE_OVERRIDE_REASON_PREFIXES = ["human_override:", "coordinator_override:"] as const;

export interface RuntimeTriggerSafeguardConfig {
  quietWindowMs: number;
  recheckMs: number;
  maxDeferMs: number;
}

const DEFAULT_RUNTIME_TRIGGER_SAFEGUARDS: RuntimeTriggerSafeguardConfig = {
  quietWindowMs: 20_000,
  recheckMs: 5_000,
  maxDeferMs: 60_000
};

const withDetails = (
  base: TriggerExecutionOutcome,
  details?: Record<string, unknown>
): TriggerExecutionOutcome =>
  details === undefined
    ? base
    : {
        ...base,
        details
      };

const buildRuntimeSnapshot = (job: TriggerJobRecord): Record<string, unknown> => ({
  triggerId: job.triggerId,
  targetAgentId: job.targetAgentId,
  workspaceId: job.workspaceId,
  targetSessionId: job.targetSessionId
});

export class ManagedRuntimeTriggerJobExecutor implements TriggerJobExecutor {
  private readonly lastBusyAtByRuntime = new Map<string, Date>();

  public constructor(
    private readonly runtimeRegistryStore: Pick<RuntimeRegistryStore, "getRuntime">,
    private readonly ptyAdapter: TriggerPtyAdapter,
    private readonly safeguards: RuntimeTriggerSafeguardConfig = DEFAULT_RUNTIME_TRIGGER_SAFEGUARDS
  ) {}

  public async execute(input: {
    job: TriggerJobRecord;
    attemptNo: number;
    now: Date;
  }): Promise<TriggerExecutionOutcome> {
    void input.attemptNo;
    void input.now;

    const runtime = await this.runtimeRegistryStore.getRuntime(
      input.job.targetAgentId,
      input.job.workspaceId
    );
    if (runtime === null) {
      return withDetails(
        {
          attemptResult: "failed",
          retryable: false,
          errorCode: "RUNTIME_NOT_FOUND"
        },
        buildRuntimeSnapshot(input.job)
      );
    }

    if (input.job.targetSessionId !== null && runtime.sessionId !== input.job.targetSessionId) {
      return withDetails(
        {
          attemptResult: "failed",
          retryable: false,
          errorCode: "RUNTIME_SESSION_MISMATCH"
        },
        {
          ...buildRuntimeSnapshot(input.job),
          runtimeSessionId: runtime.sessionId
        }
      );
    }

    if (runtime.managementMode !== "managed") {
      return withDetails(
        {
          attemptResult: "failed",
          retryable: false,
          errorCode: "RUNTIME_UNMANAGED"
        },
        {
          ...buildRuntimeSnapshot(input.job),
          managementMode: runtime.managementMode
        }
      );
    }

    if (runtime.status === "offline") {
      return withDetails(
        {
          attemptResult: "timeout",
          retryable: true,
          errorCode: "RUNTIME_OFFLINE"
        },
        {
          ...buildRuntimeSnapshot(input.job),
          status: runtime.status
        }
      );
    }

    const runtimeKey = `${runtime.workspaceId}:${runtime.agentId}:${runtime.runtime}`;
    const forceOverride = FORCE_OVERRIDE_REASON_PREFIXES.some((prefix) =>
      input.job.reason.startsWith(prefix)
    );
    const lastBusyAt = this.lastBusyAtByRuntime.get(runtimeKey);
    if (
      !forceOverride &&
      lastBusyAt !== undefined &&
      input.now.getTime() - lastBusyAt.getTime() < this.safeguards.quietWindowMs
    ) {
      const deferredMs = input.now.getTime() - input.job.createdAt.getTime();
      if (deferredMs >= this.safeguards.maxDeferMs) {
        return {
          attemptResult: "timeout",
          retryable: false,
          errorCode: "DEFER_TIMEOUT",
          details: {
            runtime: runtime.runtime,
            deferredMs,
            maxDeferMs: this.safeguards.maxDeferMs
          }
        };
      }

      return {
        attemptResult: "deferred",
        retryable: true,
        errorCode: "OPERATOR_BUSY",
        retryAfterMs: this.safeguards.recheckMs,
        details: {
          runtime: runtime.runtime,
          quietWindowMs: this.safeguards.quietWindowMs
        }
      };
    }

    const delivery = await this.ptyAdapter.deliver({
      runtime,
      triggerId: input.job.triggerId,
      threadId: input.job.threadId,
      reason: input.job.reason,
      prompt: input.job.prompt,
      forceOverride
    });
    if (delivery.delivered) {
      this.lastBusyAtByRuntime.delete(runtimeKey);
      return {
        attemptResult: "delivered",
        retryable: false,
        ...(delivery.details === undefined ? {} : { details: delivery.details })
      };
    }

    if (delivery.errorCode === "OPERATOR_BUSY") {
      const deferredMs = input.now.getTime() - input.job.createdAt.getTime();
      this.lastBusyAtByRuntime.set(runtimeKey, input.now);
      if (deferredMs >= this.safeguards.maxDeferMs) {
        return {
          attemptResult: "timeout",
          retryable: false,
          errorCode: "DEFER_TIMEOUT",
          details: {
            runtime: runtime.runtime,
            deferredMs,
            maxDeferMs: this.safeguards.maxDeferMs,
            ...(delivery.details === undefined ? {} : { delivery: delivery.details })
          }
        };
      }

      return {
        attemptResult: "deferred",
        retryable: true,
        errorCode: delivery.errorCode,
        retryAfterMs: this.safeguards.recheckMs,
        details: {
          runtime: runtime.runtime,
          deferredMs,
          quietWindowMs: this.safeguards.quietWindowMs,
          maxDeferMs: this.safeguards.maxDeferMs,
          ...(delivery.details === undefined ? {} : { delivery: delivery.details })
        }
      };
    }

    if (RETRYABLE_DELIVERY_FAILURE_CODES.has(delivery.errorCode)) {
      return {
        attemptResult: "timeout",
        retryable: true,
        errorCode: delivery.errorCode,
        ...(delivery.details === undefined ? {} : { details: delivery.details })
      };
    }

    return {
      attemptResult: "failed",
      retryable: false,
      errorCode: delivery.errorCode,
      ...(delivery.details === undefined ? {} : { details: delivery.details })
    };
  }
}
