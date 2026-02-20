import {
  DomainError,
  requireDate,
  requireNonEmptyString,
  requireNonNegativeInteger
} from "./errors.js";

export interface ParticipantCursor {
  threadId: string;
  agentId: string;
  lastReadSeq: number;
  lastAckedMessageId: string | null;
  updatedAt: Date;
}

export interface CreateParticipantCursorInput {
  threadId: string;
  agentId: string;
  createdAt?: Date;
}

export interface AcknowledgeReadInput {
  lastReadSeq: number;
  lastAckedMessageId?: string | null;
  updatedAt?: Date;
}

const normalizeAckedMessageId = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined || value === null) {
    return value;
  }

  return requireNonEmptyString(value, "lastAckedMessageId");
};

export const createParticipantCursor = (
  input: CreateParticipantCursorInput
): ParticipantCursor => ({
  threadId: requireNonEmptyString(input.threadId, "threadId"),
  agentId: requireNonEmptyString(input.agentId, "agentId"),
  lastReadSeq: 0,
  lastAckedMessageId: null,
  updatedAt: requireDate(input.createdAt ?? new Date(), "createdAt")
});

export const acknowledgeRead = (
  cursor: ParticipantCursor,
  input: AcknowledgeReadInput
): ParticipantCursor => {
  const nextReadSeq = requireNonNegativeInteger(input.lastReadSeq, "lastReadSeq");
  if (nextReadSeq < cursor.lastReadSeq) {
    throw new DomainError(
      "CURSOR_REGRESSION",
      `Cursor regression is not allowed: ${nextReadSeq} < ${cursor.lastReadSeq}`,
      {
        threadId: cursor.threadId,
        agentId: cursor.agentId,
        currentLastReadSeq: cursor.lastReadSeq,
        nextLastReadSeq: nextReadSeq
      }
    );
  }

  const nextAckedMessageId = normalizeAckedMessageId(input.lastAckedMessageId);
  if (nextReadSeq === cursor.lastReadSeq && nextAckedMessageId === undefined) {
    return cursor;
  }

  return {
    ...cursor,
    lastReadSeq: nextReadSeq,
    lastAckedMessageId:
      nextAckedMessageId === undefined ? cursor.lastAckedMessageId : nextAckedMessageId,
    updatedAt: requireDate(input.updatedAt ?? new Date(), "updatedAt")
  };
};

export const calculateUnreadCount = (latestSeq: number, lastReadSeq: number): number => {
  const safeLatestSeq = requireNonNegativeInteger(latestSeq, "latestSeq");
  const safeLastReadSeq = requireNonNegativeInteger(lastReadSeq, "lastReadSeq");
  if (safeLatestSeq < safeLastReadSeq) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      `"latestSeq" must be greater than or equal to "lastReadSeq"`,
      {
        latestSeq: safeLatestSeq,
        lastReadSeq: safeLastReadSeq
      }
    );
  }

  return safeLatestSeq - safeLastReadSeq;
};
