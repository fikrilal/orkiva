import type { DbClient } from "@orkiva/db";
import { threadParticipants, threads } from "@orkiva/db";
import { eq } from "drizzle-orm";
import {
  createThread as createDomainThread,
  transitionThreadStatus,
  type ThreadStatus,
  type ThreadType
} from "@orkiva/domain";

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

export interface CreateThreadRecordInput {
  threadId: string;
  workspaceId: string;
  title: string;
  type: ThreadType;
  participants: readonly string[];
  createdAt: Date;
}

export interface ThreadStore {
  createThread(input: CreateThreadRecordInput): Promise<ThreadRecord>;
  getThreadById(threadId: string): Promise<ThreadRecord | null>;
  updateThreadStatus(
    threadId: string,
    nextStatus: ThreadStatus,
    updatedAt: Date
  ): Promise<ThreadRecord | null>;
  summarizeThread(threadId: string, maxMessages: number): Promise<ThreadSummary | null>;
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

export class InMemoryThreadStore implements ThreadStore {
  private readonly records = new Map<string, ThreadRecord>();

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

    this.records.set(record.threadId, record);
    return Promise.resolve(record);
  }

  public getThreadById(threadId: string): Promise<ThreadRecord | null> {
    return Promise.resolve(this.records.get(threadId) ?? null);
  }

  public updateThreadStatus(
    threadId: string,
    nextStatus: ThreadStatus,
    updatedAt: Date
  ): Promise<ThreadRecord | null> {
    const existing = this.records.get(threadId);
    if (!existing) {
      return Promise.resolve(null);
    }

    const updated = transitionThreadStatus(existing, nextStatus, updatedAt);
    this.records.set(threadId, updated);
    return Promise.resolve(updated);
  }

  public summarizeThread(threadId: string, maxMessages: number): Promise<ThreadSummary | null> {
    const existing = this.records.get(threadId);
    if (!existing) {
      return Promise.resolve(null);
    }

    return Promise.resolve({
      summary: buildThreadSummaryText(existing.status, 0, maxMessages),
      openItems: [],
      lastStatus: existing.status
    });
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
      where: (table, { eq }) => eq(table.threadId, threadId)
    });
    if (!row) {
      return null;
    }

    const participantRows = await this.db.query.threadParticipants.findMany({
      where: (table, { eq }) => eq(table.threadId, threadId)
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
    updatedAt: Date
  ): Promise<ThreadRecord | null> {
    const current = await this.getThreadById(threadId);
    if (!current) {
      return null;
    }

    const updated = transitionThreadStatus(current, nextStatus, updatedAt);
    await this.db
      .update(threads)
      .set({
        status: updated.status,
        updatedAt: updated.updatedAt
      })
      .where(eq(threads.threadId, updated.threadId));

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
      where: (table, { eq }) => eq(table.threadId, threadId),
      orderBy: (table, { desc }) => [desc(table.seq)],
      limit: maxMessages
    });

    return {
      summary: buildThreadSummaryText(current.status, recentMessages.length, maxMessages),
      openItems: [],
      lastStatus: current.status
    };
  }
}
