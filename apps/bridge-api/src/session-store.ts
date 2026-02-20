import type { DbClient } from "@orkiva/db";
import { sessionRegistry } from "@orkiva/db";
import {
  applySessionHeartbeat,
  createSessionFromHeartbeat,
  isSessionStale,
  type SessionLookupInput,
  type SessionRecord
} from "@orkiva/domain";
import { and, eq, lt } from "drizzle-orm";

export interface SessionHeartbeatRecordInput {
  agentId: string;
  workspaceId: string;
  sessionId: string;
  runtime: string;
  managementMode: SessionRecord["managementMode"];
  resumable: boolean;
  status: SessionRecord["status"];
  heartbeatAt: Date;
}

export interface SessionStore {
  heartbeatSession(input: SessionHeartbeatRecordInput): Promise<SessionRecord>;
  getLatestResumableSession(lookup: SessionLookupInput): Promise<SessionRecord | null>;
  getSession(agentId: string, workspaceId: string): Promise<SessionRecord | null>;
}

export const isSessionRecordStale = (
  session: SessionRecord,
  staleAfterHours: number,
  referenceTime?: Date
): boolean => isSessionStale(session, staleAfterHours, referenceTime);

const toSessionRecord = (row: {
  agentId: string;
  workspaceId: string;
  sessionId: string;
  runtime: string;
  managementMode: SessionRecord["managementMode"];
  resumable: boolean;
  status: SessionRecord["status"];
  lastHeartbeatAt: Date;
  updatedAt: Date;
}): SessionRecord => ({
  agentId: row.agentId,
  workspaceId: row.workspaceId,
  sessionId: row.sessionId,
  runtime: row.runtime,
  managementMode: row.managementMode,
  resumable: row.resumable,
  status: row.status,
  lastHeartbeatAt: row.lastHeartbeatAt,
  updatedAt: row.updatedAt
});

const sessionKey = (agentId: string, workspaceId: string): string => `${agentId}::${workspaceId}`;

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  public heartbeatSession(input: SessionHeartbeatRecordInput): Promise<SessionRecord> {
    const key = sessionKey(input.agentId, input.workspaceId);
    const existing = this.sessions.get(key) ?? null;
    const updated = applySessionHeartbeat(existing, input);
    this.sessions.set(key, updated);

    return Promise.resolve(updated);
  }

  public getLatestResumableSession(lookup: SessionLookupInput): Promise<SessionRecord | null> {
    const key = sessionKey(lookup.agentId, lookup.workspaceId);
    const existing = this.sessions.get(key);
    if (!existing || !existing.resumable) {
      return Promise.resolve(null);
    }

    if (isSessionRecordStale(existing, lookup.staleAfterHours, lookup.referenceTime)) {
      return Promise.resolve(null);
    }

    return Promise.resolve(existing);
  }

  public getSession(agentId: string, workspaceId: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.sessions.get(sessionKey(agentId, workspaceId)) ?? null);
  }
}

export class DbSessionStore implements SessionStore {
  public constructor(private readonly db: DbClient) {}

  private findSession(agentId: string, workspaceId: string) {
    return this.db.query.sessionRegistry.findFirst({
      where: (table) => and(eq(table.agentId, agentId), eq(table.workspaceId, workspaceId))
    });
  }

  public async heartbeatSession(input: SessionHeartbeatRecordInput): Promise<SessionRecord> {
    const normalized = createSessionFromHeartbeat(input);

    const updated = await this.db
      .update(sessionRegistry)
      .set({
        sessionId: normalized.sessionId,
        runtime: normalized.runtime,
        managementMode: normalized.managementMode,
        resumable: normalized.resumable,
        status: normalized.status,
        lastHeartbeatAt: normalized.lastHeartbeatAt,
        updatedAt: normalized.updatedAt
      })
      .where(
        and(
          eq(sessionRegistry.agentId, normalized.agentId),
          eq(sessionRegistry.workspaceId, normalized.workspaceId),
          lt(sessionRegistry.lastHeartbeatAt, normalized.lastHeartbeatAt)
        )
      )
      .returning({
        agentId: sessionRegistry.agentId,
        workspaceId: sessionRegistry.workspaceId,
        sessionId: sessionRegistry.sessionId,
        runtime: sessionRegistry.runtime,
        managementMode: sessionRegistry.managementMode,
        resumable: sessionRegistry.resumable,
        status: sessionRegistry.status,
        lastHeartbeatAt: sessionRegistry.lastHeartbeatAt,
        updatedAt: sessionRegistry.updatedAt
      });
    const firstUpdated = updated[0];
    if (firstUpdated) {
      return toSessionRecord(firstUpdated);
    }

    const existing = await this.findSession(normalized.agentId, normalized.workspaceId);
    if (existing) {
      return toSessionRecord(existing);
    }

    await this.db
      .insert(sessionRegistry)
      .values({
        agentId: normalized.agentId,
        workspaceId: normalized.workspaceId,
        sessionId: normalized.sessionId,
        runtime: normalized.runtime,
        managementMode: normalized.managementMode,
        resumable: normalized.resumable,
        status: normalized.status,
        lastHeartbeatAt: normalized.lastHeartbeatAt,
        updatedAt: normalized.updatedAt
      })
      .onConflictDoNothing();

    const inserted = await this.findSession(normalized.agentId, normalized.workspaceId);
    if (inserted) {
      return toSessionRecord(inserted);
    }

    throw new Error("Failed to persist session heartbeat");
  }

  public async getLatestResumableSession(
    lookup: SessionLookupInput
  ): Promise<SessionRecord | null> {
    const existing = await this.findSession(lookup.agentId, lookup.workspaceId);
    if (!existing) {
      return null;
    }

    const session = toSessionRecord(existing);
    if (!session.resumable) {
      return null;
    }

    if (isSessionRecordStale(session, lookup.staleAfterHours, lookup.referenceTime)) {
      return null;
    }

    return session;
  }

  public async getSession(agentId: string, workspaceId: string): Promise<SessionRecord | null> {
    const existing = await this.findSession(agentId, workspaceId);
    if (!existing) {
      return null;
    }

    return toSessionRecord(existing);
  }
}
