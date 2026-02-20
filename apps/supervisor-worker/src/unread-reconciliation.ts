import type { DbClient } from "@orkiva/db";
import {
  isSessionStale,
  type ManagementMode,
  type SessionStatus,
  type ThreadStatus
} from "@orkiva/domain";
import { and, eq, inArray, ne } from "drizzle-orm";

interface SessionSnapshot {
  sessionId: string;
  managementMode: ManagementMode;
  resumable: boolean;
  status: SessionStatus;
  lastHeartbeatAt: Date;
}

export interface UnreadParticipantSnapshot {
  threadId: string;
  workspaceId: string;
  threadStatus: ThreadStatus;
  participantAgentId: string;
  latestSeq: number;
  lastReadSeq: number;
  session: SessionSnapshot | null;
}

export interface UnreadReconciliationSnapshotStore {
  listParticipantSnapshots(input: {
    workspaceId: string;
    includeClosedThreads: boolean;
  }): Promise<readonly UnreadParticipantSnapshot[]>;
}

const reconciliationStateKey = (threadId: string, agentId: string): string =>
  `${threadId}::${agentId}`;

export interface UnreadReconciliationStateStore {
  getLastNotifiedSeq(threadId: string, agentId: string): Promise<number | null>;
  markNotified(
    threadId: string,
    agentId: string,
    latestSeq: number,
    notifiedAt: Date
  ): Promise<void>;
}

export interface UnreadReconciliationInput {
  workspaceId: string;
  staleAfterHours: number;
  includeClosedThreads?: boolean;
  polledAt?: Date;
}

export interface UnreadReconciliationCandidate {
  threadId: string;
  workspaceId: string;
  participantAgentId: string;
  unreadCount: number;
  latestSeq: number;
  lastReadSeq: number;
  sessionStatus: SessionStatus | "missing";
  sessionId?: string;
  managementMode?: ManagementMode;
  resumable?: boolean;
  staleSession: boolean;
  reason: "new_unread_dormant_participant";
}

export interface UnreadReconciliationResult {
  workspaceId: string;
  polledAt: Date;
  candidates: readonly UnreadReconciliationCandidate[];
  stats: {
    participantsScanned: number;
    unreadParticipants: number;
    dormantUnreadParticipants: number;
    deduplicatedParticipants: number;
  };
}

const isDormantSession = (
  session: SessionSnapshot | null,
  staleAfterHours: number,
  referenceTime: Date
): boolean => {
  if (session === null) {
    return true;
  }

  if (session.status !== "active") {
    return true;
  }

  return isSessionStale(
    {
      agentId: "n/a",
      workspaceId: "n/a",
      sessionId: session.sessionId,
      runtime: "n/a",
      managementMode: session.managementMode,
      resumable: session.resumable,
      status: session.status,
      lastHeartbeatAt: session.lastHeartbeatAt,
      updatedAt: session.lastHeartbeatAt
    },
    staleAfterHours,
    referenceTime
  );
};

export class UnreadReconciliationService {
  public constructor(
    private readonly snapshotStore: UnreadReconciliationSnapshotStore,
    private readonly stateStore: UnreadReconciliationStateStore
  ) {}

  public async reconcile(input: UnreadReconciliationInput): Promise<UnreadReconciliationResult> {
    const includeClosedThreads = input.includeClosedThreads ?? false;
    const polledAt = input.polledAt ?? new Date();
    const snapshots = await this.snapshotStore.listParticipantSnapshots({
      workspaceId: input.workspaceId,
      includeClosedThreads
    });

    const candidates: UnreadReconciliationCandidate[] = [];
    let unreadParticipants = 0;
    let dormantUnreadParticipants = 0;
    let deduplicatedParticipants = 0;

    for (const snapshot of snapshots) {
      if (snapshot.latestSeq <= snapshot.lastReadSeq) {
        continue;
      }
      unreadParticipants += 1;

      const isDormant = isDormantSession(snapshot.session, input.staleAfterHours, polledAt);
      if (!isDormant) {
        continue;
      }
      dormantUnreadParticipants += 1;

      const lastNotifiedSeq = await this.stateStore.getLastNotifiedSeq(
        snapshot.threadId,
        snapshot.participantAgentId
      );
      if (lastNotifiedSeq !== null && lastNotifiedSeq >= snapshot.latestSeq) {
        deduplicatedParticipants += 1;
        continue;
      }

      await this.stateStore.markNotified(
        snapshot.threadId,
        snapshot.participantAgentId,
        snapshot.latestSeq,
        polledAt
      );
      candidates.push({
        threadId: snapshot.threadId,
        workspaceId: snapshot.workspaceId,
        participantAgentId: snapshot.participantAgentId,
        unreadCount: snapshot.latestSeq - snapshot.lastReadSeq,
        latestSeq: snapshot.latestSeq,
        lastReadSeq: snapshot.lastReadSeq,
        sessionStatus: snapshot.session?.status ?? "missing",
        ...(snapshot.session === null ? {} : { sessionId: snapshot.session.sessionId }),
        ...(snapshot.session === null ? {} : { managementMode: snapshot.session.managementMode }),
        ...(snapshot.session === null ? {} : { resumable: snapshot.session.resumable }),
        staleSession:
          snapshot.session === null
            ? false
            : isSessionStale(
                {
                  agentId: "n/a",
                  workspaceId: "n/a",
                  sessionId: snapshot.session.sessionId,
                  runtime: "n/a",
                  managementMode: snapshot.session.managementMode,
                  resumable: snapshot.session.resumable,
                  status: snapshot.session.status,
                  lastHeartbeatAt: snapshot.session.lastHeartbeatAt,
                  updatedAt: snapshot.session.lastHeartbeatAt
                },
                input.staleAfterHours,
                polledAt
              ),
        reason: "new_unread_dormant_participant"
      });
    }

    return {
      workspaceId: input.workspaceId,
      polledAt,
      candidates,
      stats: {
        participantsScanned: snapshots.length,
        unreadParticipants,
        dormantUnreadParticipants,
        deduplicatedParticipants
      }
    };
  }
}

export class InMemoryUnreadReconciliationSnapshotStore implements UnreadReconciliationSnapshotStore {
  private snapshots: readonly UnreadParticipantSnapshot[];

  public constructor(snapshots: readonly UnreadParticipantSnapshot[] = []) {
    this.snapshots = [...snapshots];
  }

  public setSnapshots(snapshots: readonly UnreadParticipantSnapshot[]): void {
    this.snapshots = [...snapshots];
  }

  public listParticipantSnapshots(input: {
    workspaceId: string;
    includeClosedThreads: boolean;
  }): Promise<readonly UnreadParticipantSnapshot[]> {
    return Promise.resolve(
      this.snapshots.filter((snapshot) => {
        if (snapshot.workspaceId !== input.workspaceId) {
          return false;
        }
        if (!input.includeClosedThreads && snapshot.threadStatus === "closed") {
          return false;
        }
        return true;
      })
    );
  }
}

export class InMemoryUnreadReconciliationStateStore implements UnreadReconciliationStateStore {
  private readonly state = new Map<
    string,
    {
      latestSeq: number;
      notifiedAt: Date;
    }
  >();

  public getLastNotifiedSeq(threadId: string, agentId: string): Promise<number | null> {
    const existing = this.state.get(reconciliationStateKey(threadId, agentId));
    return Promise.resolve(existing?.latestSeq ?? null);
  }

  public markNotified(
    threadId: string,
    agentId: string,
    latestSeq: number,
    notifiedAt: Date
  ): Promise<void> {
    this.state.set(reconciliationStateKey(threadId, agentId), {
      latestSeq,
      notifiedAt
    });
    return Promise.resolve();
  }
}

export class DbUnreadReconciliationSnapshotStore implements UnreadReconciliationSnapshotStore {
  public constructor(private readonly db: DbClient) {}

  public async listParticipantSnapshots(input: {
    workspaceId: string;
    includeClosedThreads: boolean;
  }): Promise<readonly UnreadParticipantSnapshot[]> {
    const threadRows = await this.db.query.threads.findMany({
      where: input.includeClosedThreads
        ? (table) => eq(table.workspaceId, input.workspaceId)
        : (table) =>
            and(
              eq(table.workspaceId, input.workspaceId),
              ne(table.status, "closed" satisfies ThreadStatus)
            ),
      columns: {
        threadId: true,
        workspaceId: true,
        status: true
      }
    });
    if (threadRows.length === 0) {
      return [];
    }

    const threadIds = threadRows.map((row) => row.threadId);
    const threadById = new Map(threadRows.map((row) => [row.threadId, row]));

    const participants = await this.db.query.threadParticipants.findMany({
      where: (table) => inArray(table.threadId, threadIds),
      columns: {
        threadId: true,
        agentId: true
      }
    });
    if (participants.length === 0) {
      return [];
    }

    const latestSeqEntries = await Promise.all(
      threadIds.map(async (threadId) => {
        const latest = await this.db.query.messages.findFirst({
          where: (table) => eq(table.threadId, threadId),
          orderBy: (table, operators) => [operators.desc(table.seq)],
          columns: {
            seq: true
          }
        });
        return [threadId, latest?.seq ?? 0] as const;
      })
    );
    const latestSeqByThread = new Map(latestSeqEntries);

    const cursorRows = await this.db.query.participantCursors.findMany({
      where: (table) => inArray(table.threadId, threadIds),
      columns: {
        threadId: true,
        agentId: true,
        lastReadSeq: true
      }
    });
    const cursorByKey = new Map(
      cursorRows.map((row) => [reconciliationStateKey(row.threadId, row.agentId), row.lastReadSeq])
    );

    const participantIds = [...new Set(participants.map((participant) => participant.agentId))];
    const sessions =
      participantIds.length === 0
        ? []
        : await this.db.query.sessionRegistry.findMany({
            where: (table) =>
              and(eq(table.workspaceId, input.workspaceId), inArray(table.agentId, participantIds)),
            columns: {
              agentId: true,
              sessionId: true,
              managementMode: true,
              resumable: true,
              status: true,
              lastHeartbeatAt: true
            }
          });
    const sessionByAgent = new Map(sessions.map((row) => [row.agentId, row]));

    const snapshots: UnreadParticipantSnapshot[] = [];
    for (const participant of participants) {
      const thread = threadById.get(participant.threadId);
      if (!thread) {
        continue;
      }

      const session = sessionByAgent.get(participant.agentId);
      snapshots.push({
        threadId: participant.threadId,
        workspaceId: thread.workspaceId,
        threadStatus: thread.status,
        participantAgentId: participant.agentId,
        latestSeq: latestSeqByThread.get(participant.threadId) ?? 0,
        lastReadSeq:
          cursorByKey.get(reconciliationStateKey(participant.threadId, participant.agentId)) ?? 0,
        session:
          session === undefined
            ? null
            : {
                sessionId: session.sessionId,
                managementMode: session.managementMode,
                resumable: session.resumable,
                status: session.status,
                lastHeartbeatAt: session.lastHeartbeatAt
              }
      });
    }

    return snapshots;
  }
}
