import { afterEach, describe, expect, it } from "vitest";

import { AuthError, type VerifiedAuthClaims } from "@orkiva/auth";
import {
  ackReadOutputSchema,
  createThreadOutputSchema,
  heartbeatSessionOutputSchema,
  postMessageOutputSchema,
  readMessagesOutputSchema,
  triggerParticipantOutputSchema
} from "@orkiva/protocol";
import type { FastifyInstance } from "fastify";

import { createBridgeApiApp } from "./app.js";
import { InMemorySessionStore } from "./session-store.js";
import { InMemoryThreadStore } from "./thread-store.js";
import { InMemoryTriggerStore } from "./trigger-store.js";

const nowIso = "2026-02-18T10:00:00.000Z";

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
  executioner_wk1: makeClaims("participant", "wk_01", "executioner_agent"),
  reviewer_wk1: makeClaims("participant", "wk_01", "reviewer_agent")
};

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
    now: () => new Date(nowIso),
    idGenerator: () => {
      idCounter += 1;
      return `workflow-${idCounter}`;
    }
  });
};

const mcpCall = async (input: {
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

const runReviewerAutoCycle = async (input: { app: FastifyInstance; threadId: string }) => {
  const read = await mcpCall({
    app: input.app,
    method: "read_messages",
    token: "reviewer_wk1",
    payload: {
      thread_id: input.threadId,
      agent_id: "reviewer_agent",
      since_seq: 0,
      limit: 50
    }
  });
  expect(read.statusCode).toBe(200);
  const readPayload = readMessagesOutputSchema.parse(read.json());
  expect(readPayload.messages.length).toBeGreaterThan(0);

  const lastSeq = readPayload.messages.at(-1)?.seq;
  if (lastSeq === undefined) {
    throw new Error("Expected at least one unread message for reviewer");
  }

  const ack = await mcpCall({
    app: input.app,
    method: "ack_read",
    token: "reviewer_wk1",
    payload: {
      thread_id: input.threadId,
      agent_id: "reviewer_agent",
      last_read_seq: lastSeq
    }
  });
  expect(ack.statusCode).toBe(200);
  ackReadOutputSchema.parse(ack.json());

  const post = await mcpCall({
    app: input.app,
    method: "post_message",
    token: "reviewer_wk1",
    payload: {
      thread_id: input.threadId,
      schema_version: 1,
      sender_agent_id: "reviewer_agent",
      sender_session_id: "sess_reviewer_agent",
      kind: "chat",
      body: "Reviewer completed validation and approved the patch."
    }
  });
  expect(post.statusCode).toBe(200);
  postMessageOutputSchema.parse(post.json());
};

describe("bridge-api phase V integration workflow", () => {
  const appsToClose: FastifyInstance[] = [];

  afterEach(async () => {
    while (appsToClose.length > 0) {
      const app = appsToClose.pop();
      if (app) {
        await app.close();
      }
    }
  });

  it("completes executioner-reviewer flow without manual relay", async () => {
    const app = createTestApp();
    appsToClose.push(app);

    const createThread = await mcpCall({
      app,
      method: "create_thread",
      token: "coordinator_wk1",
      payload: {
        workspace_id: "wk_01",
        title: "Phase V workflow validation",
        type: "workflow",
        participants: ["executioner_agent", "reviewer_agent"]
      }
    });
    expect(createThread.statusCode).toBe(200);
    const created = createThreadOutputSchema.parse(createThread.json());

    const heartbeat = await mcpCall({
      app,
      method: "heartbeat_session",
      token: "reviewer_wk1",
      payload: {
        session_id: "sess_reviewer_agent",
        runtime: "tmux://wk_01:reviewer",
        management_mode: "managed",
        resumable: true,
        status: "active"
      }
    });
    expect(heartbeat.statusCode).toBe(200);
    heartbeatSessionOutputSchema.parse(heartbeat.json());

    const executionerMessage = await mcpCall({
      app,
      method: "post_message",
      token: "executioner_wk1",
      payload: {
        thread_id: created.thread_id,
        schema_version: 1,
        sender_agent_id: "executioner_agent",
        sender_session_id: "sess_executioner_agent",
        kind: "chat",
        body: "Please review the latest patch and report findings."
      }
    });
    expect(executionerMessage.statusCode).toBe(200);
    postMessageOutputSchema.parse(executionerMessage.json());

    const trigger = await mcpCall({
      app,
      method: "trigger_participant",
      token: "coordinator_wk1",
      requestId: "req_phase_v_workflow_trigger",
      payload: {
        thread_id: created.thread_id,
        target_agent_id: "reviewer_agent",
        reason: "new_unread_dormant_participant",
        trigger_prompt:
          "Read unread messages, run review checks, and post your validation result to the thread."
      }
    });
    expect(trigger.statusCode).toBe(200);
    const triggerPayload = triggerParticipantOutputSchema.parse(trigger.json());
    expect(triggerPayload.action).toBe("trigger_runtime");
    expect(triggerPayload.result).toBe("queued");
    expect(triggerPayload.job_status).toBe("queued");

    await runReviewerAutoCycle({
      app,
      threadId: created.thread_id
    });

    const readBack = await mcpCall({
      app,
      method: "read_messages",
      token: "executioner_wk1",
      payload: {
        thread_id: created.thread_id,
        agent_id: "executioner_agent",
        since_seq: 0,
        limit: 50
      }
    });
    expect(readBack.statusCode).toBe(200);
    const history = readMessagesOutputSchema.parse(readBack.json());
    expect(history.messages).toHaveLength(2);
    expect(history.messages[0]?.sender_agent_id).toBe("executioner_agent");
    expect(history.messages[1]?.sender_agent_id).toBe("reviewer_agent");
  });
});
