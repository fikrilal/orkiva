import type { DbClient } from "@orkiva/db";
import { messages, participantCursors, threadParticipants, threads } from "@orkiva/db";
import { and, asc, eq, gt } from "drizzle-orm";
import {
  DomainError,
  createMessage as createDomainMessage,
  createThread as createDomainThread,
  getNextMessageSequence,
  type MessageKind,
  transitionThreadStatus,
  type ThreadStatus,
  type ThreadType
} from "@orkiva/domain";
import { normalizeMetadataForMessageKind } from "@orkiva/protocol";

export interface ThreadRecord {
  threadId: string;
  workspaceId: string;
  title: string;
  type: ThreadType;
  status: ThreadStatus;
  participants: readonly string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ThreadSummary {
  summary: string;
  openItems: readonly string[];
  lastStatus: ThreadStatus;
}

export interface MessageRecord {
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

export interface ParticipantCursorRecord {
  threadId: string;
  agentId: string;
  lastReadSeq: number;
  lastAckedMessageId: string | null;
  updatedAt: Date;
}

export interface ReadMessagesResult {
  messages: readonly MessageRecord[];
  nextSeq: number;
  hasMore: boolean;
}

export interface CreateThreadRecordInput {
  threadId: string;
  workspaceId: string;
  title: string;
  type: ThreadType;
  participants: readonly string[];
  createdAt: Date;
}

export interface CreateMessageRecordInput {
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

export interface ThreadStore {
  createThread(input: CreateThreadRecordInput): Promise<ThreadRecord>;
  getThreadById(threadId: string): Promise<ThreadRecord | null>;
  updateThreadStatus(
    threadId: string,
    nextStatus: ThreadStatus,
    updatedAt: Date,
    options?: {
      expectedCurrentStatus?: ThreadStatus;
    }
  ): Promise<ThreadRecord | null>;
  summarizeThread(threadId: string, maxMessages: number): Promise<ThreadSummary | null>;
  createMessage(input: CreateMessageRecordInput): Promise<MessageRecord>;
  getLatestMessageSeq(threadId: string): Promise<number>;
  readMessages(threadId: string, sinceSeq: number, limit: number): Promise<ReadMessagesResult>;
  getMessageById(threadId: string, messageId: string): Promise<MessageRecord | null>;
  getMessageByIdempotency(
    threadId: string,
    senderAgentId: string,
    idempotencyKey: string
  ): Promise<MessageRecord | null>;
  getParticipantCursor(threadId: string, agentId: string): Promise<ParticipantCursorRecord | null>;
  upsertParticipantCursor(cursor: ParticipantCursorRecord): Promise<ParticipantCursorRecord>;
}

const buildThreadSummaryText = (
  status: ThreadStatus,
  messageCount: number,
  maxMessages: number
): string => {
  if (messageCount === 0) {
    return `No messages yet. Thread is currently ${status}.`;
  }

  return `Reviewed ${messageCount} most recent message(s) (max=${maxMessages}). Thread is currently ${status}.`;
};

const cursorKey = (threadId: string, agentId: string): string => `${threadId}::${agentId}`;

const toMessageRecord = (row: {
  messageId: string;
  threadId: string;
  schemaVersion: number;
  seq: number;
  senderAgentId: string;
  senderSessionId: string;
  kind: MessageKind;
  body: string;
  metadata: unknown;
  inReplyTo: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
}): MessageRecord => {
  const metadata = normalizeMetadataForMessageKind(row.kind, row.metadata);

  return {
    messageId: row.messageId,
    threadId: row.threadId,
    schemaVersion: row.schemaVersion,
    seq: row.seq,
    senderAgentId: row.senderAgentId,
    senderSessionId: row.senderSessionId,
    kind: row.kind,
    body: row.body,
    ...(metadata === undefined ? {} : { metadata }),
    ...(row.inReplyTo === null ? {} : { inReplyTo: row.inReplyTo }),
    ...(row.idempotencyKey === null ? {} : { idempotencyKey: row.idempotencyKey }),
    createdAt: row.createdAt
  };
};

export class InMemoryThreadStore implements ThreadStore {
  private readonly threadRecords = new Map<string, ThreadRecord>();
  private readonly messageRecords = new Map<string, MessageRecord[]>();
  private readonly cursorRecords = new Map<string, ParticipantCursorRecord>();

  public createThread(input: CreateThreadRecordInput): Promise<ThreadRecord> {
    const thread = createDomainThread({
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      title: input.title,
      type: input.type,
      participants: input.participants,
      createdAt: input.createdAt
    });

    const record: ThreadRecord = {
      threadId: thread.threadId,
      workspaceId: thread.workspaceId,
      title: thread.title,
      type: thread.type,
      status: thread.status,
      participants: thread.participants,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt
    };

    this.threadRecords.set(record.threadId, record);
    this.messageRecords.set(record.threadId, []);

    return Promise.resolve(record);
  }

  public getThreadById(threadId: string): Promise<ThreadRecord | null> {
    return Promise.resolve(this.threadRecords.get(threadId) ?? null);
  }

  public updateThreadStatus(
    threadId: string,
    nextStatus: ThreadStatus,
    updatedAt: Date,
    options?: {
      expectedCurrentStatus?: ThreadStatus;
    }
  ): Promise<ThreadRecord | null> {
    const existing = this.threadRecords.get(threadId);
    if (!existing) {
      return Promise.resolve(null);
    }
    if (
      options?.expectedCurrentStatus !== undefined &&
      existing.status !== options.expectedCurrentStatus
    ) {
      return Promise.resolve(null);
    }

    const updated = transitionThreadStatus(existing, nextStatus, updatedAt);
    this.threadRecords.set(threadId, updated);
    return Promise.resolve(updated);
  }

  public summarizeThread(threadId: string, maxMessages: number): Promise<ThreadSummary | null> {
    const existing = this.threadRecords.get(threadId);
    if (!existing) {
      return Promise.resolve(null);
    }

    const messageCount = this.messageRecords.get(threadId)?.length ?? 0;
    return Promise.resolve({
      summary: buildThreadSummaryText(existing.status, messageCount, maxMessages),
      openItems: [],
      lastStatus: existing.status
    });
  }

  public createMessage(input: CreateMessageRecordInput): Promise<MessageRecord> {
    const messagesForThread = this.messageRecords.get(input.threadId) ?? [];
    const lastSeq = messagesForThread.at(-1)?.seq ?? 0;
    const expectedNextSeq = getNextMessageSequence(lastSeq);
    if (input.seq !== expectedNextSeq) {
      throw new DomainError(
        "SEQUENCE_VIOLATION",
        "Message sequence must increment by exactly one",
        {
          threadId: input.threadId,
          lastSeq,
          nextSeq: input.seq
        }
      );
    }

    const message = createDomainMessage({
      messageId: input.messageId,
      threadId: input.threadId,
      schemaVersion: input.schemaVersion,
      seq: input.seq,
      senderAgentId: input.senderAgentId,
      senderSessionId: input.senderSessionId,
      kind: input.kind,
      body: input.body,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      createdAt: input.createdAt
    });

    const normalizedMetadata = normalizeMetadataForMessageKind(message.kind, message.metadata);
    const record: MessageRecord = {
      messageId: message.messageId,
      threadId: message.threadId,
      schemaVersion: message.schemaVersion,
      seq: message.seq,
      senderAgentId: message.senderAgentId,
      senderSessionId: message.senderSessionId,
      kind: message.kind,
      body: message.body,
      ...(normalizedMetadata === undefined ? {} : { metadata: normalizedMetadata }),
      ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
      ...(message.idempotencyKey === undefined ? {} : { idempotencyKey: message.idempotencyKey }),
      createdAt: message.createdAt
    };

    this.messageRecords.set(input.threadId, [...messagesForThread, record]);
    return Promise.resolve(record);
  }

  public getLatestMessageSeq(threadId: string): Promise<number> {
    const latestSeq = this.messageRecords.get(threadId)?.at(-1)?.seq ?? 0;
    return Promise.resolve(latestSeq);
  }

  public readMessages(
    threadId: string,
    sinceSeq: number,
    limit: number
  ): Promise<ReadMessagesResult> {
    const filtered = (this.messageRecords.get(threadId) ?? []).filter(
      (message) => message.seq > sinceSeq
    );
    const page = filtered.slice(0, limit);
    const nextSeq = page.at(-1)?.seq ?? sinceSeq;

    return Promise.resolve({
      messages: page,
      nextSeq,
      hasMore: filtered.length > limit
    });
  }

  public getMessageById(threadId: string, messageId: string): Promise<MessageRecord | null> {
    const existing =
      this.messageRecords.get(threadId)?.find((message) => message.messageId === messageId) ?? null;

    return Promise.resolve(existing);
  }

  public getMessageByIdempotency(
    threadId: string,
    senderAgentId: string,
    idempotencyKey: string
  ): Promise<MessageRecord | null> {
    const existing =
      this.messageRecords
        .get(threadId)
        ?.find(
          (message) =>
            message.senderAgentId === senderAgentId && message.idempotencyKey === idempotencyKey
        ) ?? null;

    return Promise.resolve(existing);
  }

  public getParticipantCursor(
    threadId: string,
    agentId: string
  ): Promise<ParticipantCursorRecord | null> {
    return Promise.resolve(this.cursorRecords.get(cursorKey(threadId, agentId)) ?? null);
  }

  public upsertParticipantCursor(
    cursor: ParticipantCursorRecord
  ): Promise<ParticipantCursorRecord> {
    const key = cursorKey(cursor.threadId, cursor.agentId);
    this.cursorRecords.set(key, cursor);
    return Promise.resolve(cursor);
  }
}

const toThreadRecord = (
  row: {
    threadId: string;
    workspaceId: string;
    title: string;
    type: ThreadType;
    status: ThreadStatus;
    createdAt: Date;
    updatedAt: Date;
  },
  participants: readonly string[]
): ThreadRecord => ({
  threadId: row.threadId,
  workspaceId: row.workspaceId,
  title: row.title,
  type: row.type,
  status: row.status,
  participants,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

export class DbThreadStore implements ThreadStore {
  public constructor(private readonly db: DbClient) {}

  public async createThread(input: CreateThreadRecordInput): Promise<ThreadRecord> {
    const thread = createDomainThread({
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      title: input.title,
      type: input.type,
      participants: input.participants,
      createdAt: input.createdAt
    });

    await this.db.transaction(async (tx) => {
      await tx.insert(threads).values({
        threadId: thread.threadId,
        workspaceId: thread.workspaceId,
        title: thread.title,
        type: thread.type,
        status: thread.status,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt
      });

      await tx.insert(threadParticipants).values(
        thread.participants.map((agentId) => ({
          threadId: thread.threadId,
          agentId,
          joinedAt: thread.createdAt
        }))
      );
    });

    return {
      threadId: thread.threadId,
      workspaceId: thread.workspaceId,
      title: thread.title,
      type: thread.type,
      status: thread.status,
      participants: thread.participants,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt
    };
  }

  public async getThreadById(threadId: string): Promise<ThreadRecord | null> {
    const row = await this.db.query.threads.findFirst({
      where: (table, operators) => operators.eq(table.threadId, threadId)
    });
    if (!row) {
      return null;
    }

    const participantRows = await this.db.query.threadParticipants.findMany({
      where: (table, operators) => operators.eq(table.threadId, threadId)
    });

    return toThreadRecord(
      {
        threadId: row.threadId,
        workspaceId: row.workspaceId,
        title: row.title,
        type: row.type,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      },
      participantRows.map((participant) => participant.agentId)
    );
  }

  public async updateThreadStatus(
    threadId: string,
    nextStatus: ThreadStatus,
    updatedAt: Date,
    options?: {
      expectedCurrentStatus?: ThreadStatus;
    }
  ): Promise<ThreadRecord | null> {
    const current = await this.getThreadById(threadId);
    if (!current) {
      return null;
    }

    const updated = transitionThreadStatus(current, nextStatus, updatedAt);
    const whereClause =
      options?.expectedCurrentStatus === undefined
        ? eq(threads.threadId, updated.threadId)
        : and(
            eq(threads.threadId, updated.threadId),
            eq(threads.status, options.expectedCurrentStatus)
          );
    const affected = await this.db
      .update(threads)
      .set({
        status: updated.status,
        updatedAt: updated.updatedAt
      })
      .where(whereClause)
      .returning({
        threadId: threads.threadId
      });
    if (affected.length === 0) {
      return null;
    }

    return updated;
  }

  public async summarizeThread(
    threadId: string,
    maxMessages: number
  ): Promise<ThreadSummary | null> {
    const current = await this.getThreadById(threadId);
    if (!current) {
      return null;
    }

    const recentMessages = await this.db.query.messages.findMany({
      where: (table, operators) => operators.eq(table.threadId, threadId),
      orderBy: (table, operators) => [operators.desc(table.seq)],
      limit: maxMessages
    });

    return {
      summary: buildThreadSummaryText(current.status, recentMessages.length, maxMessages),
      openItems: [],
      lastStatus: current.status
    };
  }

  public async createMessage(input: CreateMessageRecordInput): Promise<MessageRecord> {
    const message = createDomainMessage({
      messageId: input.messageId,
      threadId: input.threadId,
      schemaVersion: input.schemaVersion,
      seq: input.seq,
      senderAgentId: input.senderAgentId,
      senderSessionId: input.senderSessionId,
      kind: input.kind,
      body: input.body,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      createdAt: input.createdAt
    });
    const normalizedMetadata = normalizeMetadataForMessageKind(message.kind, message.metadata);

    await this.db.insert(messages).values({
      messageId: message.messageId,
      threadId: message.threadId,
      schemaVersion: message.schemaVersion,
      seq: message.seq,
      senderAgentId: message.senderAgentId,
      senderSessionId: message.senderSessionId,
      kind: message.kind,
      body: message.body,
      ...(normalizedMetadata === undefined ? {} : { metadata: normalizedMetadata }),
      ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
      ...(message.idempotencyKey === undefined ? {} : { idempotencyKey: message.idempotencyKey }),
      createdAt: message.createdAt
    });

    return {
      messageId: message.messageId,
      threadId: message.threadId,
      schemaVersion: message.schemaVersion,
      seq: message.seq,
      senderAgentId: message.senderAgentId,
      senderSessionId: message.senderSessionId,
      kind: message.kind,
      body: message.body,
      ...(normalizedMetadata === undefined ? {} : { metadata: normalizedMetadata }),
      ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
      ...(message.idempotencyKey === undefined ? {} : { idempotencyKey: message.idempotencyKey }),
      createdAt: message.createdAt
    };
  }

  public async getLatestMessageSeq(threadId: string): Promise<number> {
    const latest = await this.db.query.messages.findFirst({
      where: (table, operators) => operators.eq(table.threadId, threadId),
      orderBy: (table, operators) => [operators.desc(table.seq)]
    });

    return latest?.seq ?? 0;
  }

  public async readMessages(
    threadId: string,
    sinceSeq: number,
    limit: number
  ): Promise<ReadMessagesResult> {
    const rows = await this.db.query.messages.findMany({
      where: (table) => and(eq(table.threadId, threadId), gt(table.seq, sinceSeq)),
      orderBy: (table) => [asc(table.seq)],
      limit: limit + 1
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const records = pageRows.map((row) =>
      toMessageRecord({
        messageId: row.messageId,
        threadId: row.threadId,
        schemaVersion: row.schemaVersion,
        seq: row.seq,
        senderAgentId: row.senderAgentId,
        senderSessionId: row.senderSessionId,
        kind: row.kind,
        body: row.body,
        metadata: row.metadata,
        inReplyTo: row.inReplyTo,
        idempotencyKey: row.idempotencyKey,
        createdAt: row.createdAt
      })
    );
    const nextSeq = records.at(-1)?.seq ?? sinceSeq;

    return {
      messages: records,
      nextSeq,
      hasMore
    };
  }

  public async getMessageById(threadId: string, messageId: string): Promise<MessageRecord | null> {
    const row = await this.db.query.messages.findFirst({
      where: (table) => and(eq(table.threadId, threadId), eq(table.messageId, messageId))
    });
    if (!row) {
      return null;
    }

    return toMessageRecord({
      messageId: row.messageId,
      threadId: row.threadId,
      schemaVersion: row.schemaVersion,
      seq: row.seq,
      senderAgentId: row.senderAgentId,
      senderSessionId: row.senderSessionId,
      kind: row.kind,
      body: row.body,
      metadata: row.metadata,
      inReplyTo: row.inReplyTo,
      idempotencyKey: row.idempotencyKey,
      createdAt: row.createdAt
    });
  }

  public async getMessageByIdempotency(
    threadId: string,
    senderAgentId: string,
    idempotencyKey: string
  ): Promise<MessageRecord | null> {
    const row = await this.db.query.messages.findFirst({
      where: (table) =>
        and(
          eq(table.threadId, threadId),
          eq(table.senderAgentId, senderAgentId),
          eq(table.idempotencyKey, idempotencyKey)
        )
    });
    if (!row) {
      return null;
    }

    return toMessageRecord({
      messageId: row.messageId,
      threadId: row.threadId,
      schemaVersion: row.schemaVersion,
      seq: row.seq,
      senderAgentId: row.senderAgentId,
      senderSessionId: row.senderSessionId,
      kind: row.kind,
      body: row.body,
      metadata: row.metadata,
      inReplyTo: row.inReplyTo,
      idempotencyKey: row.idempotencyKey,
      createdAt: row.createdAt
    });
  }

  public async getParticipantCursor(
    threadId: string,
    agentId: string
  ): Promise<ParticipantCursorRecord | null> {
    const row = await this.db.query.participantCursors.findFirst({
      where: (table) => and(eq(table.threadId, threadId), eq(table.agentId, agentId))
    });
    if (!row) {
      return null;
    }

    return {
      threadId: row.threadId,
      agentId: row.agentId,
      lastReadSeq: row.lastReadSeq,
      lastAckedMessageId: row.lastAckedMessageId,
      updatedAt: row.updatedAt
    };
  }

  public async upsertParticipantCursor(
    cursor: ParticipantCursorRecord
  ): Promise<ParticipantCursorRecord> {
    await this.db
      .insert(participantCursors)
      .values({
        threadId: cursor.threadId,
        agentId: cursor.agentId,
        lastReadSeq: cursor.lastReadSeq,
        lastAckedMessageId: cursor.lastAckedMessageId,
        updatedAt: cursor.updatedAt
      })
      .onConflictDoUpdate({
        target: [participantCursors.threadId, participantCursors.agentId],
        set: {
          lastReadSeq: cursor.lastReadSeq,
          lastAckedMessageId: cursor.lastAckedMessageId,
          updatedAt: cursor.updatedAt
        }
      });

    return cursor;
  }
}
