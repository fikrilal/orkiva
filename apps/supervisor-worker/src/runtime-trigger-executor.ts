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
const FORCE_OVERRIDE_REASON_PREFIXES = {
  human_override: "human_override:",
  coordinator_override: "coordinator_override:"
} as const;
type OverrideIntent = keyof typeof FORCE_OVERRIDE_REASON_PREFIXES;
type OverrideReasonPrefix = (typeof FORCE_OVERRIDE_REASON_PREFIXES)[OverrideIntent];
type CollisionGateMode = "enforced" | "bypassed" | "not_evaluated";

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

const parseForceOverrideIntent = (reason: string): {
  requested: boolean;
  intent: OverrideIntent | null;
  reasonPrefix: OverrideReasonPrefix | null;
} => {
  if (reason.startsWith(FORCE_OVERRIDE_REASON_PREFIXES.human_override)) {
    return {
      requested: true,
      intent: "human_override",
      reasonPrefix: FORCE_OVERRIDE_REASON_PREFIXES.human_override
    };
  }

  if (reason.startsWith(FORCE_OVERRIDE_REASON_PREFIXES.coordinator_override)) {
    return {
      requested: true,
      intent: "coordinator_override",
      reasonPrefix: FORCE_OVERRIDE_REASON_PREFIXES.coordinator_override
    };
  }

  return {
    requested: false,
    intent: null,
    reasonPrefix: null
  };
};

const withForceOverrideAudit = (
  base: TriggerExecutionOutcome,
  override: {
    requested: boolean;
    intent: OverrideIntent | null;
    reasonPrefix: OverrideReasonPrefix | null;
  },
  input: {
    applied: boolean;
    collisionGate: CollisionGateMode;
  }
): TriggerExecutionOutcome => {
  if (!override.requested) {
    return base;
  }

  return withDetails(base, {
    ...(base.details === undefined ? {} : base.details),
    force_override_audit: {
      force_override_requested: true,
      force_override_applied: input.applied,
      override_intent: override.intent,
      override_reason_prefix: override.reasonPrefix,
      collision_gate: input.collisionGate
    }
  });
};

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
    const overrideIntent = parseForceOverrideIntent(input.job.reason);
    const withOverrideAudit = (
      outcome: TriggerExecutionOutcome,
      params: {
        applied: boolean;
        collisionGate: CollisionGateMode;
      }
    ): TriggerExecutionOutcome => withForceOverrideAudit(outcome, overrideIntent, params);

    const runtime = await this.runtimeRegistryStore.getRuntime(
      input.job.targetAgentId,
      input.job.workspaceId
    );
    if (runtime === null) {
      return withOverrideAudit(
        withDetails(
          {
            attemptResult: "failed",
            retryable: false,
            errorCode: "RUNTIME_NOT_FOUND"
          },
          buildRuntimeSnapshot(input.job)
        ),
        {
          applied: false,
          collisionGate: "not_evaluated"
        }
      );
    }

    if (input.job.targetSessionId !== null && runtime.sessionId !== input.job.targetSessionId) {
      return withOverrideAudit(
        withDetails(
          {
            attemptResult: "failed",
            retryable: false,
            errorCode: "RUNTIME_SESSION_MISMATCH"
          },
          {
            ...buildRuntimeSnapshot(input.job),
            runtimeSessionId: runtime.sessionId
          }
        ),
        {
          applied: false,
          collisionGate: "not_evaluated"
        }
      );
    }

    if (runtime.managementMode !== "managed") {
      return withOverrideAudit(
        withDetails(
          {
            attemptResult: "failed",
            retryable: false,
            errorCode: "RUNTIME_UNMANAGED"
          },
          {
            ...buildRuntimeSnapshot(input.job),
            managementMode: runtime.managementMode
          }
        ),
        {
          applied: false,
          collisionGate: "not_evaluated"
        }
      );
    }

    if (runtime.status === "offline") {
      return withOverrideAudit(
        withDetails(
          {
            attemptResult: "timeout",
            retryable: true,
            errorCode: "RUNTIME_OFFLINE"
          },
          {
            ...buildRuntimeSnapshot(input.job),
            status: runtime.status
          }
        ),
        {
          applied: false,
          collisionGate: "not_evaluated"
        }
      );
    }

    const runtimeKey = `${runtime.workspaceId}:${runtime.agentId}:${runtime.runtime}`;
    const forceOverride = overrideIntent.requested;
    const collisionGate: CollisionGateMode = forceOverride ? "bypassed" : "enforced";
    const lastBusyAt = this.lastBusyAtByRuntime.get(runtimeKey);
    if (
      !forceOverride &&
      lastBusyAt !== undefined &&
      input.now.getTime() - lastBusyAt.getTime() < this.safeguards.quietWindowMs
    ) {
      const deferredMs = input.now.getTime() - input.job.createdAt.getTime();
      if (deferredMs >= this.safeguards.maxDeferMs) {
        return withOverrideAudit(
          {
            attemptResult: "timeout",
            retryable: false,
            errorCode: "DEFER_TIMEOUT",
            details: {
              runtime: runtime.runtime,
              deferredMs,
              maxDeferMs: this.safeguards.maxDeferMs
            }
          },
          {
            applied: false,
            collisionGate: "enforced"
          }
        );
      }

      return withOverrideAudit(
        {
          attemptResult: "deferred",
          retryable: true,
          errorCode: "OPERATOR_BUSY",
          retryAfterMs: this.safeguards.recheckMs,
          details: {
            runtime: runtime.runtime,
            quietWindowMs: this.safeguards.quietWindowMs
          }
        },
        {
          applied: false,
          collisionGate: "enforced"
        }
      );
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
      return withOverrideAudit(
        {
          attemptResult: "delivered",
          retryable: false,
          ...(delivery.details === undefined ? {} : { details: delivery.details })
        },
        {
          applied: forceOverride,
          collisionGate
        }
      );
    }

    if (delivery.errorCode === "OPERATOR_BUSY") {
      const deferredMs = input.now.getTime() - input.job.createdAt.getTime();
      this.lastBusyAtByRuntime.set(runtimeKey, input.now);
      if (deferredMs >= this.safeguards.maxDeferMs) {
        return withOverrideAudit(
          {
            attemptResult: "timeout",
            retryable: false,
            errorCode: "DEFER_TIMEOUT",
            details: {
              runtime: runtime.runtime,
              deferredMs,
              maxDeferMs: this.safeguards.maxDeferMs,
              ...(delivery.details === undefined ? {} : { delivery: delivery.details })
            }
          },
          {
            applied: forceOverride,
            collisionGate
          }
        );
      }

      return withOverrideAudit(
        {
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
        },
        {
          applied: forceOverride,
          collisionGate
        }
      );
    }

    if (RETRYABLE_DELIVERY_FAILURE_CODES.has(delivery.errorCode)) {
      return withOverrideAudit(
        {
          attemptResult: "timeout",
          retryable: true,
          errorCode: delivery.errorCode,
          ...(delivery.details === undefined ? {} : { details: delivery.details })
        },
        {
          applied: forceOverride,
          collisionGate
        }
      );
    }

    return withOverrideAudit(
      {
        attemptResult: "failed",
        retryable: false,
        errorCode: delivery.errorCode,
        ...(delivery.details === undefined ? {} : { details: delivery.details })
      },
      {
        applied: forceOverride,
        collisionGate
      }
    );
  }
}
