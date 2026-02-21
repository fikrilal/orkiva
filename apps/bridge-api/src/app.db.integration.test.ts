import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuthError, type VerifiedAuthClaims } from "@orkiva/auth";
import { createDb, createDbPool } from "@orkiva/db";
import {
  ackReadOutputSchema,
  buildTriggerId,
  createThreadOutputSchema,
  heartbeatSessionOutputSchema,
  postMessageOutputSchema,
  protocolErrorResponseSchema,
  readMessagesOutputSchema,
  triggerParticipantOutputSchema
} from "@orkiva/protocol";

import { createBridgeApiApp } from "./app.js";
import { DbAuditStore } from "./audit-store.js";
import { DbSessionStore } from "./session-store.js";
import {
  DbThreadStore,
  type CreateMessageRecordInput,
  type MessageRecord,
  type ReadMessagesResult
} from "./thread-store.js";
import { DbTriggerStore } from "./trigger-store.js";

const runIntegration =
  process.env["RUN_DB_INTEGRATION_TESTS"] === "true" && Boolean(process.env["DATABASE_URL"]);
const describeDb = runIntegration ? describe : describe.skip;

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
  auditor_wk1: makeClaims("auditor", "wk_01", "auditor_agent")
};

class FaultInjectingDbThreadStore extends DbThreadStore {
  private failAfterPersistedWriteOnce = false;
  private failRecoveryIdempotencyLookupOnce = false;
  private failReadMessagesOnce = false;

  public injectPostWriteFault(): void {
    this.failAfterPersistedWriteOnce = true;
    this.failRecoveryIdempotencyLookupOnce = false;
  }

  public injectReadMessagesFault(): void {
    this.failReadMessagesOnce = true;
  }

  public override async createMessage(input: CreateMessageRecordInput): Promise<MessageRecord> {
    const created = await super.createMessage(input);
    if (this.failAfterPersistedWriteOnce) {
      this.failAfterPersistedWriteOnce = false;
      this.failRecoveryIdempotencyLookupOnce = true;
      throw new Error("Injected transient db post-write failure");
    }

    return created;
  }

  public override async getMessageByIdempotency(
    threadId: string,
    senderAgentId: string,
    idempotencyKey: string
  ): Promise<MessageRecord | null> {
    if (this.failRecoveryIdempotencyLookupOnce) {
      this.failRecoveryIdempotencyLookupOnce = false;
      throw new Error("Injected transient db idempotency lookup failure");
    }

    return super.getMessageByIdempotency(threadId, senderAgentId, idempotencyKey);
  }

  public override async readMessages(
    threadId: string,
    sinceSeq: number,
    limit: number
  ): Promise<ReadMessagesResult> {
    if (this.failReadMessagesOnce) {
      this.failReadMessagesOnce = false;
      throw new Error("Injected transient db read failure");
    }

    return super.readMessages(threadId, sinceSeq, limit);
  }
}

describeDb("bridge-api db integration", () => {
  const databaseUrl = process.env["DATABASE_URL"] as string;
  const pool = createDbPool(databaseUrl);
  const db = createDb(pool);
  const sessionStore = new DbSessionStore(db);
  const app = createBridgeApiApp({
    workspaceId: "wk_01",
    threadStore: new DbThreadStore(db),
    sessionStore,
    triggerStore: new DbTriggerStore(db),
    auditStore: new DbAuditStore(db),
    verifyAccessToken: (token) => {
      const claims = tokenMap[token];
      if (!claims) {
        throw new AuthError("UNAUTHORIZED", "Token not recognized");
      }

      return Promise.resolve(claims);
    },
    now: () => new Date("2026-02-18T10:00:00.000Z"),
    idGenerator: (() => {
      let idCounter = 0;
      return () => {
        idCounter += 1;
        return idCounter === 1 ? "fixed-id" : `fixed-id-${idCounter}`;
      };
    })()
  });

  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    await pool.query(`
      truncate table
        trigger_attempts,
        trigger_jobs,
        audit_events,
        participant_cursors,
        messages,
        thread_participants,
        session_registry,
        threads
      restart identity cascade
    `);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("persists thread/message/cursor flows in postgres", async () => {
    const createThread = await app.inject({
      method: "POST",
      url: "/v1/mcp/create_thread",
      headers: {
        authorization: "Bearer coordinator_wk1"
      },
      payload: {
        workspace_id: "wk_01",
        title: "db integration thread",
        type: "workflow",
        participants: ["participant_agent", "coordinator_agent"]
      }
    });
    expect(createThread.statusCode).toBe(200);
    createThreadOutputSchema.parse(createThread.json());

    const firstPost = await app.inject({
      method: "POST",
      url: "/v1/mcp/post_message",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        schema_version: 1,
        kind: "chat",
        body: "hello from postgres",
        idempotency_key: "idem_db_01"
      }
    });
    expect(firstPost.statusCode).toBe(200);
    const firstPostPayload = postMessageOutputSchema.parse(firstPost.json());

    const retryPost = await app.inject({
      method: "POST",
      url: "/v1/mcp/post_message",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: "th_fixed-id",
        schema_version: 1,
        kind: "chat",
        body: "hello from postgres",
        idempotency_key: "idem_db_01"
      }
    });
    expect(retryPost.statusCode).toBe(200);
    const retryPostPayload = postMessageOutputSchema.parse(retryPost.json());
    expect(retryPostPayload.message_id).toBe(firstPostPayload.message_id);
    expect(retryPostPayload.seq).toBe(firstPostPayload.seq);

    const rowCount = await pool.query<{ total: string }>(
      "select count(*)::text as total from messages where thread_id = $1",
      ["th_fixed-id"]
    );
    expect(rowCount.rows[0]?.total).toBe("1");

    const readPage = await app.inject({
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
    expect(readPage.statusCode).toBe(200);
    const readPayload = readMessagesOutputSchema.parse(readPage.json());
    expect(readPayload.messages).toHaveLength(1);
    expect(readPayload.messages[0]?.body).toBe("hello from postgres");

    const ack = await app.inject({
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
    expect(ack.statusCode).toBe(200);
    ackReadOutputSchema.parse(ack.json());

    const cursor = await pool.query<{ last_read_seq: string }>(
      "select last_read_seq::text from participant_cursors where thread_id = $1 and agent_id = $2",
      ["th_fixed-id", "participant_agent"]
    );
    expect(cursor.rows[0]?.last_read_seq).toBe("1");
  });

  it("normalizes event_version for persisted event messages", async () => {
    const createThread = await app.inject({
      method: "POST",
      url: "/v1/mcp/create_thread",
      headers: {
        authorization: "Bearer coordinator_wk1"
      },
      payload: {
        workspace_id: "wk_01",
        title: "db event version thread",
        type: "workflow",
        participants: ["participant_agent", "coordinator_agent"]
      }
    });
    expect(createThread.statusCode).toBe(200);
    const createdThread = createThreadOutputSchema.parse(createThread.json());

    const firstPost = await app.inject({
      method: "POST",
      url: "/v1/mcp/post_message",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: createdThread.thread_id,
        schema_version: 1,
        kind: "event",
        body: "event payload from postgres",
        metadata: {
          event_type: "finding_reported"
        },
        idempotency_key: "idem_event_db_01"
      }
    });
    expect(firstPost.statusCode).toBe(200);
    const firstPostPayload = postMessageOutputSchema.parse(firstPost.json());

    const replay = await app.inject({
      method: "POST",
      url: "/v1/mcp/post_message",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        thread_id: createdThread.thread_id,
        schema_version: 1,
        kind: "event",
        body: "event payload from postgres",
        metadata: {
          event_type: "finding_reported",
          event_version: 1
        },
        idempotency_key: "idem_event_db_01"
      }
    });
    expect(replay.statusCode).toBe(200);
    const replayPayload = postMessageOutputSchema.parse(replay.json());
    expect(replayPayload.message_id).toBe(firstPostPayload.message_id);

    const read = await app.inject({
      method: "POST",
      url: "/v1/mcp/read_messages",
      headers: {
        authorization: "Bearer coordinator_wk1"
      },
      payload: {
        thread_id: createdThread.thread_id,
        since_seq: 0,
        limit: 10
      }
    });
    expect(read.statusCode).toBe(200);
    const readPayload = readMessagesOutputSchema.parse(read.json());
    expect(readPayload.messages).toHaveLength(1);
    if (readPayload.messages[0]?.kind !== "event") {
      throw new Error("Expected event message");
    }
    expect(readPayload.messages[0].metadata["event_version"]).toBe(1);
  });

  it("replays idempotent post_message after transient db post-write failure without message loss", async () => {
    const faultThreadStore = new FaultInjectingDbThreadStore(db);
    const faultApp = createBridgeApiApp({
      workspaceId: "wk_01",
      threadStore: faultThreadStore,
      sessionStore,
      triggerStore: new DbTriggerStore(db),
      auditStore: new DbAuditStore(db),
      verifyAccessToken: (token) => {
        const claims = tokenMap[token];
        if (!claims) {
          throw new AuthError("UNAUTHORIZED", "Token not recognized");
        }

        return Promise.resolve(claims);
      },
      now: () => new Date("2026-02-18T10:00:00.000Z")
    });

    try {
      const createThread = await faultApp.inject({
        method: "POST",
        url: "/v1/mcp/create_thread",
        headers: {
          authorization: "Bearer coordinator_wk1"
        },
        payload: {
          workspace_id: "wk_01",
          title: "db fault replay thread",
          type: "workflow",
          participants: ["participant_agent", "coordinator_agent"]
        }
      });
      expect(createThread.statusCode).toBe(200);
      const createdThread = createThreadOutputSchema.parse(createThread.json());

      faultThreadStore.injectPostWriteFault();
      const requestPayload = {
        thread_id: createdThread.thread_id,
        schema_version: 1,
        kind: "chat" as const,
        body: "db fault replay payload",
        idempotency_key: "idem_fault_db_01"
      };

      const firstAttempt = await faultApp.inject({
        method: "POST",
        url: "/v1/mcp/post_message",
        headers: {
          authorization: "Bearer participant_wk1"
        },
        payload: requestPayload
      });
      expect(firstAttempt.statusCode).toBe(500);
      const firstErrorPayload = protocolErrorResponseSchema.parse(firstAttempt.json());
      expect(firstErrorPayload.error.code).toBe("INTERNAL");

      const replayAttempt = await faultApp.inject({
        method: "POST",
        url: "/v1/mcp/post_message",
        headers: {
          authorization: "Bearer participant_wk1"
        },
        payload: requestPayload
      });
      expect(replayAttempt.statusCode).toBe(200);
      const replayPayload = postMessageOutputSchema.parse(replayAttempt.json());
      expect(replayPayload.seq).toBe(1);

      const rowCount = await pool.query<{ total: string }>(
        `
        select count(*)::text as total
        from messages
        where thread_id = $1 and sender_agent_id = $2 and idempotency_key = $3
        `,
        [createdThread.thread_id, "participant_agent", "idem_fault_db_01"]
      );
      expect(rowCount.rows[0]?.total).toBe("1");

      const readBack = await faultApp.inject({
        method: "POST",
        url: "/v1/mcp/read_messages",
        headers: {
          authorization: "Bearer participant_wk1"
        },
        payload: {
          thread_id: createdThread.thread_id,
          since_seq: 0,
          limit: 10
        }
      });
      expect(readBack.statusCode).toBe(200);
      const readPayload = readMessagesOutputSchema.parse(readBack.json());
      expect(readPayload.messages).toHaveLength(1);
      expect(readPayload.messages[0]?.body).toBe("db fault replay payload");
      expect(readPayload.messages[0]?.seq).toBe(replayPayload.seq);
    } finally {
      await faultApp.close();
    }
  });

  it("retains acknowledged messages after transient db read failure on replay", async () => {
    const faultThreadStore = new FaultInjectingDbThreadStore(db);
    const faultApp = createBridgeApiApp({
      workspaceId: "wk_01",
      threadStore: faultThreadStore,
      sessionStore,
      triggerStore: new DbTriggerStore(db),
      auditStore: new DbAuditStore(db),
      verifyAccessToken: (token) => {
        const claims = tokenMap[token];
        if (!claims) {
          throw new AuthError("UNAUTHORIZED", "Token not recognized");
        }

        return Promise.resolve(claims);
      },
      now: () => new Date("2026-02-18T10:00:00.000Z")
    });

    try {
      const createThread = await faultApp.inject({
        method: "POST",
        url: "/v1/mcp/create_thread",
        headers: {
          authorization: "Bearer coordinator_wk1"
        },
        payload: {
          workspace_id: "wk_01",
          title: "db ack replay thread",
          type: "workflow",
          participants: ["participant_agent", "coordinator_agent"]
        }
      });
      expect(createThread.statusCode).toBe(200);
      const createdThread = createThreadOutputSchema.parse(createThread.json());

      const post = await faultApp.inject({
        method: "POST",
        url: "/v1/mcp/post_message",
        headers: {
          authorization: "Bearer participant_wk1"
        },
        payload: {
          thread_id: createdThread.thread_id,
          schema_version: 1,
          kind: "chat",
          body: "ack-safe payload",
          idempotency_key: "idem_ack_safe_01"
        }
      });
      expect(post.statusCode).toBe(200);
      postMessageOutputSchema.parse(post.json());

      const ack = await faultApp.inject({
        method: "POST",
        url: "/v1/mcp/ack_read",
        headers: {
          authorization: "Bearer participant_wk1"
        },
        payload: {
          thread_id: createdThread.thread_id,
          last_read_seq: 1
        }
      });
      expect(ack.statusCode).toBe(200);
      ackReadOutputSchema.parse(ack.json());

      faultThreadStore.injectReadMessagesFault();
      const firstRead = await faultApp.inject({
        method: "POST",
        url: "/v1/mcp/read_messages",
        headers: {
          authorization: "Bearer participant_wk1"
        },
        payload: {
          thread_id: createdThread.thread_id,
          since_seq: 0,
          limit: 10
        }
      });
      expect(firstRead.statusCode).toBe(500);
      const firstReadError = protocolErrorResponseSchema.parse(firstRead.json());
      expect(firstReadError.error.code).toBe("INTERNAL");

      const replayRead = await faultApp.inject({
        method: "POST",
        url: "/v1/mcp/read_messages",
        headers: {
          authorization: "Bearer participant_wk1"
        },
        payload: {
          thread_id: createdThread.thread_id,
          since_seq: 0,
          limit: 10
        }
      });
      expect(replayRead.statusCode).toBe(200);
      const replayReadPayload = readMessagesOutputSchema.parse(replayRead.json());
      expect(replayReadPayload.messages).toHaveLength(1);
      expect(replayReadPayload.messages[0]?.body).toBe("ack-safe payload");

      const rowCount = await pool.query<{ total: string }>(
        "select count(*)::text as total from messages where thread_id = $1",
        [createdThread.thread_id]
      );
      expect(rowCount.rows[0]?.total).toBe("1");
    } finally {
      await faultApp.close();
    }
  });

  it("persists heartbeat_session and supports latest resumable lookup", async () => {
    const heartbeat = await app.inject({
      method: "POST",
      url: "/v1/mcp/heartbeat_session",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        agent_id: "participant_agent",
        workspace_id: "wk_01",
        session_id: "sess_participant_agent",
        runtime: "codex_cli",
        management_mode: "managed",
        resumable: true,
        status: "idle"
      }
    });
    expect(heartbeat.statusCode).toBe(200);
    heartbeatSessionOutputSchema.parse(heartbeat.json());

    const latest = await sessionStore.getLatestResumableSession({
      agentId: "participant_agent",
      workspaceId: "wk_01",
      staleAfterHours: 12,
      referenceTime: new Date("2026-02-18T10:05:00.000Z")
    });

    expect(latest).not.toBeNull();
    expect(latest?.sessionId).toBe("sess_participant_agent");
    expect(latest?.managementMode).toBe("managed");
    expect(latest?.status).toBe("idle");
  });

  it("persists deterministic trigger_participant jobs", async () => {
    const createThread = await app.inject({
      method: "POST",
      url: "/v1/mcp/create_thread",
      headers: {
        authorization: "Bearer coordinator_wk1"
      },
      payload: {
        workspace_id: "wk_01",
        title: "db trigger thread",
        type: "workflow",
        participants: ["participant_agent", "coordinator_agent"]
      }
    });
    expect(createThread.statusCode).toBe(200);
    const createdThread = createThreadOutputSchema.parse(createThread.json());

    const heartbeat = await app.inject({
      method: "POST",
      url: "/v1/mcp/heartbeat_session",
      headers: {
        authorization: "Bearer participant_wk1"
      },
      payload: {
        session_id: "sess_participant_agent",
        runtime: "codex_cli",
        management_mode: "managed",
        resumable: true,
        status: "active"
      }
    });
    expect(heartbeat.statusCode).toBe(200);
    heartbeatSessionOutputSchema.parse(heartbeat.json());

    const first = await app.inject({
      method: "POST",
      url: "/v1/mcp/trigger_participant",
      headers: {
        authorization: "Bearer coordinator_wk1",
        "x-request-id": "req_db_trigger_01"
      },
      payload: {
        thread_id: createdThread.thread_id,
        target_agent_id: "participant_agent",
        reason: "new_unread_messages",
        trigger_prompt: "Continue processing unread work."
      }
    });
    expect(first.statusCode).toBe(200);
    const firstPayload = triggerParticipantOutputSchema.parse(first.json());
    expect(firstPayload.trigger_id).toBe(buildTriggerId("req_db_trigger_01"));
    expect(firstPayload.action).toBe("trigger_runtime");
    expect(firstPayload.job_status).toBe("queued");

    const retry = await app.inject({
      method: "POST",
      url: "/v1/mcp/trigger_participant",
      headers: {
        authorization: "Bearer coordinator_wk1",
        "x-request-id": "req_db_trigger_01"
      },
      payload: {
        thread_id: createdThread.thread_id,
        target_agent_id: "participant_agent",
        reason: "new_unread_messages",
        trigger_prompt: "Continue processing unread work."
      }
    });
    expect(retry.statusCode).toBe(200);
    const retryPayload = triggerParticipantOutputSchema.parse(retry.json());
    expect(retryPayload.trigger_id).toBe(firstPayload.trigger_id);

    const jobs = await pool.query<{ total: string; status: string }>(
      `
      select count(*)::text as total, min(status)::text as status
      from trigger_jobs
      where trigger_id = $1
      `,
      [firstPayload.trigger_id]
    );
    expect(jobs.rows[0]?.total).toBe("1");
    expect(jobs.rows[0]?.status).toBe("queued");
  });
});
