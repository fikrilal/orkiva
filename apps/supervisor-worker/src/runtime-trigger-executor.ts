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
  "SEND_KEYS_ERROR"
]);

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
  public constructor(
    private readonly runtimeRegistryStore: Pick<RuntimeRegistryStore, "getRuntime">,
    private readonly ptyAdapter: TriggerPtyAdapter
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

    const delivery = await this.ptyAdapter.deliver({
      runtime,
      triggerId: input.job.triggerId,
      threadId: input.job.threadId,
      reason: input.job.reason,
      prompt: input.job.prompt
    });
    if (delivery.delivered) {
      return {
        attemptResult: "delivered",
        retryable: false,
        ...(delivery.details === undefined ? {} : { details: delivery.details })
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
