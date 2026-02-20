import { CURRENT_EVENT_VERSION, CURRENT_MESSAGE_SCHEMA_VERSION } from "@orkiva/protocol";

import type {
  TriggerCallbackExecutor,
  TriggerCallbackOutcome,
  TriggerJobRecord,
  TriggerAttemptRecord
} from "./trigger-queue.js";

export interface BridgeTriggerCallbackConfig {
  bridgeApiBaseUrl: string;
  accessToken?: string;
  requestTimeoutMs: number;
  eventType: string;
}

const DEFAULT_BRIDGE_TRIGGER_CALLBACK_CONFIG: BridgeTriggerCallbackConfig = {
  bridgeApiBaseUrl: "http://127.0.0.1:3000",
  requestTimeoutMs: 8_000,
  eventType: "trigger.completed"
};

const isRetryableStatusCode = (statusCode: number): boolean =>
  statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500;

const parseRetryAfterMs = (value: string | null): number | undefined => {
  if (value === null) {
    return undefined;
  }

  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return Math.round(asNumber * 1000);
  }

  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : undefined;
  }

  return undefined;
};

const toBaseUrl = (raw: string): string => raw.replace(/\/+$/, "");

const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;

const outcomeLabel = (triggerOutcome: TriggerAttemptRecord | null): string => {
  if (triggerOutcome === null) {
    return "unknown";
  }

  return triggerOutcome.attemptResult;
};

const buildCallbackBody = (input: {
  job: TriggerJobRecord;
  triggerOutcome: TriggerAttemptRecord | null;
}): string => {
  const outcome = outcomeLabel(input.triggerOutcome);
  return `Worker callback for trigger ${input.job.triggerId}: ${outcome}.`;
};

export class BridgeTriggerCallbackExecutor implements TriggerCallbackExecutor {
  private readonly config: BridgeTriggerCallbackConfig;

  public constructor(config: Partial<BridgeTriggerCallbackConfig> = {}) {
    this.config = {
      ...DEFAULT_BRIDGE_TRIGGER_CALLBACK_CONFIG,
      ...config
    };
  }

  public async execute(input: {
    job: TriggerJobRecord;
    attemptNo: number;
    triggerOutcome: TriggerAttemptRecord | null;
    now: Date;
  }): Promise<TriggerCallbackOutcome> {
    const token = this.config.accessToken?.trim();
    if (token === undefined || token.length === 0) {
      return {
        attemptResult: "callback_post_failed",
        retryable: false,
        errorCode: "CALLBACK_AUTH_TOKEN_MISSING",
        details: {
          bridgeApiBaseUrl: this.config.bridgeApiBaseUrl,
          threadId: input.job.threadId
        }
      };
    }

    const endpoint = `${toBaseUrl(this.config.bridgeApiBaseUrl)}/v1/mcp/post_message`;
    const payload = {
      thread_id: input.job.threadId,
      schema_version: CURRENT_MESSAGE_SCHEMA_VERSION,
      kind: "event" as const,
      body: buildCallbackBody({
        job: input.job,
        triggerOutcome: input.triggerOutcome
      }),
      metadata: {
        event_version: CURRENT_EVENT_VERSION,
        event_type: this.config.eventType,
        suppress_auto_trigger: true,
        trigger_id: input.job.triggerId,
        job_id: input.job.triggerId,
        target_agent_id: input.job.targetAgentId,
        trigger_reason: input.job.reason,
        trigger_outcome: outcomeLabel(input.triggerOutcome),
        trigger_attempt_no: input.triggerOutcome?.attemptNo ?? null,
        trigger_error_code: input.triggerOutcome?.errorCode ?? null,
        started_at: input.triggerOutcome?.createdAt.toISOString() ?? null,
        finished_at: input.now.toISOString(),
        callback_attempt_no: input.attemptNo
      },
      idempotency_key: `trigger-callback:${input.job.triggerId}:v1`
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const responseText = truncate(await response.text(), 512);

      if (response.ok) {
        return {
          attemptResult: "callback_post_succeeded",
          retryable: false,
          details: {
            endpoint,
            httpStatus: response.status
          }
        };
      }

      if (isRetryableStatusCode(response.status)) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        return {
          attemptResult: "callback_post_deferred",
          retryable: true,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          errorCode: "CALLBACK_HTTP_RETRYABLE",
          details: {
            endpoint,
            httpStatus: response.status,
            response: responseText
          }
        };
      }

      return {
        attemptResult: "callback_post_failed",
        retryable: false,
        errorCode: "CALLBACK_HTTP_FATAL",
        details: {
          endpoint,
          httpStatus: response.status,
          response: responseText
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const wasAborted = error instanceof Error && error.name === "AbortError";

      return {
        attemptResult: "callback_post_deferred",
        retryable: true,
        errorCode: wasAborted ? "CALLBACK_REQUEST_TIMEOUT" : "CALLBACK_NETWORK_ERROR",
        details: {
          endpoint,
          errorMessage
        }
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
