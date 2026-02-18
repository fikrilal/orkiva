import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuthError, type VerifiedAuthClaims } from "@orkiva/auth";
import { createDb, createDbPool } from "@orkiva/db";
import {
  ackReadOutputSchema,
  createThreadOutputSchema,
  heartbeatSessionOutputSchema,
  postMessageOutputSchema,
  readMessagesOutputSchema,
  triggerParticipantOutputSchema
} from "@orkiva/protocol";

import { createBridgeApiApp } from "./app.js";
import { DbAuditStore } from "./audit-store.js";
import { DbSessionStore } from "./session-store.js";
import { DbThreadStore } from "./thread-store.js";
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

describeDb("bridge-api db integration", () => {
  const databaseUrl = process.env["DATABASE_URL"] as string;
  const pool = createDbPool(databaseUrl);
  const db = createDb(pool);
  const sessionStore = new DbSessionStore(db);
  const app = createBridgeApiApp({
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
    createThreadOutputSchema.parse(createThread.json());

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
        thread_id: "th_fixed-id",
        target_agent_id: "participant_agent",
        reason: "new_unread_messages",
        trigger_prompt: "Continue processing unread work."
      }
    });
    expect(first.statusCode).toBe(200);
    const firstPayload = triggerParticipantOutputSchema.parse(first.json());
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
        thread_id: "th_fixed-id",
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
