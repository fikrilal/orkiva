import {
  DomainError,
  requireDate,
  requireNonEmptyString,
  requirePositiveInteger
} from "./errors.js";

export type ManagementMode = "managed" | "unmanaged";
export type SessionStatus = "active" | "idle" | "offline";

export interface SessionRecord {
  agentId: string;
  workspaceId: string;
  sessionId: string;
  runtime: string;
  managementMode: ManagementMode;
  resumable: boolean;
  status: SessionStatus;
  lastHeartbeatAt: Date;
  updatedAt: Date;
}

export interface SessionHeartbeatInput {
  agentId: string;
  workspaceId: string;
  sessionId: string;
  runtime: string;
  managementMode: ManagementMode;
  resumable: boolean;
  status: SessionStatus;
  heartbeatAt?: Date;
}

export interface SessionLookupInput {
  agentId: string;
  workspaceId: string;
  staleAfterHours: number;
  referenceTime?: Date;
}

const managementModes: ReadonlySet<ManagementMode> = new Set(["managed", "unmanaged"]);
const sessionStatuses: ReadonlySet<SessionStatus> = new Set(["active", "idle", "offline"]);

const requireManagementMode = (value: ManagementMode): ManagementMode => {
  if (!managementModes.has(value)) {
    throw new DomainError("INVALID_ARGUMENT", `"managementMode" must be a supported mode`, {
      value
    });
  }

  return value;
};

const requireSessionStatus = (value: SessionStatus): SessionStatus => {
  if (!sessionStatuses.has(value)) {
    throw new DomainError("INVALID_ARGUMENT", `"status" must be a supported session status`, {
      value
    });
  }

  return value;
};

export const createSessionFromHeartbeat = (input: SessionHeartbeatInput): SessionRecord => {
  const heartbeatAt = requireDate(input.heartbeatAt ?? new Date(), "heartbeatAt");
  return {
    agentId: requireNonEmptyString(input.agentId, "agentId"),
    workspaceId: requireNonEmptyString(input.workspaceId, "workspaceId"),
    sessionId: requireNonEmptyString(input.sessionId, "sessionId"),
    runtime: requireNonEmptyString(input.runtime, "runtime"),
    managementMode: requireManagementMode(input.managementMode),
    resumable: input.resumable,
    status: requireSessionStatus(input.status),
    lastHeartbeatAt: heartbeatAt,
    updatedAt: heartbeatAt
  };
};

export const applySessionHeartbeat = (
  existingRecord: SessionRecord | null | undefined,
  heartbeat: SessionHeartbeatInput
): SessionRecord => {
  if (!existingRecord) {
    return createSessionFromHeartbeat(heartbeat);
  }

  const heartbeatAt = requireDate(heartbeat.heartbeatAt ?? new Date(), "heartbeatAt");
  if (
    existingRecord.agentId !== heartbeat.agentId ||
    existingRecord.workspaceId !== heartbeat.workspaceId
  ) {
    throw new DomainError(
      "SESSION_SCOPE_MISMATCH",
      "Session heartbeat scope must match existing record scope",
      {
        existingAgentId: existingRecord.agentId,
        existingWorkspaceId: existingRecord.workspaceId,
        incomingAgentId: heartbeat.agentId,
        incomingWorkspaceId: heartbeat.workspaceId
      }
    );
  }

  if (heartbeatAt.getTime() <= existingRecord.lastHeartbeatAt.getTime()) {
    return existingRecord;
  }

  return {
    ...existingRecord,
    sessionId: requireNonEmptyString(heartbeat.sessionId, "sessionId"),
    runtime: requireNonEmptyString(heartbeat.runtime, "runtime"),
    managementMode: requireManagementMode(heartbeat.managementMode),
    resumable: heartbeat.resumable,
    status: requireSessionStatus(heartbeat.status),
    lastHeartbeatAt: heartbeatAt,
    updatedAt: heartbeatAt
  };
};

export const isSessionStale = (
  session: SessionRecord,
  staleAfterHours: number,
  referenceTime: Date = new Date()
): boolean => {
  const safeStaleAfterHours = requirePositiveInteger(staleAfterHours, "staleAfterHours");
  const safeReferenceTime = requireDate(referenceTime, "referenceTime");
  const staleAfterMs = safeStaleAfterHours * 60 * 60 * 1000;

  return safeReferenceTime.getTime() - session.lastHeartbeatAt.getTime() > staleAfterMs;
};

export const findLatestResumableSession = (
  sessions: readonly SessionRecord[],
  lookup: SessionLookupInput
): SessionRecord | null => {
  const targetAgentId = requireNonEmptyString(lookup.agentId, "agentId");
  const targetWorkspaceId = requireNonEmptyString(lookup.workspaceId, "workspaceId");
  const safeReferenceTime = requireDate(lookup.referenceTime ?? new Date(), "referenceTime");

  const candidates = sessions
    .filter(
      (session) =>
        session.agentId === targetAgentId &&
        session.workspaceId === targetWorkspaceId &&
        session.resumable
    )
    .sort((left, right) => right.lastHeartbeatAt.getTime() - left.lastHeartbeatAt.getTime());

  for (const candidate of candidates) {
    if (!isSessionStale(candidate, lookup.staleAfterHours, safeReferenceTime)) {
      return candidate;
    }
  }

  return null;
};
