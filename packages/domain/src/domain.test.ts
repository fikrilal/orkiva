import { describe, expect, it } from "vitest";

import {
  DomainError,
  acknowledgeRead,
  applySessionHeartbeat,
  calculateUnreadCount,
  canTransitionThreadStatus,
  createMessage,
  createParticipantCursor,
  createSessionFromHeartbeat,
  createThread,
  findLatestResumableSession,
  getNextMessageSequence,
  isSessionStale,
  transitionThreadStatus
} from "./index.js";

const expectDomainError = (fn: () => unknown, expectedCode: string): void => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    if (error instanceof DomainError) {
      expect(error.code).toBe(expectedCode);
    }
    return;
  }

  throw new Error(`Expected DomainError with code ${expectedCode}`);
};

describe("thread domain", () => {
  it("creates a thread and supports valid transitions", () => {
    const createdAt = new Date("2026-02-18T10:00:00.000Z");
    const thread = createThread({
      threadId: "th_01",
      workspaceId: "wk_01",
      title: "Thread title",
      type: "workflow",
      participants: ["executioner_agent", "reviewer_agent"],
      createdAt
    });

    expect(thread.status).toBe("active");
    expect(canTransitionThreadStatus(thread.status, "blocked")).toBe(true);

    const blocked = transitionThreadStatus(thread, "blocked", new Date("2026-02-18T10:01:00.000Z"));
    expect(blocked.status).toBe("blocked");

    const reopened = transitionThreadStatus(
      blocked,
      "active",
      new Date("2026-02-18T10:02:00.000Z")
    );
    expect(reopened.status).toBe("active");

    const resolved = transitionThreadStatus(
      reopened,
      "resolved",
      new Date("2026-02-18T10:03:00.000Z")
    );
    const closed = transitionThreadStatus(resolved, "closed", new Date("2026-02-18T10:04:00.000Z"));
    expect(closed.status).toBe("closed");
  });

  it("rejects invalid transitions and duplicate participants", () => {
    expectDomainError(
      () =>
        createThread({
          threadId: "th_dup",
          workspaceId: "wk_01",
          title: "bad",
          type: "conversation",
          participants: ["agent_a", "agent_a"]
        }),
      "INVALID_ARGUMENT"
    );

    const thread = createThread({
      threadId: "th_blocked",
      workspaceId: "wk_01",
      title: "blocked thread",
      type: "incident",
      participants: ["agent_a"]
    });
    const blocked = transitionThreadStatus(thread, "blocked");

    expectDomainError(
      () => transitionThreadStatus(blocked, "resolved"),
      "INVALID_THREAD_TRANSITION"
    );
    expect(transitionThreadStatus(thread, "active")).toBe(thread);
  });
});

describe("message domain", () => {
  it("enforces sequence and message shape constraints", () => {
    expect(getNextMessageSequence(0)).toBe(1);
    expect(getNextMessageSequence(1)).toBe(2);
    expectDomainError(() => getNextMessageSequence(Number.MAX_SAFE_INTEGER), "SEQUENCE_OVERFLOW");

    const message = createMessage({
      messageId: "msg_01",
      threadId: "th_01",
      schemaVersion: 1,
      seq: 1,
      senderAgentId: "agent_a",
      senderSessionId: "sess_a",
      kind: "event",
      body: "finding reported",
      metadata: { event_type: "finding_reported" },
      idempotencyKey: "idem_01"
    });

    expect(message.seq).toBe(1);
    expect(message.schemaVersion).toBe(1);
    expect(message.kind).toBe("event");
  });

  it("rejects invalid schema version and invalid metadata", () => {
    expectDomainError(
      () =>
        createMessage({
          messageId: "msg_bad",
          threadId: "th_01",
          schemaVersion: 0,
          seq: 1,
          senderAgentId: "agent_a",
          senderSessionId: "sess_a",
          kind: "chat",
          body: "hello"
        }),
      "INVALID_ARGUMENT"
    );
  });
});

describe("cursor domain", () => {
  it("tracks monotonic read progress and unread counts", () => {
    const cursor = createParticipantCursor({
      threadId: "th_01",
      agentId: "agent_a",
      createdAt: new Date("2026-02-18T10:00:00.000Z")
    });

    const updated = acknowledgeRead(cursor, {
      lastReadSeq: 5,
      lastAckedMessageId: "msg_05",
      updatedAt: new Date("2026-02-18T10:10:00.000Z")
    });

    expect(updated.lastReadSeq).toBe(5);
    expect(updated.lastAckedMessageId).toBe("msg_05");
    expect(calculateUnreadCount(9, updated.lastReadSeq)).toBe(4);
  });

  it("rejects cursor regression", () => {
    const cursor = createParticipantCursor({ threadId: "th_01", agentId: "agent_a" });
    const updated = acknowledgeRead(cursor, { lastReadSeq: 3 });

    expectDomainError(() => acknowledgeRead(updated, { lastReadSeq: 2 }), "CURSOR_REGRESSION");
  });
});

describe("session domain", () => {
  it("upserts heartbeat and ignores stale heartbeat updates", () => {
    const initial = createSessionFromHeartbeat({
      agentId: "agent_a",
      workspaceId: "wk_01",
      sessionId: "sess_1",
      runtime: "codex_cli",
      managementMode: "managed",
      resumable: true,
      status: "active",
      heartbeatAt: new Date("2026-02-18T10:00:00.000Z")
    });

    const stale = applySessionHeartbeat(initial, {
      agentId: "agent_a",
      workspaceId: "wk_01",
      sessionId: "sess_older",
      runtime: "codex_cli",
      managementMode: "managed",
      resumable: true,
      status: "idle",
      heartbeatAt: new Date("2026-02-18T09:59:00.000Z")
    });
    expect(stale).toBe(initial);

    const fresh = applySessionHeartbeat(initial, {
      agentId: "agent_a",
      workspaceId: "wk_01",
      sessionId: "sess_2",
      runtime: "codex_cli",
      managementMode: "managed",
      resumable: true,
      status: "idle",
      heartbeatAt: new Date("2026-02-18T10:01:00.000Z")
    });

    expect(fresh.sessionId).toBe("sess_2");
    expect(fresh.status).toBe("idle");
  });

  it("detects stale sessions and finds latest resumable non-stale record", () => {
    const referenceTime = new Date("2026-02-18T12:00:00.000Z");
    const records = [
      createSessionFromHeartbeat({
        agentId: "agent_a",
        workspaceId: "wk_01",
        sessionId: "sess_stale",
        runtime: "codex_cli",
        managementMode: "managed",
        resumable: true,
        status: "offline",
        heartbeatAt: new Date("2026-02-18T06:00:00.000Z")
      }),
      createSessionFromHeartbeat({
        agentId: "agent_a",
        workspaceId: "wk_01",
        sessionId: "sess_latest",
        runtime: "codex_cli",
        managementMode: "managed",
        resumable: true,
        status: "idle",
        heartbeatAt: new Date("2026-02-18T11:30:00.000Z")
      })
    ];
    const staleRecord = records[0];
    const latestRecord = records[1];
    if (!staleRecord || !latestRecord) {
      throw new Error("Expected two session records");
    }

    expect(isSessionStale(staleRecord, 4, referenceTime)).toBe(true);
    expect(isSessionStale(latestRecord, 4, referenceTime)).toBe(false);

    const latest = findLatestResumableSession(records, {
      agentId: "agent_a",
      workspaceId: "wk_01",
      staleAfterHours: 4,
      referenceTime
    });
    expect(latest?.sessionId).toBe("sess_latest");
  });

  it("rejects heartbeat scope mismatch", () => {
    const existing = createSessionFromHeartbeat({
      agentId: "agent_a",
      workspaceId: "wk_01",
      sessionId: "sess_1",
      runtime: "codex_cli",
      managementMode: "managed",
      resumable: true,
      status: "active"
    });

    expectDomainError(
      () =>
        applySessionHeartbeat(existing, {
          agentId: "agent_other",
          workspaceId: "wk_01",
          sessionId: "sess_2",
          runtime: "codex_cli",
          managementMode: "managed",
          resumable: true,
          status: "active"
        }),
      "SESSION_SCOPE_MISMATCH"
    );
  });
});
