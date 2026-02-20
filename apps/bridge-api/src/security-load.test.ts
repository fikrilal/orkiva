import { describe, expect, it } from "vitest";

import { AuthError, type VerifiedAuthClaims } from "@orkiva/auth";
import {
  createThreadOutputSchema,
  protocolErrorResponseSchema,
  readMessagesOutputSchema
} from "@orkiva/protocol";
import type { FastifyInstance } from "fastify";

import { createBridgeApiApp } from "./app.js";
import { InMemorySessionStore } from "./session-store.js";
import { InMemoryThreadStore } from "./thread-store.js";
import { InMemoryTriggerStore } from "./trigger-store.js";

const nowIso = "2026-02-18T13:30:00.000Z";

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
  coordinator_wk1: makeClaims("coordinator", "wk_01", "coordinator_agent"),
  coordinator_wk2: makeClaims("coordinator", "wk_02", "coordinator_other"),
  participant_wk1: makeClaims("participant", "wk_01", "executioner_agent")
};

const createTestApp = (): FastifyInstance => {
  let idCounter = 0;
  return createBridgeApiApp({
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
    now: () => new Date(nowIso),
    idGenerator: () => {
      idCounter += 1;
      return `x-${idCounter}`;
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

describe("bridge-api phase X security and load", () => {
  it("keeps cross-workspace abuse requests isolated under concurrency", async () => {
    const app = createTestApp();
    const created = await callMcp({
      app,
      method: "create_thread",
      token: "coordinator_wk1",
      payload: {
        workspace_id: "wk_01",
        title: "Cross-workspace rejection stress",
        type: "workflow",
        participants: ["executioner_agent"]
      }
    });
    expect(created.statusCode).toBe(200);
    const thread = createThreadOutputSchema.parse(created.json());

    const abuseRequests = await Promise.all(
      [...Array(20).keys()].map((index) =>
        callMcp({
          app,
          method: "get_thread",
          token: "coordinator_wk2",
          requestId: `req_x_cross_workspace_${index}`,
          payload: {
            thread_id: thread.thread_id
          }
        })
      )
    );
    expect(abuseRequests).toHaveLength(20);
    for (const response of abuseRequests) {
      expect(response.statusCode).toBe(403);
      const payload = protocolErrorResponseSchema.parse(response.json());
      expect(payload.error.code).toBe("WORKSPACE_MISMATCH");
    }

    await app.close();
  });

  it("rejects malformed payload bursts with deterministic validation errors", async () => {
    const app = createTestApp();
    const created = await callMcp({
      app,
      method: "create_thread",
      token: "coordinator_wk1",
      payload: {
        workspace_id: "wk_01",
        title: "Malformed payload stress",
        type: "workflow",
        participants: ["executioner_agent"]
      }
    });
    expect(created.statusCode).toBe(200);
    const thread = createThreadOutputSchema.parse(created.json());

    const malformedRequests = await Promise.all(
      [...Array(25).keys()].map((index) =>
        callMcp({
          app,
          method: "post_message",
          token: "participant_wk1",
          requestId: `req_x_malformed_${index}`,
          payload: {
            thread_id: thread.thread_id,
            schema_version: "not-a-number",
            sender_agent_id: "executioner_agent",
            sender_session_id: "sess_executioner_agent",
            kind: "chat",
            body: "invalid schema version"
          }
        })
      )
    );
    expect(malformedRequests).toHaveLength(25);
    for (const response of malformedRequests) {
      expect(response.statusCode).toBe(400);
      const payload = protocolErrorResponseSchema.parse(response.json());
      expect(payload.error.code).toBe("INVALID_ARGUMENT");
    }

    await app.close();
  });

  it("handles concurrent write bursts without internal errors", async () => {
    const app = createTestApp();
    const created = await callMcp({
      app,
      method: "create_thread",
      token: "coordinator_wk1",
      payload: {
        workspace_id: "wk_01",
        title: "Concurrent write burst",
        type: "workflow",
        participants: ["executioner_agent"]
      }
    });
    expect(created.statusCode).toBe(200);
    const thread = createThreadOutputSchema.parse(created.json());

    const burstResponses = await Promise.all(
      [...Array(30).keys()].map((index) =>
        callMcp({
          app,
          method: "post_message",
          token: "participant_wk1",
          requestId: `req_x_burst_${index}`,
          payload: {
            thread_id: thread.thread_id,
            schema_version: 1,
            sender_agent_id: "executioner_agent",
            sender_session_id: "sess_executioner_agent",
            kind: "chat",
            body: `burst-${index}`
          }
        })
      )
    );

    const success = burstResponses.filter((response) => response.statusCode === 200);
    const conflict = burstResponses.filter((response) => response.statusCode === 409);
    const unexpected = burstResponses.filter(
      (response) => response.statusCode !== 200 && response.statusCode !== 409
    );

    expect(unexpected).toHaveLength(0);
    expect(success.length + conflict.length).toBe(30);

    for (const response of conflict) {
      const payload = protocolErrorResponseSchema.parse(response.json());
      expect(payload.error.code).toBe("CONFLICT");
    }

    const readBack = await callMcp({
      app,
      method: "read_messages",
      token: "participant_wk1",
      payload: {
        thread_id: thread.thread_id,
        agent_id: "executioner_agent",
        since_seq: 0,
        limit: 100
      }
    });
    expect(readBack.statusCode).toBe(200);
    const history = readMessagesOutputSchema.parse(readBack.json());
    expect(history.messages.length).toBe(success.length);
    for (let index = 0; index < history.messages.length; index += 1) {
      expect(history.messages[index]?.seq).toBe(index + 1);
    }

    await app.close();
  });
});
