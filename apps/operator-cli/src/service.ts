import { auditEvents, threads, type DbClient } from "@orkiva/db";
import { canTransitionThreadStatus, type ThreadStatus } from "@orkiva/domain";
import { and, desc, eq } from "drizzle-orm";

import type { OperatorCommand } from "./commands.js";

const OVERRIDE_REASON_PREFIXES = ["human_override:", "coordinator_override:"] as const;

export interface ThreadRecord {
  threadId: string;
  workspaceId: string;
  title: string;
  type: "conversation" | "workflow" | "incident";
  status: ThreadStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ThreadMessageRecord {
  messageId: string;
  seq: number;
  senderAgentId: string;
  kind: "chat" | "event" | "system";
  body: string;
  createdAt: Date;
}

export interface TriggerJobSummaryRecord {
  triggerId: string;
  targetAgentId: string;
  status:
    | "queued"
    | "triggering"
    | "deferred"
    | "delivered"
    | "timeout"
    | "failed"
    | "fallback_resume"
    | "fallback_spawn";
  attempts: number;
  maxRetries: number;
  createdAt: Date;
  updatedAt: Date;
}

export class OperatorCliError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_ARGUMENT"
      | "NOT_FOUND"
      | "WORKSPACE_MISMATCH"
      | "INVALID_TRANSITION"
      | "OVERRIDE_REQUIRED"
      | "CONFLICT",
    message: string
  ) {
    super(message);
    this.name = "OperatorCliError";
  }
}

export interface OperatorRepository {
  getThreadById(threadId: string): Promise<ThreadRecord | null>;
  listParticipants(threadId: string): Promise<readonly string[]>;
  listMessages(threadId: string, limit: number): Promise<readonly ThreadMessageRecord[]>;
  listTriggerJobs(threadId: string, limit: number): Promise<readonly TriggerJobSummaryRecord[]>;
  updateThreadStatus(input: {
    threadId: string;
    expectedCurrentStatus: ThreadStatus;
    nextStatus: ThreadStatus;
    updatedAt: Date;
  }): Promise<ThreadRecord | null>;
  appendAuditEvent(input: {
    workspaceId: string;
    actorAgentId: string;
    operation: string;
    resourceType: string;
    resourceId: string;
    threadId: string;
    result: "success" | "rejected";
    payload: Record<string, unknown>;
    createdAt: Date;
  }): Promise<void>;
}

export class DbOperatorRepository implements OperatorRepository {
  public constructor(private readonly db: DbClient) {}

  public async getThreadById(threadId: string): Promise<ThreadRecord | null> {
    const row = await this.db.query.threads.findFirst({
      where: (table) => eq(table.threadId, threadId),
      columns: {
        threadId: true,
        workspaceId: true,
        title: true,
        type: true,
        status: true,
        createdAt: true,
        updatedAt: true
      }
    });
    return row ?? null;
  }

  public async listParticipants(threadId: string): Promise<readonly string[]> {
    const rows = await this.db.query.threadParticipants.findMany({
      where: (table) => eq(table.threadId, threadId),
      columns: {
        agentId: true
      },
      orderBy: (table) => [table.agentId]
    });
    return rows.map((row) => row.agentId);
  }

  public async listMessages(
    threadId: string,
    limit: number
  ): Promise<readonly ThreadMessageRecord[]> {
    const rows = await this.db.query.messages.findMany({
      where: (table) => eq(table.threadId, threadId),
      columns: {
        messageId: true,
        seq: true,
        senderAgentId: true,
        kind: true,
        body: true,
        createdAt: true
      },
      orderBy: (table) => [desc(table.seq)],
      limit
    });
    return [...rows].reverse();
  }

  public async listTriggerJobs(
    threadId: string,
    limit: number
  ): Promise<readonly TriggerJobSummaryRecord[]> {
    const rows = await this.db.query.triggerJobs.findMany({
      where: (table) => eq(table.threadId, threadId),
      columns: {
        triggerId: true,
        targetAgentId: true,
        status: true,
        attempts: true,
        maxRetries: true,
        createdAt: true,
        updatedAt: true
      },
      orderBy: (table) => [desc(table.createdAt)],
      limit
    });
    return rows;
  }

  public async updateThreadStatus(input: {
    threadId: string;
    expectedCurrentStatus: ThreadStatus;
    nextStatus: ThreadStatus;
    updatedAt: Date;
  }): Promise<ThreadRecord | null> {
    const updated = await this.db
      .update(threads)
      .set({
        status: input.nextStatus,
        updatedAt: input.updatedAt
      })
      .where(
        and(eq(threads.threadId, input.threadId), eq(threads.status, input.expectedCurrentStatus))
      )
      .returning({
        threadId: threads.threadId,
        workspaceId: threads.workspaceId,
        title: threads.title,
        type: threads.type,
        status: threads.status,
        createdAt: threads.createdAt,
        updatedAt: threads.updatedAt
      });
    return updated[0] ?? null;
  }

  public async appendAuditEvent(input: {
    workspaceId: string;
    actorAgentId: string;
    operation: string;
    resourceType: string;
    resourceId: string;
    threadId: string;
    result: "success" | "rejected";
    payload: Record<string, unknown>;
    createdAt: Date;
  }): Promise<void> {
    await this.db.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorAgentId: input.actorAgentId,
      actorRole: "operator",
      operation: input.operation,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      threadId: input.threadId,
      result: input.result,
      payload: input.payload,
      createdAt: input.createdAt
    });
  }
}

export interface OperatorCliServiceResult {
  ok: true;
  command: OperatorCommand["kind"];
  happenedAt: string;
  data: Record<string, unknown>;
}

const requiresOverrideReason = (currentStatus: ThreadStatus, nextStatus: ThreadStatus): boolean =>
  currentStatus === "blocked" && nextStatus === "closed";

const hasOverrideReason = (reason: string): boolean =>
  OVERRIDE_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix));

export class OperatorCliService {
  public constructor(
    private readonly repository: OperatorRepository,
    private readonly workspaceId: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  private assertThreadInWorkspace(thread: ThreadRecord): void {
    if (thread.workspaceId !== this.workspaceId) {
      throw new OperatorCliError(
        "WORKSPACE_MISMATCH",
        `Thread workspace mismatch: expected=${this.workspaceId} actual=${thread.workspaceId}`
      );
    }
  }

  private async transitionThreadStatus(input: {
    threadId: string;
    nextStatus: ThreadStatus;
    reason: string;
    actorAgentId: string;
    operation: string;
  }): Promise<OperatorCliServiceResult> {
    const existing = await this.repository.getThreadById(input.threadId);
    if (existing === null) {
      throw new OperatorCliError("NOT_FOUND", `Thread not found: ${input.threadId}`);
    }
    this.assertThreadInWorkspace(existing);

    if (existing.status === input.nextStatus) {
      await this.repository.appendAuditEvent({
        workspaceId: existing.workspaceId,
        actorAgentId: input.actorAgentId,
        operation: input.operation,
        resourceType: "thread",
        resourceId: existing.threadId,
        threadId: existing.threadId,
        result: "success",
        payload: {
          from_status: existing.status,
          to_status: input.nextStatus,
          reason: input.reason,
          noop: true
        },
        createdAt: this.now()
      });
      return {
        ok: true,
        command: input.operation as OperatorCommand["kind"],
        happenedAt: this.now().toISOString(),
        data: {
          thread_id: existing.threadId,
          status: existing.status,
          changed: false
        }
      };
    }

    if (!canTransitionThreadStatus(existing.status, input.nextStatus)) {
      throw new OperatorCliError(
        "INVALID_TRANSITION",
        `Invalid thread status transition: ${existing.status} -> ${input.nextStatus}`
      );
    }

    if (
      requiresOverrideReason(existing.status, input.nextStatus) &&
      !hasOverrideReason(input.reason)
    ) {
      throw new OperatorCliError(
        "OVERRIDE_REQUIRED",
        "Closing a blocked thread requires reason prefix human_override: or coordinator_override:"
      );
    }

    const updated = await this.repository.updateThreadStatus({
      threadId: existing.threadId,
      expectedCurrentStatus: existing.status,
      nextStatus: input.nextStatus,
      updatedAt: this.now()
    });
    if (updated === null) {
      throw new OperatorCliError(
        "CONFLICT",
        "Thread status changed during transition; retry command with fresh state"
      );
    }

    await this.repository.appendAuditEvent({
      workspaceId: updated.workspaceId,
      actorAgentId: input.actorAgentId,
      operation: input.operation,
      resourceType: "thread",
      resourceId: updated.threadId,
      threadId: updated.threadId,
      result: "success",
      payload: {
        from_status: existing.status,
        to_status: updated.status,
        reason: input.reason
      },
      createdAt: this.now()
    });

    return {
      ok: true,
      command: input.operation as OperatorCommand["kind"],
      happenedAt: this.now().toISOString(),
      data: {
        thread_id: updated.threadId,
        status: updated.status,
        changed: true
      }
    };
  }

  public async execute(command: OperatorCommand): Promise<OperatorCliServiceResult> {
    if (command.kind === "inspect-thread") {
      const thread = await this.repository.getThreadById(command.threadId);
      if (thread === null) {
        throw new OperatorCliError("NOT_FOUND", `Thread not found: ${command.threadId}`);
      }
      this.assertThreadInWorkspace(thread);

      const [participants, threadMessages, jobs] = await Promise.all([
        this.repository.listParticipants(thread.threadId),
        this.repository.listMessages(thread.threadId, command.limitMessages),
        this.repository.listTriggerJobs(thread.threadId, command.limitTriggers)
      ]);

      return {
        ok: true,
        command: command.kind,
        happenedAt: this.now().toISOString(),
        data: {
          thread,
          participants,
          recent_messages: threadMessages,
          recent_trigger_jobs: jobs
        }
      };
    }

    if (command.kind === "escalate-thread") {
      return this.transitionThreadStatus({
        threadId: command.threadId,
        nextStatus: "blocked",
        reason: command.reason,
        actorAgentId: command.actorAgentId,
        operation: command.kind
      });
    }

    if (command.kind === "unblock-thread") {
      return this.transitionThreadStatus({
        threadId: command.threadId,
        nextStatus: "active",
        reason: command.reason,
        actorAgentId: command.actorAgentId,
        operation: command.kind
      });
    }

    return this.transitionThreadStatus({
      threadId: command.threadId,
      nextStatus: "closed",
      reason: command.reason,
      actorAgentId: command.actorAgentId,
      operation: command.kind
    });
  }
}
