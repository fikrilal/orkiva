import {
  DomainError,
  requireDate,
  requireNonEmptyString,
  requirePositiveInteger
} from "./errors.js";

export type MessageKind = "chat" | "event" | "system";

export interface Message {
  messageId: string;
  threadId: string;
  schemaVersion: number;
  seq: number;
  senderAgentId: string;
  senderSessionId: string;
  kind: MessageKind;
  body: string;
  metadata?: Record<string, unknown>;
  inReplyTo?: string;
  idempotencyKey?: string;
  createdAt: Date;
}

export interface CreateMessageInput {
  messageId: string;
  threadId: string;
  schemaVersion: number;
  seq: number;
  senderAgentId: string;
  senderSessionId: string;
  kind: MessageKind;
  body: string;
  metadata?: Record<string, unknown>;
  inReplyTo?: string;
  idempotencyKey?: string;
  createdAt?: Date;
}

const supportedMessageKinds: ReadonlySet<MessageKind> = new Set(["chat", "event", "system"]);

const requireMessageKind = (value: MessageKind): MessageKind => {
  if (!supportedMessageKinds.has(value)) {
    throw new DomainError("INVALID_ARGUMENT", `"kind" must be a supported message kind`, {
      value
    });
  }

  return value;
};

const normalizeMetadata = (
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined => {
  if (metadata === undefined) {
    return undefined;
  }

  if (Array.isArray(metadata)) {
    throw new DomainError("INVALID_ARGUMENT", `"metadata" must be an object`, {
      metadata
    });
  }

  return { ...metadata };
};

export const assertNextMessageSequence = (lastSeq: number, nextSeq: number): void => {
  const safeLastSeq = requirePositiveInteger(lastSeq + 1, "lastSeq+1") - 1;
  const safeNextSeq = requirePositiveInteger(nextSeq, "nextSeq");
  if (safeNextSeq !== safeLastSeq + 1) {
    throw new DomainError("SEQUENCE_VIOLATION", "Message sequence must increment by exactly one", {
      lastSeq: safeLastSeq,
      nextSeq: safeNextSeq
    });
  }
};

export const getNextMessageSequence = (lastSeq: number): number => {
  const safeLastSeq = requirePositiveInteger(lastSeq + 1, "lastSeq+1") - 1;
  if (safeLastSeq >= Number.MAX_SAFE_INTEGER) {
    throw new DomainError(
      "SEQUENCE_OVERFLOW",
      "Message sequence exceeded Number.MAX_SAFE_INTEGER",
      {
        lastSeq: safeLastSeq
      }
    );
  }

  return safeLastSeq + 1;
};

export const createMessage = (input: CreateMessageInput): Message => {
  const schemaVersion = requirePositiveInteger(input.schemaVersion, "schemaVersion");
  const seq = requirePositiveInteger(input.seq, "seq");
  const metadata = normalizeMetadata(input.metadata);
  const inReplyTo =
    input.inReplyTo === undefined ? undefined : requireNonEmptyString(input.inReplyTo, "inReplyTo");
  const idempotencyKey =
    input.idempotencyKey === undefined
      ? undefined
      : requireNonEmptyString(input.idempotencyKey, "idempotencyKey");

  return {
    messageId: requireNonEmptyString(input.messageId, "messageId"),
    threadId: requireNonEmptyString(input.threadId, "threadId"),
    schemaVersion,
    seq,
    senderAgentId: requireNonEmptyString(input.senderAgentId, "senderAgentId"),
    senderSessionId: requireNonEmptyString(input.senderSessionId, "senderSessionId"),
    kind: requireMessageKind(input.kind),
    body: requireNonEmptyString(input.body, "body"),
    ...(metadata === undefined ? {} : { metadata }),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    createdAt: requireDate(input.createdAt ?? new Date(), "createdAt")
  };
};
