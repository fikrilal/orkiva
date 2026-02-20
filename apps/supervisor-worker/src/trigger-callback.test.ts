import { afterEach, describe, expect, it, vi } from "vitest";

import type { TriggerAttemptRecord, TriggerJobRecord } from "./trigger-queue.js";
import { BridgeTriggerCallbackExecutor } from "./trigger-callback.js";

const baseJob = (overrides: Partial<TriggerJobRecord> = {}): TriggerJobRecord => ({
  triggerId: "trg_callback_01",
  threadId: "th_callback_01",
  workspaceId: "wk_01",
  targetAgentId: "reviewer_agent",
  targetSessionId: "sess_01",
  reason: "new_unread_dormant_participant",
  prompt: "Read unread messages and continue.",
  status: "callback_pending",
  attempts: 2,
  maxRetries: 2,
  nextRetryAt: null,
  createdAt: new Date("2026-02-21T08:00:00.000Z"),
  updatedAt: new Date("2026-02-21T08:00:00.000Z"),
  ...overrides
});

const triggerOutcome: TriggerAttemptRecord = {
  attemptNo: 2,
  attemptResult: "fallback_spawned",
  createdAt: new Date("2026-02-21T08:01:00.000Z")
};

describe("BridgeTriggerCallbackExecutor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails fast when callback auth token is missing", async () => {
    const executor = new BridgeTriggerCallbackExecutor({
      bridgeApiBaseUrl: "http://127.0.0.1:3000"
    });

    const result = await executor.execute({
      job: baseJob(),
      attemptNo: 3,
      triggerOutcome,
      now: new Date("2026-02-21T08:02:00.000Z")
    });

    expect(result).toEqual({
      attemptResult: "callback_post_failed",
      retryable: false,
      errorCode: "CALLBACK_AUTH_TOKEN_MISSING",
      details: {
        bridgeApiBaseUrl: "http://127.0.0.1:3000",
        threadId: "th_callback_01"
      }
    });
  });

  it("posts trigger completion callback successfully", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message_id: "msg_01" }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const executor = new BridgeTriggerCallbackExecutor({
      bridgeApiBaseUrl: "http://127.0.0.1:3000",
      accessToken: "worker-token"
    });

    const result = await executor.execute({
      job: baseJob(),
      attemptNo: 3,
      triggerOutcome,
      now: new Date("2026-02-21T08:02:00.000Z")
    });

    expect(result.attemptResult).toBe("callback_post_succeeded");
    expect(result.retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3000/v1/mcp/post_message");

    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toEqual(
      expect.objectContaining({
        authorization: "Bearer worker-token"
      })
    );

    const rawBody = requestInit?.body;
    if (typeof rawBody !== "string") {
      throw new Error("expected callback request body to be a JSON string");
    }
    const body = JSON.parse(rawBody) as {
      metadata: Record<string, unknown>;
      idempotency_key: string;
      kind: string;
    };
    expect(body.kind).toBe("event");
    expect(body.idempotency_key).toBe("trigger-callback:trg_callback_01:v1");
    expect(body.metadata["event_type"]).toBe("trigger.completed");
    expect(body.metadata["suppress_auto_trigger"]).toBe(true);
    expect(body.metadata["trigger_outcome"]).toBe("fallback_spawned");
  });

  it("classifies retryable HTTP responses as deferred", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "temporary" }), {
          status: 503,
          headers: {
            "retry-after": "2"
          }
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const executor = new BridgeTriggerCallbackExecutor({
      bridgeApiBaseUrl: "http://127.0.0.1:3000",
      accessToken: "worker-token"
    });

    const result = await executor.execute({
      job: baseJob(),
      attemptNo: 3,
      triggerOutcome,
      now: new Date("2026-02-21T08:02:00.000Z")
    });

    expect(result).toEqual(
      expect.objectContaining({
        attemptResult: "callback_post_deferred",
        retryable: true,
        errorCode: "CALLBACK_HTTP_RETRYABLE",
        retryAfterMs: 2000
      })
    );
  });

  it("classifies non-retryable HTTP responses as fatal callback errors", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "bad request" }), {
          status: 400
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const executor = new BridgeTriggerCallbackExecutor({
      bridgeApiBaseUrl: "http://127.0.0.1:3000",
      accessToken: "worker-token"
    });

    const result = await executor.execute({
      job: baseJob(),
      attemptNo: 3,
      triggerOutcome,
      now: new Date("2026-02-21T08:02:00.000Z")
    });

    expect(result).toEqual(
      expect.objectContaining({
        attemptResult: "callback_post_failed",
        retryable: false,
        errorCode: "CALLBACK_HTTP_FATAL"
      })
    );
  });
});
