import { performance } from "node:perf_hooks";

import { AuthError, type VerifiedAuthClaims } from "@orkiva/auth";
import {
  createThreadOutputSchema,
  heartbeatSessionOutputSchema,
  postMessageOutputSchema,
  protocolErrorResponseSchema,
  readMessagesOutputSchema,
  triggerParticipantOutputSchema
} from "@orkiva/protocol";
import type { FastifyInstance } from "fastify";

import { createBridgeApiApp } from "./app.js";
import { InMemorySessionStore } from "./session-store.js";
import { InMemoryThreadStore } from "./thread-store.js";
import { InMemoryTriggerStore } from "./trigger-store.js";

export interface SliThresholds {
  postSuccessRate: number;
  readSuccessRate: number;
  postToVisibleP95Ms: number;
  messageToWakeTriggerP95Ms: number;
}

export interface OperationMetrics {
  attempts: number;
  successes: number;
  failures: number;
  successRate: number;
  p95LatencyMs: number;
}

export interface SliBenchmarkReport {
  measuredAt: string;
  iterations: number;
  thresholds: SliThresholds;
  post: OperationMetrics;
  read: OperationMetrics;
  trigger: OperationMetrics;
  postToVisibleP95Ms: number;
  messageToWakeTriggerP95Ms: number;
}

export interface SliBenchmarkOptions {
  iterations?: number;
}

export const MVP_SLI_THRESHOLDS: Readonly<SliThresholds> = {
  postSuccessRate: 0.99,
  readSuccessRate: 0.995,
  postToVisibleP95Ms: 2_000,
  messageToWakeTriggerP95Ms: 3_000
};

const DEFAULT_ITERATIONS = 40;

const makeClaims = (
  role: VerifiedAuthClaims["role"],
  workspaceId: string,
  agentId: string
): VerifiedAuthClaims => ({
  agentId,
  workspaceId,
  role,
  sessionId: `sess_${agentId}`,
  issuedAt: 1,
  expiresAt: 2,
  jwtId: `jti_${agentId}`,
  raw: {}
});

const tokenMap: Readonly<Record<string, VerifiedAuthClaims>> = {
  coordinator: makeClaims("coordinator", "wk_01", "coordinator_agent"),
  executioner: makeClaims("participant", "wk_01", "executioner_agent"),
  reviewer: makeClaims("participant", "wk_01", "reviewer_agent")
};

const percentile = (samples: readonly number[], ratio: number): number => {
  if (samples.length === 0) {
    return 0;
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil(ratio * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index] ?? 0;
};

const round = (value: number): number => Math.round(value * 1_000) / 1_000;

const createOperationMetrics = (
  attempts: number,
  successes: number,
  latencySamplesMs: readonly number[]
): OperationMetrics => ({
  attempts,
  successes,
  failures: attempts - successes,
  successRate: attempts === 0 ? 0 : round(successes / attempts),
  p95LatencyMs: round(percentile(latencySamplesMs, 0.95))
});

const createTestApp = (): FastifyInstance => {
  let idCounter = 0;
  return createBridgeApiApp({
    workspaceId: "wk_01",
    threadStore: new InMemoryThreadStore(),
    sessionStore: new InMemorySessionStore(),
    triggerStore: new InMemoryTriggerStore(),
    verifyAccessToken: (token) => {
      const claims = tokenMap[token];
      if (!claims) {
        throw new AuthError("UNAUTHORIZED", "Token not recognized");
      }

      return Promise.resolve(claims);
    },
    now: () => new Date(),
    idGenerator: () => {
      idCounter += 1;
      return `sli-${idCounter}`;
    }
  });
};

const callMcp = (input: {
  app: FastifyInstance;
  method: string;
  token: keyof typeof tokenMap;
  payload: Record<string, unknown>;
  requestId?: string;
}) =>
  input.app.inject({
    method: "POST",
    url: `/v1/mcp/${input.method}`,
    headers: {
      authorization: `Bearer ${input.token}`,
      ...(input.requestId === undefined ? {} : { "x-request-id": input.requestId })
    },
    payload: input.payload
  });

const assertProtocolError = (response: { statusCode: number; json: () => unknown }): void => {
  if (response.statusCode >= 400) {
    protocolErrorResponseSchema.parse(response.json());
  }
};

export const runInMemorySliBenchmark = async (
  options: SliBenchmarkOptions = {}
): Promise<SliBenchmarkReport> => {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const app = createTestApp();
  const postLatenciesMs: number[] = [];
  const readLatenciesMs: number[] = [];
  const triggerLatenciesMs: number[] = [];
  const postToVisibleLatenciesMs: number[] = [];
  const messageToWakeTriggerLatenciesMs: number[] = [];
  let postAttempts = 0;
  let postSuccesses = 0;
  let readAttempts = 0;
  let readSuccesses = 0;
  let triggerAttempts = 0;
  let triggerSuccesses = 0;

  try {
    const createThreadResponse = await callMcp({
      app,
      method: "create_thread",
      token: "coordinator",
      payload: {
        workspace_id: "wk_01",
        title: "Phase Y SLI pilot benchmark",
        type: "workflow",
        participants: ["executioner_agent", "reviewer_agent"]
      }
    });
    if (createThreadResponse.statusCode !== 200) {
      assertProtocolError(createThreadResponse);
      throw new Error("Unable to create benchmark thread");
    }

    const createdThread = createThreadOutputSchema.parse(createThreadResponse.json());
    const heartbeatResponse = await callMcp({
      app,
      method: "heartbeat_session",
      token: "reviewer",
      payload: {
        workspace_id: "wk_01",
        agent_id: "reviewer_agent",
        session_id: "sess_reviewer_agent",
        runtime: "tmux:orkiva:reviewer",
        management_mode: "managed",
        resumable: true,
        status: "idle"
      }
    });
    if (heartbeatResponse.statusCode !== 200) {
      assertProtocolError(heartbeatResponse);
      throw new Error("Unable to prepare reviewer runtime session");
    }
    heartbeatSessionOutputSchema.parse(heartbeatResponse.json());

    for (let index = 0; index < iterations; index += 1) {
      postAttempts += 1;
      const postStart = performance.now();
      const postResponse = await callMcp({
        app,
        method: "post_message",
        token: "executioner",
        requestId: `req_y_post_${index}`,
        payload: {
          thread_id: createdThread.thread_id,
          schema_version: 1,
          sender_agent_id: "executioner_agent",
          sender_session_id: "sess_executioner_agent",
          kind: "chat",
          body: `benchmark-message-${index}`
        }
      });
      const postEnd = performance.now();
      if (postResponse.statusCode !== 200) {
        assertProtocolError(postResponse);
        continue;
      }
      postSuccesses += 1;
      postLatenciesMs.push(postEnd - postStart);
      const postedMessage = postMessageOutputSchema.parse(postResponse.json());

      readAttempts += 1;
      const readStart = performance.now();
      const readResponse = await callMcp({
        app,
        method: "read_messages",
        token: "executioner",
        requestId: `req_y_read_${index}`,
        payload: {
          thread_id: createdThread.thread_id,
          agent_id: "executioner_agent",
          since_seq: postedMessage.seq - 1,
          limit: 1
        }
      });
      const readEnd = performance.now();
      if (readResponse.statusCode !== 200) {
        assertProtocolError(readResponse);
      } else {
        const history = readMessagesOutputSchema.parse(readResponse.json());
        if (history.messages.some((message) => message.seq === postedMessage.seq)) {
          readSuccesses += 1;
          readLatenciesMs.push(readEnd - readStart);
          postToVisibleLatenciesMs.push(readEnd - postStart);
        }
      }

      triggerAttempts += 1;
      const triggerStart = performance.now();
      const triggerResponse = await callMcp({
        app,
        method: "trigger_participant",
        token: "coordinator",
        requestId: `req_y_trigger_${index}`,
        payload: {
          thread_id: createdThread.thread_id,
          target_agent_id: "reviewer_agent",
          reason: "benchmark-wake",
          trigger_prompt: "please review latest benchmark update"
        }
      });
      const triggerEnd = performance.now();
      if (triggerResponse.statusCode !== 200) {
        assertProtocolError(triggerResponse);
        continue;
      }
      triggerParticipantOutputSchema.parse(triggerResponse.json());
      triggerSuccesses += 1;
      triggerLatenciesMs.push(triggerEnd - triggerStart);
      messageToWakeTriggerLatenciesMs.push(triggerEnd - postEnd);
    }
  } finally {
    await app.close();
  }

  return {
    measuredAt: new Date().toISOString(),
    iterations,
    thresholds: { ...MVP_SLI_THRESHOLDS },
    post: createOperationMetrics(postAttempts, postSuccesses, postLatenciesMs),
    read: createOperationMetrics(readAttempts, readSuccesses, readLatenciesMs),
    trigger: createOperationMetrics(triggerAttempts, triggerSuccesses, triggerLatenciesMs),
    postToVisibleP95Ms: round(percentile(postToVisibleLatenciesMs, 0.95)),
    messageToWakeTriggerP95Ms: round(percentile(messageToWakeTriggerLatenciesMs, 0.95))
  };
};
