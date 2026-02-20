import { describe, expect, it } from "vitest";

import type { ThreadStatus } from "@orkiva/domain";

import {
  InMemoryUnreadReconciliationSnapshotStore,
  InMemoryUnreadReconciliationStateStore,
  UnreadReconciliationService,
  type UnreadParticipantSnapshot
} from "./unread-reconciliation.js";

const snapshot = (input: {
  threadId: string;
  workspaceId?: string;
  threadStatus?: ThreadStatus;
  participantAgentId: string;
  latestSeq: number;
  lastReadSeq: number;
  session?: {
    sessionId: string;
    managementMode: "managed" | "unmanaged";
    resumable: boolean;
    status: "active" | "idle" | "offline";
    lastHeartbeatAt: string;
  } | null;
}): UnreadParticipantSnapshot => ({
  threadId: input.threadId,
  workspaceId: input.workspaceId ?? "wk_01",
  threadStatus: input.threadStatus ?? "active",
  participantAgentId: input.participantAgentId,
  latestSeq: input.latestSeq,
  lastReadSeq: input.lastReadSeq,
  session:
    input.session === undefined || input.session === null
      ? (input.session ?? null)
      : {
          ...input.session,
          lastHeartbeatAt: new Date(input.session.lastHeartbeatAt)
        }
});

describe("unread reconciliation", () => {
  it("returns no candidates when participants have no unread work", async () => {
    const snapshots = new InMemoryUnreadReconciliationSnapshotStore([
      snapshot({
        threadId: "th_01",
        participantAgentId: "agent_a",
        latestSeq: 3,
        lastReadSeq: 3,
        session: {
          sessionId: "sess_a",
          managementMode: "managed",
          resumable: true,
          status: "active",
          lastHeartbeatAt: "2026-02-18T10:00:00.000Z"
        }
      })
    ]);
    const service = new UnreadReconciliationService(
      snapshots,
      new InMemoryUnreadReconciliationStateStore()
    );

    const result = await service.reconcile({
      workspaceId: "wk_01",
      staleAfterHours: 12,
      polledAt: new Date("2026-02-18T10:01:00.000Z")
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.stats.unreadParticipants).toBe(0);
  });

  it("detects unread dormant participant and returns candidate", async () => {
    const snapshots = new InMemoryUnreadReconciliationSnapshotStore([
      snapshot({
        threadId: "th_02",
        participantAgentId: "agent_b",
        latestSeq: 6,
        lastReadSeq: 2,
        session: {
          sessionId: "sess_b",
          managementMode: "managed",
          resumable: true,
          status: "idle",
          lastHeartbeatAt: "2026-02-18T10:00:00.000Z"
        }
      })
    ]);
    const service = new UnreadReconciliationService(
      snapshots,
      new InMemoryUnreadReconciliationStateStore()
    );

    const result = await service.reconcile({
      workspaceId: "wk_01",
      staleAfterHours: 12,
      polledAt: new Date("2026-02-18T10:10:00.000Z")
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      threadId: "th_02",
      participantAgentId: "agent_b",
      unreadCount: 4,
      reason: "new_unread_dormant_participant"
    });
    expect(result.stats.unreadParticipants).toBe(1);
    expect(result.stats.dormantUnreadParticipants).toBe(1);
  });

  it("handles mixed multi-participant states deterministically", async () => {
    const snapshots = new InMemoryUnreadReconciliationSnapshotStore([
      snapshot({
        threadId: "th_03",
        participantAgentId: "agent_active",
        latestSeq: 5,
        lastReadSeq: 1,
        session: {
          sessionId: "sess_active",
          managementMode: "managed",
          resumable: true,
          status: "active",
          lastHeartbeatAt: "2026-02-18T10:30:00.000Z"
        }
      }),
      snapshot({
        threadId: "th_03",
        participantAgentId: "agent_dormant",
        latestSeq: 5,
        lastReadSeq: 2,
        session: {
          sessionId: "sess_dormant",
          managementMode: "managed",
          resumable: true,
          status: "offline",
          lastHeartbeatAt: "2026-02-18T09:00:00.000Z"
        }
      }),
      snapshot({
        threadId: "th_04",
        threadStatus: "closed",
        participantAgentId: "agent_closed",
        latestSeq: 7,
        lastReadSeq: 0,
        session: null
      })
    ]);
    const service = new UnreadReconciliationService(
      snapshots,
      new InMemoryUnreadReconciliationStateStore()
    );

    const result = await service.reconcile({
      workspaceId: "wk_01",
      staleAfterHours: 12,
      polledAt: new Date("2026-02-18T10:35:00.000Z")
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.participantAgentId).toBe("agent_dormant");
    expect(result.stats.participantsScanned).toBe(2);
    expect(result.stats.unreadParticipants).toBe(2);
    expect(result.stats.dormantUnreadParticipants).toBe(1);
  });

  it("deduplicates repeated polling until new unread sequence appears", async () => {
    const snapshots = new InMemoryUnreadReconciliationSnapshotStore([
      snapshot({
        threadId: "th_05",
        participantAgentId: "agent_repeat",
        latestSeq: 10,
        lastReadSeq: 4,
        session: {
          sessionId: "sess_repeat",
          managementMode: "managed",
          resumable: true,
          status: "idle",
          lastHeartbeatAt: "2026-02-18T10:00:00.000Z"
        }
      })
    ]);
    const state = new InMemoryUnreadReconciliationStateStore();
    const service = new UnreadReconciliationService(snapshots, state);

    const first = await service.reconcile({
      workspaceId: "wk_01",
      staleAfterHours: 12,
      polledAt: new Date("2026-02-18T10:40:00.000Z")
    });
    expect(first.candidates).toHaveLength(1);

    const second = await service.reconcile({
      workspaceId: "wk_01",
      staleAfterHours: 12,
      polledAt: new Date("2026-02-18T10:41:00.000Z")
    });
    expect(second.candidates).toHaveLength(0);
    expect(second.stats.deduplicatedParticipants).toBe(1);

    snapshots.setSnapshots([
      snapshot({
        threadId: "th_05",
        participantAgentId: "agent_repeat",
        latestSeq: 11,
        lastReadSeq: 4,
        session: {
          sessionId: "sess_repeat",
          managementMode: "managed",
          resumable: true,
          status: "idle",
          lastHeartbeatAt: "2026-02-18T10:00:00.000Z"
        }
      })
    ]);
    const third = await service.reconcile({
      workspaceId: "wk_01",
      staleAfterHours: 12,
      polledAt: new Date("2026-02-18T10:42:00.000Z")
    });
    expect(third.candidates).toHaveLength(1);
    expect(third.candidates[0]?.latestSeq).toBe(11);
  });
});
