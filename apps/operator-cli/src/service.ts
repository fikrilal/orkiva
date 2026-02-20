import { auditEvents, threads, type DbClient } from "@orkiva/db";
import { canTransitionThreadStatus, type ThreadStatus } from "@orkiva/domain";
import { and, desc, eq, isNull } from "drizzle-orm";

import type { OperatorCommand } from "./commands.js";

const OVERRIDE_REASON_PREFIXES = ["human_override:", "coordinator_override:"] as const;

export interface ThreadRecord {
  threadId: string;
  workspaceId: string;
  title: string;
  type: "conversation" | "workflow" | "incident";
  status: ThreadStatus;
  escalationOwnerAgentId: string | null;
  escalationAssignedByAgentId: string | null;
  escalationAssignedAt: Date | null;
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
    | "fallback_spawn"
    | "callback_pending"
    | "callback_retry"
    | "callback_delivered"
    | "callback_failed";
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
  updateEscalationOwner(input: {
    threadId: string;
    expectedCurrentStatus: ThreadStatus;
    expectedCurrentOwnerAgentId: string | null;
    nextOwnerAgentId: string;
    assignedByAgentId: string;
    assignedAt: Date;
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
        escalationOwnerAgentId: true,
        escalationAssignedByAgentId: true,
        escalationAssignedAt: true,
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
    const shouldClearEscalationOwner = input.nextStatus !== "blocked";
    const updated = await this.db
      .update(threads)
      .set({
        status: input.nextStatus,
        ...(shouldClearEscalationOwner
          ? {
              escalationOwnerAgentId: null,
              escalationAssignedByAgentId: null,
              escalationAssignedAt: null
            }
          : {}),
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
        escalationOwnerAgentId: threads.escalationOwnerAgentId,
        escalationAssignedByAgentId: threads.escalationAssignedByAgentId,
        escalationAssignedAt: threads.escalationAssignedAt,
        createdAt: threads.createdAt,
        updatedAt: threads.updatedAt
      });
    return updated[0] ?? null;
  }

  public async updateEscalationOwner(input: {
    threadId: string;
    expectedCurrentStatus: ThreadStatus;
    expectedCurrentOwnerAgentId: string | null;
    nextOwnerAgentId: string;
    assignedByAgentId: string;
    assignedAt: Date;
    updatedAt: Date;
  }): Promise<ThreadRecord | null> {
    const whereClause =
      input.expectedCurrentOwnerAgentId === null
        ? and(
            eq(threads.threadId, input.threadId),
            eq(threads.status, input.expectedCurrentStatus),
            isNull(threads.escalationOwnerAgentId)
          )
        : and(
            eq(threads.threadId, input.threadId),
            eq(threads.status, input.expectedCurrentStatus),
            eq(threads.escalationOwnerAgentId, input.expectedCurrentOwnerAgentId)
          );

    const updated = await this.db
      .update(threads)
      .set({
        escalationOwnerAgentId: input.nextOwnerAgentId,
        escalationAssignedByAgentId: input.assignedByAgentId,
        escalationAssignedAt: input.assignedAt,
        updatedAt: input.updatedAt
      })
      .where(whereClause)
      .returning({
        threadId: threads.threadId,
        workspaceId: threads.workspaceId,
        title: threads.title,
        type: threads.type,
        status: threads.status,
        escalationOwnerAgentId: threads.escalationOwnerAgentId,
        escalationAssignedByAgentId: threads.escalationAssignedByAgentId,
        escalationAssignedAt: threads.escalationAssignedAt,
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

  private async assertOwnerAgentIsThreadParticipant(
    threadId: string,
    ownerAgentId: string
  ): Promise<void> {
    const participants = await this.repository.listParticipants(threadId);
    if (!participants.includes(ownerAgentId)) {
      throw new OperatorCliError(
        "INVALID_ARGUMENT",
        `Escalation owner must be a thread participant: ${ownerAgentId}`
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
          escalation_owner_agent_id: existing.escalationOwnerAgentId ?? null,
          escalation_assigned_by_agent_id: existing.escalationAssignedByAgentId ?? null,
          escalation_assigned_at: existing.escalationAssignedAt?.toISOString() ?? null,
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

    const owner = existing.escalationOwnerAgentId;
    const hasAssignedOwner = owner !== null;
    const isActorEscalationOwner = hasAssignedOwner && owner === input.actorAgentId;
    const isBlockedToActive = existing.status === "blocked" && input.nextStatus === "active";
    const isBlockedToClosed = existing.status === "blocked" && input.nextStatus === "closed";
    const mustUseOverrideReason =
      (isBlockedToClosed && !isActorEscalationOwner) ||
      (isBlockedToActive && hasAssignedOwner && !isActorEscalationOwner);

    if (mustUseOverrideReason && !hasOverrideReason(input.reason)) {
      throw new OperatorCliError(
        "OVERRIDE_REQUIRED",
        "Blocked thread transition requires escalation owner or reason prefix human_override: or coordinator_override:"
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
        reason: input.reason,
        escalation_owner_agent_id_before: existing.escalationOwnerAgentId,
        escalation_owner_agent_id_after: updated.escalationOwnerAgentId,
        override_used: hasOverrideReason(input.reason)
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

  private async assignEscalationOwner(input: {
    threadId: string;
    ownerAgentId: string;
    reason: string;
    actorAgentId: string;
    operation: "assign-escalation-owner" | "reassign-escalation-owner";
  }): Promise<OperatorCliServiceResult> {
    const existing = await this.repository.getThreadById(input.threadId);
    if (existing === null) {
      throw new OperatorCliError("NOT_FOUND", `Thread not found: ${input.threadId}`);
    }
    this.assertThreadInWorkspace(existing);

    if (existing.status !== "blocked") {
      throw new OperatorCliError(
        "INVALID_TRANSITION",
        "Escalation owner assignment is only allowed when thread status is blocked"
      );
    }

    const currentOwner = existing.escalationOwnerAgentId;
    const isAssignOperation = input.operation === "assign-escalation-owner";
    if (isAssignOperation && currentOwner !== null) {
      throw new OperatorCliError(
        "CONFLICT",
        `Escalation owner already assigned: ${currentOwner}. Use reassign-escalation-owner.`
      );
    }
    if (!isAssignOperation && currentOwner === null) {
      throw new OperatorCliError(
        "INVALID_ARGUMENT",
        "No escalation owner is currently assigned. Use assign-escalation-owner first."
      );
    }

    await this.assertOwnerAgentIsThreadParticipant(existing.threadId, input.ownerAgentId);

    const eventAt = this.now();
    const updated = await this.repository.updateEscalationOwner({
      threadId: existing.threadId,
      expectedCurrentStatus: "blocked",
      expectedCurrentOwnerAgentId: currentOwner,
      nextOwnerAgentId: input.ownerAgentId,
      assignedByAgentId: input.actorAgentId,
      assignedAt: eventAt,
      updatedAt: eventAt
    });
    if (updated === null) {
      throw new OperatorCliError(
        "CONFLICT",
        "Escalation owner changed concurrently; retry command with fresh state"
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
        reason: input.reason,
        previous_owner_agent_id: currentOwner,
        new_owner_agent_id: updated.escalationOwnerAgentId,
        escalation_assigned_by_agent_id: updated.escalationAssignedByAgentId,
        escalation_assigned_at: updated.escalationAssignedAt?.toISOString() ?? null
      },
      createdAt: eventAt
    });

    return {
      ok: true,
      command: input.operation,
      happenedAt: eventAt.toISOString(),
      data: {
        thread_id: updated.threadId,
        status: updated.status,
        escalation_owner_agent_id: updated.escalationOwnerAgentId,
        escalation_assigned_by_agent_id: updated.escalationAssignedByAgentId,
        escalation_assigned_at: updated.escalationAssignedAt?.toISOString() ?? null,
        changed: currentOwner !== updated.escalationOwnerAgentId
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

    if (command.kind === "assign-escalation-owner") {
      return this.assignEscalationOwner({
        threadId: command.threadId,
        ownerAgentId: command.ownerAgentId,
        reason: command.reason,
        actorAgentId: command.actorAgentId,
        operation: command.kind
      });
    }

    if (command.kind === "reassign-escalation-owner") {
      return this.assignEscalationOwner({
        threadId: command.threadId,
        ownerAgentId: command.ownerAgentId,
        reason: command.reason,
        actorAgentId: command.actorAgentId,
        operation: command.kind
      });
    }

    if (command.kind === "get-escalation-owner") {
      const thread = await this.repository.getThreadById(command.threadId);
      if (thread === null) {
        throw new OperatorCliError("NOT_FOUND", `Thread not found: ${command.threadId}`);
      }
      this.assertThreadInWorkspace(thread);

      return {
        ok: true,
        command: command.kind,
        happenedAt: this.now().toISOString(),
        data: {
          thread_id: thread.threadId,
          status: thread.status,
          escalation_owner_agent_id: thread.escalationOwnerAgentId,
          escalation_assigned_by_agent_id: thread.escalationAssignedByAgentId,
          escalation_assigned_at: thread.escalationAssignedAt?.toISOString() ?? null
        }
      };
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
