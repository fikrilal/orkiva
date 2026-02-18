import type { DbClient } from "@orkiva/db";
import { sessionRegistry } from "@orkiva/db";
import {
  applySessionHeartbeat,
  createSessionFromHeartbeat,
  isSessionStale,
  type ManagementMode,
  type SessionRecord,
  type SessionStatus
} from "@orkiva/domain";
import { and, eq, lt } from "drizzle-orm";

export type RuntimeRegistryRecord = SessionRecord;

export interface RegisterRuntimeInput {
  agentId: string;
  workspaceId: string;
  sessionId: string;
  runtime: string;
  managementMode: ManagementMode;
  resumable: boolean;
  status?: SessionStatus;
  registeredAt?: Date;
}

export interface HeartbeatRuntimeInput {
  agentId: string;
  workspaceId: string;
  sessionId: string;
  runtime: string;
  managementMode: ManagementMode;
  resumable: boolean;
  status: SessionStatus;
  heartbeatAt?: Date;
}

export interface DeregisterRuntimeInput {
  agentId: string;
  workspaceId: string;
  deregisteredAt?: Date;
}

export interface ReconcileRuntimeInput {
  workspaceId: string;
  staleAfterHours: number;
  reconciledAt?: Date;
}

export interface ReconcileRuntimeResult {
  workspaceId: string;
  reconciledAt: Date;
  checkedRuntimes: number;
  transitionedOffline: number;
}

export interface RuntimeRegistryStore {
  upsertFromHeartbeat(input: HeartbeatRuntimeInput): Promise<RuntimeRegistryRecord>;
  getRuntime(agentId: string, workspaceId: string): Promise<RuntimeRegistryRecord | null>;
  listWorkspaceRuntimes(workspaceId: string): Promise<readonly RuntimeRegistryRecord[]>;
  markRuntimeStatus(input: {
    agentId: string;
    workspaceId: string;
    status: SessionStatus;
    resumable?: boolean;
    updatedAt: Date;
  }): Promise<RuntimeRegistryRecord | null>;
}

const runtimeKey = (agentId: string, workspaceId: string): string => `${agentId}::${workspaceId}`;

const toRuntimeRegistryRecord = (row: {
  agentId: string;
  workspaceId: string;
  sessionId: string;
  runtime: string;
  managementMode: ManagementMode;
  resumable: boolean;
  status: SessionStatus;
  lastHeartbeatAt: Date;
  updatedAt: Date;
}): RuntimeRegistryRecord => ({
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

export class InMemoryRuntimeRegistryStore implements RuntimeRegistryStore {
  private readonly runtimes = new Map<string, RuntimeRegistryRecord>();

  public upsertFromHeartbeat(input: HeartbeatRuntimeInput): Promise<RuntimeRegistryRecord> {
    const key = runtimeKey(input.agentId, input.workspaceId);
    const existing = this.runtimes.get(key) ?? null;
    const next = applySessionHeartbeat(existing, input);
    this.runtimes.set(key, next);
    return Promise.resolve(next);
  }

  public getRuntime(agentId: string, workspaceId: string): Promise<RuntimeRegistryRecord | null> {
    return Promise.resolve(this.runtimes.get(runtimeKey(agentId, workspaceId)) ?? null);
  }

  public listWorkspaceRuntimes(workspaceId: string): Promise<readonly RuntimeRegistryRecord[]> {
    return Promise.resolve(
      [...this.runtimes.values()].filter((runtime) => runtime.workspaceId === workspaceId)
    );
  }

  public markRuntimeStatus(input: {
    agentId: string;
    workspaceId: string;
    status: SessionStatus;
    resumable?: boolean;
    updatedAt: Date;
  }): Promise<RuntimeRegistryRecord | null> {
    const key = runtimeKey(input.agentId, input.workspaceId);
    const existing = this.runtimes.get(key);
    if (!existing) {
      return Promise.resolve(null);
    }

    const updated: RuntimeRegistryRecord = {
      ...existing,
      status: input.status,
      resumable: input.resumable ?? existing.resumable,
      updatedAt: input.updatedAt
    };
    this.runtimes.set(key, updated);
    return Promise.resolve(updated);
  }
}

export class DbRuntimeRegistryStore implements RuntimeRegistryStore {
  public constructor(private readonly db: DbClient) {}

  private async findRuntime(
    agentId: string,
    workspaceId: string
  ): Promise<RuntimeRegistryRecord | null> {
    const existing = await this.db.query.sessionRegistry.findFirst({
      where: (table) => and(eq(table.agentId, agentId), eq(table.workspaceId, workspaceId)),
      columns: {
        agentId: true,
        workspaceId: true,
        sessionId: true,
        runtime: true,
        managementMode: true,
        resumable: true,
        status: true,
        lastHeartbeatAt: true,
        updatedAt: true
      }
    });
    if (!existing) {
      return null;
    }

    return toRuntimeRegistryRecord(existing);
  }

  public async upsertFromHeartbeat(input: HeartbeatRuntimeInput): Promise<RuntimeRegistryRecord> {
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
      return toRuntimeRegistryRecord(firstUpdated);
    }

    const existing = await this.findRuntime(normalized.agentId, normalized.workspaceId);
    if (existing) {
      return existing;
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

    const inserted = await this.findRuntime(normalized.agentId, normalized.workspaceId);
    if (inserted) {
      return inserted;
    }

    throw new Error("Failed to persist runtime heartbeat");
  }

  public getRuntime(agentId: string, workspaceId: string): Promise<RuntimeRegistryRecord | null> {
    return this.findRuntime(agentId, workspaceId);
  }

  public async listWorkspaceRuntimes(
    workspaceId: string
  ): Promise<readonly RuntimeRegistryRecord[]> {
    const rows = await this.db.query.sessionRegistry.findMany({
      where: (table) => eq(table.workspaceId, workspaceId),
      columns: {
        agentId: true,
        workspaceId: true,
        sessionId: true,
        runtime: true,
        managementMode: true,
        resumable: true,
        status: true,
        lastHeartbeatAt: true,
        updatedAt: true
      }
    });
    return rows.map((row) => toRuntimeRegistryRecord(row));
  }

  public async markRuntimeStatus(input: {
    agentId: string;
    workspaceId: string;
    status: SessionStatus;
    resumable?: boolean;
    updatedAt: Date;
  }): Promise<RuntimeRegistryRecord | null> {
    const updated = await this.db
      .update(sessionRegistry)
      .set({
        status: input.status,
        ...(input.resumable === undefined ? {} : { resumable: input.resumable }),
        updatedAt: input.updatedAt
      })
      .where(
        and(
          eq(sessionRegistry.agentId, input.agentId),
          eq(sessionRegistry.workspaceId, input.workspaceId)
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
    return firstUpdated === undefined ? null : toRuntimeRegistryRecord(firstUpdated);
  }
}

export class RuntimeRegistryService {
  public constructor(
    private readonly store: RuntimeRegistryStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  public registerRuntime(input: RegisterRuntimeInput): Promise<RuntimeRegistryRecord> {
    return this.store.upsertFromHeartbeat({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      runtime: input.runtime,
      managementMode: input.managementMode,
      resumable: input.resumable,
      status: input.status ?? "idle",
      heartbeatAt: input.registeredAt ?? this.now()
    });
  }

  public heartbeatRuntime(input: HeartbeatRuntimeInput): Promise<RuntimeRegistryRecord> {
    return this.store.upsertFromHeartbeat({
      ...input,
      heartbeatAt: input.heartbeatAt ?? this.now()
    });
  }

  public async reconcileWorkspaceRuntimes(
    input: ReconcileRuntimeInput
  ): Promise<ReconcileRuntimeResult> {
    const reconciledAt = input.reconciledAt ?? this.now();
    const runtimes = await this.store.listWorkspaceRuntimes(input.workspaceId);

    let transitionedOffline = 0;
    for (const runtime of runtimes) {
      if (runtime.status === "offline") {
        continue;
      }
      if (!isSessionStale(runtime, input.staleAfterHours, reconciledAt)) {
        continue;
      }

      const updated = await this.store.markRuntimeStatus({
        agentId: runtime.agentId,
        workspaceId: runtime.workspaceId,
        status: "offline",
        updatedAt: reconciledAt
      });
      if (updated !== null) {
        transitionedOffline += 1;
      }
    }

    return {
      workspaceId: input.workspaceId,
      reconciledAt,
      checkedRuntimes: runtimes.length,
      transitionedOffline
    };
  }

  public deregisterRuntime(input: DeregisterRuntimeInput): Promise<RuntimeRegistryRecord | null> {
    return this.store.markRuntimeStatus({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      status: "offline",
      resumable: false,
      updatedAt: input.deregisteredAt ?? this.now()
    });
  }
}
