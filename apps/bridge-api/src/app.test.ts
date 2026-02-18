import { afterEach, describe, expect, it } from "vitest";

import { AuthError, type VerifiedAuthClaims } from "@orkiva/auth";
import {
  createThreadOutputSchema,
  getThreadOutputSchema,
  protocolErrorResponseSchema,
  summarizeThreadOutputSchema,
  updateThreadStatusOutputSchema
} from "@orkiva/protocol";

import { createBridgeApiApp } from "./app.js";
import { InMemoryThreadStore } from "./thread-store.js";

const nowIso = "2026-02-18T08:30:00.000Z";

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
  participant_wk1: makeClaims("participant", "wk_01", "participant_agent"),
  auditor_wk1: makeClaims("auditor", "wk_01", "auditor_agent"),
  coordinator_wk2: makeClaims("coordinator", "wk_02", "coord_other")
};

const createTestApp = () =>
  createBridgeApiApp({
    threadStore: new InMemoryThreadStore(),
    verifyAccessToken: (token) => {
      const claims = tokenMap[token];
      if (!claims) {
        throw new AuthError("UNAUTHORIZED", "Token not recognized");
      }

      return Promise.resolve(claims);
    },
    now: () => new Date(nowIso),
    idGenerator: () => "fixed-id"
  });

describe("bridge-api phase 4", () => {
  const appsToClose: ReturnType<typeof createTestApp>[] = [];

  afterEach(async () => {
    while (appsToClose.length > 0) {
      const app = appsToClose.pop();
      if (app) {
        await app.close();
      }
    }
  });

  it("rejects requests without bearer token", async () => {
    const app = createTestApp();
    appsToClose.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/mcp/create_thread",
      payload: {
        workspace_id: "wk_01",
        title: "hello",
        type: "workflow",
        participants: ["a", "b"]
      }
    });

    expect(response.statusCode).toBe(401);
    const payload = protocolErrorResponseSchema.parse(response.json());
    expect(payload.error.code).toBe("UNAUTHORIZED");
  });

  it("creates and retrieves a thread with authorized roles", async () => {
    const app = createTestApp();
    appsToClose.push(app);

    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/mcp/create_thread",
      headers: {
        authorization: "Bearer coordinator_wk1"
      },
      payload: {
        workspace_id: "wk_01",
        title: "Profile mapper review",
        type: "workflow",
        participants: ["executioner_agent", "reviewer_agent"],
        created_by: "coordinator_agent"
      }
    });

    expect(createResponse.statusCode).toBe(200);
    const createdPayload = createThreadOutputSchema.parse(createResponse.json());
    expect(createdPayload.thread_id).toBe("th_fixed-id");

    const getResponse = await app.inject({
      method: "POST",
      url: "/v1/mcp/get_thread",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id"
      }
    });

    expect(getResponse.statusCode).toBe(200);
    const threadPayload = getThreadOutputSchema.parse(getResponse.json());
    expect(threadPayload.workspace_id).toBe("wk_01");
    expect(threadPayload.participants).toHaveLength(2);
  });

  it("rejects create_thread for non-coordinator role", async () => {
    const app = createTestApp();
    appsToClose.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/mcp/create_thread",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        workspace_id: "wk_01",
        title: "blocked",
        type: "workflow",
        participants: ["a", "b"]
      }
    });

    expect(response.statusCode).toBe(403);
    const payload = protocolErrorResponseSchema.parse(response.json());
    expect(payload.error.code).toBe("FORBIDDEN");
  });

  it("rejects payload identity mismatch hints", async () => {
    const app = createTestApp();
    appsToClose.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/mcp/create_thread",
      headers: {
        authorization: "Bearer coordinator_wk1"
      },
      payload: {
        workspace_id: "wk_01",
        title: "bad identity",
        type: "workflow",
        participants: ["a", "b"],
        created_by: "someone_else"
      }
    });

    expect(response.statusCode).toBe(403);
    const payload = protocolErrorResponseSchema.parse(response.json());
    expect(payload.error.code).toBe("FORBIDDEN");
  });

  it("enforces workspace boundary checks", async () => {
    const app = createTestApp();
    appsToClose.push(app);

    await app.inject({
      method: "POST",
      url: "/v1/mcp/create_thread",
      headers: {
        authorization: "Bearer coordinator_wk1"
      },
      payload: {
        workspace_id: "wk_01",
        title: "wk1 thread",
        type: "workflow",
        participants: ["a", "b"]
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/mcp/get_thread",
      headers: {
        authorization: "Bearer coordinator_wk2"
      },
      payload: {
        thread_id: "th_fixed-id"
      }
    });

    expect(response.statusCode).toBe(403);
    const payload = protocolErrorResponseSchema.parse(response.json());
    expect(payload.error.code).toBe("WORKSPACE_MISMATCH");
  });

  it("handles invalid thread transition paths", async () => {
    const app = createTestApp();
    appsToClose.push(app);

    await app.inject({
      method: "POST",
      url: "/v1/mcp/create_thread",
      headers: {
        authorization: "Bearer coordinator_wk1"
      },
      payload: {
        workspace_id: "wk_01",
        title: "transition thread",
        type: "workflow",
        participants: ["a", "b"]
      }
    });

    const blockResponse = await app.inject({
      method: "POST",
      url: "/v1/mcp/update_thread_status",
      headers: {
        authorization: "Bearer coordinator_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        status: "blocked",
        reason: "waiting_review"
      }
    });

    expect(blockResponse.statusCode).toBe(200);
    updateThreadStatusOutputSchema.parse(blockResponse.json());

    const invalidResponse = await app.inject({
      method: "POST",
      url: "/v1/mcp/update_thread_status",
      headers: {
        authorization: "Bearer coordinator_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        status: "resolved",
        reason: "not_allowed_directly_from_blocked"
      }
    });

    expect(invalidResponse.statusCode).toBe(409);
    const payload = protocolErrorResponseSchema.parse(invalidResponse.json());
    expect(payload.error.code).toBe("INVALID_THREAD_TRANSITION");
  });

  it("summarizes thread with read access", async () => {
    const app = createTestApp();
    appsToClose.push(app);

    await app.inject({
      method: "POST",
      url: "/v1/mcp/create_thread",
      headers: {
        authorization: "Bearer coordinator_wk1"
      },
      payload: {
        workspace_id: "wk_01",
        title: "summary thread",
        type: "workflow",
        participants: ["a", "b"]
      }
    });

    const summaryResponse = await app.inject({
      method: "POST",
      url: "/v1/mcp/summarize_thread",
      headers: {
        authorization: "Bearer auditor_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        max_messages: 200
      }
    });

    expect(summaryResponse.statusCode).toBe(200);
    const payload = summarizeThreadOutputSchema.parse(summaryResponse.json());
    expect(payload.last_status).toBe("active");
    expect(typeof payload.summary).toBe("string");
  });
});
