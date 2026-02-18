import { afterEach, describe, expect, it } from "vitest";

import { AuthError, type VerifiedAuthClaims } from "@orkiva/auth";
import type { ThreadStatus } from "@orkiva/domain";
import {
  ackReadOutputSchema,
  createThreadOutputSchema,
  getThreadOutputSchema,
  postMessageOutputSchema,
  protocolErrorResponseSchema,
  readMessagesOutputSchema,
  summarizeThreadOutputSchema,
  updateThreadStatusOutputSchema
} from "@orkiva/protocol";

import { createBridgeApiApp } from "./app.js";
import { InMemoryAuditStore } from "./audit-store.js";
import { InMemoryThreadStore, type ThreadRecord } from "./thread-store.js";

class ConflictOnSecondStatusUpdateStore extends InMemoryThreadStore {
  private successfulStatusUpdates = 0;

  public override async updateThreadStatus(
    threadId: string,
    nextStatus: ThreadStatus,
    updatedAt: Date,
    options?: {
      expectedCurrentStatus?: ThreadStatus;
    }
  ): Promise<ThreadRecord | null> {
    if (this.successfulStatusUpdates >= 1) {
      return null;
    }

    const updated = await super.updateThreadStatus(threadId, nextStatus, updatedAt, options);
    if (updated !== null) {
      this.successfulStatusUpdates += 1;
    }

    return updated;
  }
}

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

const createTestApp = (options?: {
  auditStore?: InMemoryAuditStore;
  threadStore?: InMemoryThreadStore;
}) => {
  let idCounter = 0;

  return createBridgeApiApp({
    threadStore: options?.threadStore ?? new InMemoryThreadStore(),
    ...(options?.auditStore === undefined ? {} : { auditStore: options.auditStore }),
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
      return idCounter === 1 ? "fixed-id" : `fixed-id-${idCounter}`;
    }
  });
};

describe("bridge-api phase 4-5", () => {
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

  it("requires explicit override reason to close a blocked thread", async () => {
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
        title: "override reason thread",
        type: "workflow",
        participants: ["participant_agent"]
      }
    });

    const blocked = await app.inject({
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
    expect(blocked.statusCode).toBe(200);

    const noOverride = await app.inject({
      method: "POST",
      url: "/v1/mcp/update_thread_status",
      headers: {
        authorization: "Bearer coordinator_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        status: "closed",
        reason: "manual_close"
      }
    });
    expect(noOverride.statusCode).toBe(403);
    const noOverridePayload = protocolErrorResponseSchema.parse(noOverride.json());
    expect(noOverridePayload.error.code).toBe("FORBIDDEN");

    const withOverride = await app.inject({
      method: "POST",
      url: "/v1/mcp/update_thread_status",
      headers: {
        authorization: "Bearer coordinator_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        status: "closed",
        reason: "coordinator_override:human_approved"
      }
    });
    expect(withOverride.statusCode).toBe(200);
    updateThreadStatusOutputSchema.parse(withOverride.json());
  });

  it("returns conflict for competing status updates", async () => {
    const app = createTestApp({
      threadStore: new ConflictOnSecondStatusUpdateStore()
    });
    appsToClose.push(app);

    await app.inject({
      method: "POST",
      url: "/v1/mcp/create_thread",
      headers: {
        authorization: "Bearer coordinator_wk1"
      },
      payload: {
        workspace_id: "wk_01",
        title: "status conflict thread",
        type: "workflow",
        participants: ["participant_agent"]
      }
    });

    const [left, right] = await Promise.all([
      app.inject({
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
      }),
      app.inject({
        method: "POST",
        url: "/v1/mcp/update_thread_status",
        headers: {
          authorization: "Bearer coordinator_wk1"
        },
        payload: {
          thread_id: "th_fixed-id",
          status: "resolved",
          reason: "all_findings_verified"
        }
      })
    ]);

    const statusCodes = [left.statusCode, right.statusCode].sort((a, b) => a - b);
    expect(statusCodes).toStrictEqual([200, 409]);

    const conflictResponse = left.statusCode === 409 ? left : right;
    const conflictPayload = protocolErrorResponseSchema.parse(conflictResponse.json());
    expect(conflictPayload.error.code).toBe("CONFLICT");
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

  it("posts messages and reads them in deterministic order with pagination", async () => {
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
        title: "message read thread",
        type: "workflow",
        participants: ["participant_agent", "coordinator_agent"]
      }
    });

    const postOne = await app.inject({
      method: "POST",
      url: "/v1/mcp/post_message",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        schema_version: 1,
        sender_agent_id: "participant_agent",
        sender_session_id: "sess_participant_agent",
        kind: "chat",
        body: "message-one"
      }
    });
    expect(postOne.statusCode).toBe(200);
    postMessageOutputSchema.parse(postOne.json());

    const postTwo = await app.inject({
      method: "POST",
      url: "/v1/mcp/post_message",
      headers: {
        authorization: "Bearer coordinator_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        schema_version: 1,
        kind: "event",
        body: "message-two",
        metadata: {
          event_type: "update"
        }
      }
    });
    expect(postTwo.statusCode).toBe(200);
    postMessageOutputSchema.parse(postTwo.json());

    const firstPage = await app.inject({
      method: "POST",
      url: "/v1/mcp/read_messages",
      headers: {
        authorization: "Bearer auditor_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        since_seq: 0,
        limit: 1
      }
    });
    expect(firstPage.statusCode).toBe(200);
    const firstPayload = readMessagesOutputSchema.parse(firstPage.json());
    expect(firstPayload.messages).toHaveLength(1);
    expect(firstPayload.messages[0]?.seq).toBe(1);
    expect(firstPayload.messages[0]?.body).toBe("message-one");
    expect(firstPayload.next_seq).toBe(1);
    expect(firstPayload.has_more).toBe(true);

    const secondPage = await app.inject({
      method: "POST",
      url: "/v1/mcp/read_messages",
      headers: {
        authorization: "Bearer auditor_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        since_seq: firstPayload.next_seq,
        limit: 1
      }
    });
    expect(secondPage.statusCode).toBe(200);
    const secondPayload = readMessagesOutputSchema.parse(secondPage.json());
    expect(secondPayload.messages).toHaveLength(1);
    expect(secondPayload.messages[0]?.seq).toBe(2);
    expect(secondPayload.messages[0]?.body).toBe("message-two");
    expect(secondPayload.next_seq).toBe(2);
    expect(secondPayload.has_more).toBe(false);

    const emptyPage = await app.inject({
      method: "POST",
      url: "/v1/mcp/read_messages",
      headers: {
        authorization: "Bearer auditor_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        since_seq: secondPayload.next_seq,
        limit: 10
      }
    });
    expect(emptyPage.statusCode).toBe(200);
    const emptyPayload = readMessagesOutputSchema.parse(emptyPage.json());
    expect(emptyPayload.messages).toHaveLength(0);
    expect(emptyPayload.next_seq).toBe(2);
    expect(emptyPayload.has_more).toBe(false);
  });

  it("supports idempotent post_message retries and rejects conflicting reuse", async () => {
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
        title: "idempotency thread",
        type: "workflow",
        participants: ["participant_agent"]
      }
    });

    const first = await app.inject({
      method: "POST",
      url: "/v1/mcp/post_message",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        schema_version: 1,
        kind: "chat",
        body: "stable payload",
        idempotency_key: "idem_01"
      }
    });
    expect(first.statusCode).toBe(200);
    const firstPayload = postMessageOutputSchema.parse(first.json());

    const retry = await app.inject({
      method: "POST",
      url: "/v1/mcp/post_message",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        schema_version: 1,
        kind: "chat",
        body: "stable payload",
        idempotency_key: "idem_01"
      }
    });
    expect(retry.statusCode).toBe(200);
    const retryPayload = postMessageOutputSchema.parse(retry.json());
    expect(retryPayload.message_id).toBe(firstPayload.message_id);
    expect(retryPayload.seq).toBe(firstPayload.seq);

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/mcp/post_message",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        schema_version: 1,
        kind: "chat",
        body: "changed payload",
        idempotency_key: "idem_01"
      }
    });
    expect(conflict.statusCode).toBe(409);
    const conflictPayload = protocolErrorResponseSchema.parse(conflict.json());
    expect(conflictPayload.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("handles concurrent duplicate post_message retries without duplicate writes", async () => {
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
        title: "concurrent idempotency thread",
        type: "workflow",
        participants: ["participant_agent"]
      }
    });

    const requestPayload = {
      thread_id: "th_fixed-id",
      schema_version: 1,
      kind: "chat" as const,
      body: "parallel payload",
      idempotency_key: "idem_parallel_01"
    };

    const [left, right] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/mcp/post_message",
        headers: {
          authorization: "Bearer participant_wk1"
        },
        payload: requestPayload
      }),
      app.inject({
        method: "POST",
        url: "/v1/mcp/post_message",
        headers: {
          authorization: "Bearer participant_wk1"
        },
        payload: requestPayload
      })
    ]);

    expect(left.statusCode).toBe(200);
    expect(right.statusCode).toBe(200);
    const leftPayload = postMessageOutputSchema.parse(left.json());
    const rightPayload = postMessageOutputSchema.parse(right.json());
    expect(leftPayload.message_id).toBe(rightPayload.message_id);
    expect(leftPayload.seq).toBe(rightPayload.seq);

    const readBack = await app.inject({
      method: "POST",
      url: "/v1/mcp/read_messages",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        since_seq: 0,
        limit: 10
      }
    });
    expect(readBack.statusCode).toBe(200);
    const readPayload = readMessagesOutputSchema.parse(readBack.json());
    expect(readPayload.messages).toHaveLength(1);
    expect(readPayload.messages[0]?.body).toBe("parallel payload");
  });

  it("retries concurrent non-idempotent writes and preserves monotonic sequencing", async () => {
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
        title: "concurrent sequencing thread",
        type: "workflow",
        participants: ["participant_agent"]
      }
    });

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/mcp/post_message",
        headers: {
          authorization: "Bearer participant_wk1"
        },
        payload: {
          thread_id: "th_fixed-id",
          schema_version: 1,
          kind: "chat",
          body: "parallel-one"
        }
      }),
      app.inject({
        method: "POST",
        url: "/v1/mcp/post_message",
        headers: {
          authorization: "Bearer participant_wk1"
        },
        payload: {
          thread_id: "th_fixed-id",
          schema_version: 1,
          kind: "chat",
          body: "parallel-two"
        }
      })
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstPayload = postMessageOutputSchema.parse(first.json());
    const secondPayload = postMessageOutputSchema.parse(second.json());
    const seqs = [firstPayload.seq, secondPayload.seq].sort((a, b) => a - b);
    expect(seqs).toStrictEqual([1, 2]);

    const readBack = await app.inject({
      method: "POST",
      url: "/v1/mcp/read_messages",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        since_seq: 0,
        limit: 10
      }
    });
    expect(readBack.statusCode).toBe(200);
    const readPayload = readMessagesOutputSchema.parse(readBack.json());
    expect(readPayload.messages).toHaveLength(2);
    expect(readPayload.messages[0]?.seq).toBe(1);
    expect(readPayload.messages[1]?.seq).toBe(2);
  });

  it("rejects sender identity mismatch hints for post_message", async () => {
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
        title: "identity thread",
        type: "workflow",
        participants: ["participant_agent"]
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/mcp/post_message",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        schema_version: 1,
        sender_agent_id: "someone_else",
        kind: "chat",
        body: "bad hint"
      }
    });

    expect(response.statusCode).toBe(403);
    const payload = protocolErrorResponseSchema.parse(response.json());
    expect(payload.error.code).toBe("FORBIDDEN");
  });

  it("acknowledges read progress monotonically and rejects regression", async () => {
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
        title: "ack thread",
        type: "workflow",
        participants: ["participant_agent"]
      }
    });

    await app.inject({
      method: "POST",
      url: "/v1/mcp/post_message",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        schema_version: 1,
        kind: "chat",
        body: "m1"
      }
    });
    await app.inject({
      method: "POST",
      url: "/v1/mcp/post_message",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        schema_version: 1,
        kind: "chat",
        body: "m2"
      }
    });

    const firstAck = await app.inject({
      method: "POST",
      url: "/v1/mcp/ack_read",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        agent_id: "participant_agent",
        last_read_seq: 1
      }
    });
    expect(firstAck.statusCode).toBe(200);
    ackReadOutputSchema.parse(firstAck.json());

    const secondAck = await app.inject({
      method: "POST",
      url: "/v1/mcp/ack_read",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        last_read_seq: 2
      }
    });
    expect(secondAck.statusCode).toBe(200);
    ackReadOutputSchema.parse(secondAck.json());

    const regression = await app.inject({
      method: "POST",
      url: "/v1/mcp/ack_read",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        last_read_seq: 1
      }
    });
    expect(regression.statusCode).toBe(409);
    const regressionPayload = protocolErrorResponseSchema.parse(regression.json());
    expect(regressionPayload.error.code).toBe("CONFLICT");
  });

  it("rejects ack_read beyond latest sequence", async () => {
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
        title: "ack bounds thread",
        type: "workflow",
        participants: ["participant_agent"]
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/mcp/ack_read",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        last_read_seq: 1
      }
    });
    expect(response.statusCode).toBe(400);
    const payload = protocolErrorResponseSchema.parse(response.json());
    expect(payload.error.code).toBe("INVALID_ARGUMENT");
  });

  it("emits audit events for auth rejections, authority rejections, and status transitions", async () => {
    const auditStore = new InMemoryAuditStore();
    const app = createTestApp({ auditStore });
    appsToClose.push(app);

    const noAuth = await app.inject({
      method: "POST",
      url: "/v1/mcp/create_thread",
      payload: {
        workspace_id: "wk_01",
        title: "audit thread",
        type: "workflow",
        participants: ["participant_agent"]
      }
    });
    expect(noAuth.statusCode).toBe(401);

    const created = await app.inject({
      method: "POST",
      url: "/v1/mcp/create_thread",
      headers: {
        authorization: "Bearer coordinator_wk1"
      },
      payload: {
        workspace_id: "wk_01",
        title: "audit thread",
        type: "workflow",
        participants: ["participant_agent"]
      }
    });
    expect(created.statusCode).toBe(200);

    const authorityRejected = await app.inject({
      method: "POST",
      url: "/v1/mcp/update_thread_status",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        status: "closed",
        reason: "manual_close"
      }
    });
    expect(authorityRejected.statusCode).toBe(403);

    const transitioned = await app.inject({
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
    expect(transitioned.statusCode).toBe(200);

    const authRejectionAudit = auditStore.events.find(
      (event) => event.operation === "mcp.create_thread" && event.result === "rejected"
    );
    expect(authRejectionAudit).toBeDefined();

    const authorityAudit = auditStore.events.find(
      (event) =>
        event.operation === "mcp.update_thread_status" &&
        event.result === "rejected" &&
        event.actorAgentId === "participant_agent"
    );
    expect(authorityAudit).toBeDefined();

    const transitionAudit = auditStore.events.find(
      (event) =>
        event.operation === "mcp.update_thread_status" &&
        event.result === "success" &&
        event.actorAgentId === "coordinator_agent"
    );
    expect(transitionAudit).toBeDefined();
    expect(transitionAudit?.payload).toMatchObject({
      from_status: "active",
      to_status: "blocked",
      reason: "waiting_review"
    });
  });
});
