import { DomainError, requireDate, requireNonEmptyString } from "./errors.js";

export type ThreadType = "conversation" | "workflow" | "incident";
export type ThreadStatus = "active" | "blocked" | "resolved" | "closed";

export interface Thread {
  threadId: string;
  workspaceId: string;
  title: string;
  type: ThreadType;
  status: ThreadStatus;
  participants: readonly string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateThreadInput {
  threadId: string;
  workspaceId: string;
  title: string;
  type: ThreadType;
  participants: readonly string[];
  createdAt?: Date;
  status?: ThreadStatus;
}

const allowedThreadTypes: ReadonlySet<ThreadType> = new Set([
  "conversation",
  "workflow",
  "incident"
]);
const allowedThreadStatuses: ReadonlySet<ThreadStatus> = new Set([
  "active",
  "blocked",
  "resolved",
  "closed"
]);

const transitionMap: Readonly<Record<ThreadStatus, ReadonlySet<ThreadStatus>>> = {
  active: new Set(["blocked", "resolved", "closed"]),
  blocked: new Set(["active", "closed"]),
  resolved: new Set(["closed"]),
  closed: new Set([])
};

const requireThreadType = (value: ThreadType): ThreadType => {
  if (!allowedThreadTypes.has(value)) {
    throw new DomainError("INVALID_ARGUMENT", `"type" must be a supported thread type`, {
      value
    });
  }

  return value;
};

const requireThreadStatus = (value: ThreadStatus): ThreadStatus => {
  if (!allowedThreadStatuses.has(value)) {
    throw new DomainError("INVALID_ARGUMENT", `"status" must be a supported thread status`, {
      value
    });
  }

  return value;
};

const normalizeParticipants = (participants: readonly string[]): readonly string[] => {
  if (participants.length === 0) {
    throw new DomainError("INVALID_ARGUMENT", `"participants" must include at least one agent`, {
      participants
    });
  }

  const normalized = participants.map((participant) =>
    requireNonEmptyString(participant, "participants[]")
  );
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) {
    throw new DomainError("INVALID_ARGUMENT", `"participants" must be unique`, {
      participants
    });
  }

  return normalized;
};

export const createThread = (input: CreateThreadInput): Thread => {
  const createdAt = requireDate(input.createdAt ?? new Date(), "createdAt");
  const status = requireThreadStatus(input.status ?? "active");

  return {
    threadId: requireNonEmptyString(input.threadId, "threadId"),
    workspaceId: requireNonEmptyString(input.workspaceId, "workspaceId"),
    title: requireNonEmptyString(input.title, "title"),
    type: requireThreadType(input.type),
    status,
    participants: normalizeParticipants(input.participants),
    createdAt,
    updatedAt: createdAt
  };
};

export const canTransitionThreadStatus = (
  fromStatus: ThreadStatus,
  toStatus: ThreadStatus
): boolean => {
  const from = requireThreadStatus(fromStatus);
  const to = requireThreadStatus(toStatus);

  if (from === to) {
    return true;
  }

  return transitionMap[from].has(to);
};

export const transitionThreadStatus = (
  thread: Thread,
  nextStatus: ThreadStatus,
  updatedAt: Date = new Date()
): Thread => {
  const toStatus = requireThreadStatus(nextStatus);
  if (thread.status === toStatus) {
    return thread;
  }

  if (!canTransitionThreadStatus(thread.status, toStatus)) {
    throw new DomainError(
      "INVALID_THREAD_TRANSITION",
      `Invalid thread status transition: ${thread.status} -> ${toStatus}`,
      {
        threadId: thread.threadId,
        fromStatus: thread.status,
        toStatus
      }
    );
  }

  return {
    ...thread,
    status: toStatus,
    updatedAt: requireDate(updatedAt, "updatedAt")
  };
};

export const isThreadParticipant = (thread: Thread, agentId: string): boolean =>
  thread.participants.includes(requireNonEmptyString(agentId, "agentId"));
