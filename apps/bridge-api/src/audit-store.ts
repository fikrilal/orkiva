import type { DbClient } from "@orkiva/db";
import { auditEvents } from "@orkiva/db";

export interface AuditEventInput {
  workspaceId: string;
  actorAgentId?: string;
  actorRole?: string;
  operation: string;
  resourceType: string;
  resourceId: string;
  threadId?: string;
  requestId?: string;
  result: string;
  payload?: Record<string, unknown>;
  createdAt?: Date;
}

export interface AuditStore {
  writeEvent(input: AuditEventInput): Promise<void>;
}

export interface AuditEventRecord extends AuditEventInput {
  createdAt: Date;
}

export class InMemoryAuditStore implements AuditStore {
  public readonly events: AuditEventRecord[] = [];

  public writeEvent(input: AuditEventInput): Promise<void> {
    this.events.push({
      ...input,
      createdAt: input.createdAt ?? new Date()
    });

    return Promise.resolve();
  }
}

export class DbAuditStore implements AuditStore {
  public constructor(private readonly db: DbClient) {}

  public async writeEvent(input: AuditEventInput): Promise<void> {
    await this.db.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      ...(input.actorAgentId === undefined ? {} : { actorAgentId: input.actorAgentId }),
      ...(input.actorRole === undefined ? {} : { actorRole: input.actorRole }),
      operation: input.operation,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      result: input.result,
      ...(input.payload === undefined ? {} : { payload: input.payload }),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt })
    });
  }
}
