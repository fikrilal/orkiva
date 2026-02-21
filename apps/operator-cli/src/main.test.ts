import { describe, expect, it } from "vitest";

import { parseOperatorCommand } from "./commands.js";
import {
  OperatorCliError,
  OperatorCliService,
  type FallbackRunSummaryRecord,
  type OperatorRepository,
  type ThreadMessageRecord,
  type ThreadRecord,
  type TriggerJobSummaryRecord
} from "./service.js";

class InMemoryOperatorRepository implements OperatorRepository {
  public readonly audits: Array<{
    operation: string;
    threadId: string;
    result: "success" | "rejected";
    payload: Record<string, unknown>;
  }> = [];
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly participants = new Map<string, string[]>();
  private readonly messages = new Map<string, ThreadMessageRecord[]>();
  private readonly jobs = new Map<string, TriggerJobSummaryRecord[]>();
  private readonly fallbackRuns = new Map<string, FallbackRunSummaryRecord>();

  public seed(input: {
    thread: ThreadRecord;
    participants?: string[];
    messages?: ThreadMessageRecord[];
    jobs?: TriggerJobSummaryRecord[];
    fallbackRuns?: FallbackRunSummaryRecord[];
  }): void {
    this.threads.set(input.thread.threadId, input.thread);
    this.participants.set(input.thread.threadId, input.participants ?? []);
    this.messages.set(input.thread.threadId, input.messages ?? []);
    this.jobs.set(input.thread.threadId, input.jobs ?? []);
    for (const run of input.fallbackRuns ?? []) {
      this.fallbackRuns.set(run.triggerId, run);
    }
  }

  public getThreadById(threadId: string): Promise<ThreadRecord | null> {
    return Promise.resolve(this.threads.get(threadId) ?? null);
  }

  public listParticipants(threadId: string): Promise<readonly string[]> {
    return Promise.resolve(this.participants.get(threadId) ?? []);
  }

  public listMessages(threadId: string, limit: number): Promise<readonly ThreadMessageRecord[]> {
    return Promise.resolve((this.messages.get(threadId) ?? []).slice(0, limit));
  }

  public listTriggerJobs(
    threadId: string,
    limit: number
  ): Promise<readonly TriggerJobSummaryRecord[]> {
    return Promise.resolve((this.jobs.get(threadId) ?? []).slice(0, limit));
  }

  public listFallbackRuns(input: {
    workspaceId: string;
    status: "running" | "all";
    limit: number;
    triggerId?: string;
    threadId?: string;
  }): Promise<readonly FallbackRunSummaryRecord[]> {
    const runs = [...this.fallbackRuns.values()]
      .filter((run) => run.workspaceId === input.workspaceId)
      .filter((run) => (input.status === "running" ? run.status === "running" : true))
      .filter((run) => (input.triggerId === undefined ? true : run.triggerId === input.triggerId))
      .filter((run) => (input.threadId === undefined ? true : run.threadId === input.threadId))
      .slice(0, input.limit);
    return Promise.resolve(runs);
  }

  public updateThreadStatus(input: {
    threadId: string;
    expectedCurrentStatus: "active" | "blocked" | "resolved" | "closed";
    nextStatus: "active" | "blocked" | "resolved" | "closed";
    updatedAt: Date;
  }): Promise<ThreadRecord | null> {
    const current = this.threads.get(input.threadId);
    if (current === undefined || current.status !== input.expectedCurrentStatus) {
      return Promise.resolve(null);
    }

    const updated: ThreadRecord =
      input.nextStatus === "blocked"
        ? {
            ...current,
            status: input.nextStatus,
            updatedAt: input.updatedAt
          }
        : {
            threadId: current.threadId,
            workspaceId: current.workspaceId,
            title: current.title,
            type: current.type,
            status: input.nextStatus,
            escalationOwnerAgentId: null,
            escalationAssignedByAgentId: null,
            escalationAssignedAt: null,
            createdAt: current.createdAt,
            updatedAt: input.updatedAt
          };
    this.threads.set(input.threadId, updated);
    return Promise.resolve(updated);
  }

  public updateEscalationOwner(input: {
    threadId: string;
    expectedCurrentStatus: "active" | "blocked" | "resolved" | "closed";
    expectedCurrentOwnerAgentId: string | null;
    nextOwnerAgentId: string;
    assignedByAgentId: string;
    assignedAt: Date;
    updatedAt: Date;
  }): Promise<ThreadRecord | null> {
    const current = this.threads.get(input.threadId);
    if (current === undefined || current.status !== input.expectedCurrentStatus) {
      return Promise.resolve(null);
    }

    const currentOwner = current.escalationOwnerAgentId;
    if (currentOwner !== input.expectedCurrentOwnerAgentId) {
      return Promise.resolve(null);
    }

    const updated: ThreadRecord = {
      ...current,
      escalationOwnerAgentId: input.nextOwnerAgentId,
      escalationAssignedByAgentId: input.assignedByAgentId,
      escalationAssignedAt: input.assignedAt,
      updatedAt: input.updatedAt
    };
    this.threads.set(input.threadId, updated);
    return Promise.resolve(updated);
  }

  public appendAuditEvent(input: {
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
    void input.workspaceId;
    void input.actorAgentId;
    void input.resourceType;
    void input.resourceId;
    void input.createdAt;
    this.audits.push({
      operation: input.operation,
      threadId: input.threadId,
      result: input.result,
      payload: input.payload
    });
    return Promise.resolve();
  }

  public completeFallbackRunByOperator(input: {
    triggerId: string;
    workspaceId: string;
    transitionedAt: Date;
    completedStatus: "killed" | "orphaned";
    errorCode: string;
    details: Record<string, unknown>;
  }): Promise<boolean> {
    void input.transitionedAt;
    void input.errorCode;
    void input.details;
    const run = this.fallbackRuns.get(input.triggerId);
    if (run === undefined || run.workspaceId !== input.workspaceId || run.status !== "running") {
      return Promise.resolve(false);
    }
    this.fallbackRuns.set(input.triggerId, {
      ...run,
      status: input.completedStatus,
      endedAt: new Date("2026-02-18T12:00:01.000Z"),
      errorCode: "OPERATOR_TERMINATED_FALLBACK"
    });
    return Promise.resolve(true);
  }
}

describe("operator-cli parser", () => {
  it("parses inspect-thread with explicit limits and json flag", () => {
    const parsed = parseOperatorCommand([
      "inspect-thread",
      "--thread-id",
      "th_01",
      "--limit-messages",
      "10",
      "--limit-triggers",
      "5",
      "--json"
    ]);
    expect(parsed).toEqual({
      kind: "inspect-thread",
      threadId: "th_01",
      limitMessages: 10,
      limitTriggers: 5,
      json: true
    });
  });

  it("rejects unknown command", () => {
    expect(() => parseOperatorCommand(["unknown-command"])).toThrow("Unknown command");
  });

  it("parses assign-escalation-owner command", () => {
    const parsed = parseOperatorCommand([
      "assign-escalation-owner",
      "--thread-id",
      "th_01",
      "--owner-agent-id",
      "reviewer_agent",
      "--reason",
      "manual_assignment:critical",
      "--actor-agent-id",
      "coordinator_agent"
    ]);
    expect(parsed).toEqual({
      kind: "assign-escalation-owner",
      threadId: "th_01",
      ownerAgentId: "reviewer_agent",
      reason: "manual_assignment:critical",
      actorAgentId: "coordinator_agent",
      json: false
    });
  });

  it("parses fallback-list command", () => {
    const parsed = parseOperatorCommand(["fallback-list", "--status", "all", "--limit", "10"]);
    expect(parsed).toEqual({
      kind: "fallback-list",
      status: "all",
      limit: 10,
      json: false
    });
  });

  it("parses fallback-kill command with trigger selector", () => {
    const parsed = parseOperatorCommand([
      "fallback-kill",
      "--trigger-id",
      "trg_01",
      "--reason",
      "manual_kill:test"
    ]);
    expect(parsed).toEqual({
      kind: "fallback-kill",
      triggerId: "trg_01",
      threadId: null,
      reason: "manual_kill:test",
      actorAgentId: "human_operator",
      json: false
    });
  });
});

describe("operator-cli service", () => {
  const now = new Date("2026-02-18T12:00:00.000Z");

  const seedThread = (): ThreadRecord => ({
    threadId: "th_01",
    workspaceId: "wk_01",
    title: "Workflow",
    type: "workflow",
    status: "active",
    escalationOwnerAgentId: null,
    escalationAssignedByAgentId: null,
    escalationAssignedAt: null,
    createdAt: now,
    updatedAt: now
  });

  it("returns inspect output with participants/messages/jobs", async () => {
    const repo = new InMemoryOperatorRepository();
    repo.seed({
      thread: seedThread(),
      participants: ["executioner_agent", "reviewer_agent"],
      messages: [
        {
          messageId: "m_01",
          seq: 1,
          senderAgentId: "executioner_agent",
          kind: "chat",
          body: "Please review.",
          createdAt: now
        }
      ],
      jobs: [
        {
          triggerId: "trg_01",
          targetAgentId: "reviewer_agent",
          status: "delivered",
          attempts: 1,
          maxRetries: 2,
          createdAt: now,
          updatedAt: now
        }
      ]
    });
    const service = new OperatorCliService(repo, "wk_01", () => now);
    const result = await service.execute({
      kind: "inspect-thread",
      threadId: "th_01",
      limitMessages: 20,
      limitTriggers: 20,
      json: true
    });

    expect(result.ok).toBe(true);
    expect(result.data["participants"]).toEqual(["executioner_agent", "reviewer_agent"]);
    expect(result.data["recent_messages"]).toHaveLength(1);
    expect(result.data["recent_trigger_jobs"]).toHaveLength(1);
  });

  it("lists running fallback runs", async () => {
    const repo = new InMemoryOperatorRepository();
    repo.seed({
      thread: seedThread(),
      fallbackRuns: [
        {
          triggerId: "trg_run_01",
          threadId: "th_01",
          workspaceId: "wk_01",
          targetAgentId: "executioner_agent",
          launchMode: "spawn",
          pid: 2222,
          status: "running",
          startedAt: now,
          deadlineAt: new Date("2026-02-18T12:30:00.000Z"),
          endedAt: null,
          errorCode: null
        }
      ]
    });
    const service = new OperatorCliService(repo, "wk_01", () => now);
    const result = await service.execute({
      kind: "fallback-list",
      status: "running",
      limit: 10,
      json: true
    });

    expect(result.ok).toBe(true);
    expect(result.data["count"]).toBe(1);
  });

  it("kills matching fallback run and queues completion transition", async () => {
    const repo = new InMemoryOperatorRepository();
    repo.seed({
      thread: seedThread(),
      fallbackRuns: [
        {
          triggerId: "trg_run_kill_01",
          threadId: "th_01",
          workspaceId: "wk_01",
          targetAgentId: "executioner_agent",
          launchMode: "spawn",
          pid: 999999,
          status: "running",
          startedAt: now,
          deadlineAt: new Date("2026-02-18T12:30:00.000Z"),
          endedAt: null,
          errorCode: null
        }
      ]
    });
    const service = new OperatorCliService(repo, "wk_01", () => now, 10);
    const result = await service.execute({
      kind: "fallback-kill",
      triggerId: "trg_run_kill_01",
      threadId: null,
      reason: "manual_kill:test",
      actorAgentId: "human_operator",
      json: true
    });

    expect(result.ok).toBe(true);
    expect(result.data["matched"]).toBe(1);
    expect(result.data["transitioned"]).toBe(1);
  });

  it("escalates active thread to blocked and records audit", async () => {
    const repo = new InMemoryOperatorRepository();
    repo.seed({
      thread: seedThread()
    });
    const service = new OperatorCliService(repo, "wk_01", () => now);
    const result = await service.execute({
      kind: "escalate-thread",
      threadId: "th_01",
      reason: "manual_escalation:loop_detected",
      actorAgentId: "human_operator",
      json: true
    });

    expect(result.ok).toBe(true);
    expect(result.data["status"]).toBe("blocked");
    expect(repo.audits).toHaveLength(1);
    expect(repo.audits[0]?.operation).toBe("escalate-thread");
  });

  it("requires explicit override prefix for blocked->closed transition", async () => {
    const repo = new InMemoryOperatorRepository();
    repo.seed({
      thread: {
        ...seedThread(),
        status: "blocked"
      }
    });
    const service = new OperatorCliService(repo, "wk_01", () => now);

    await expect(
      service.execute({
        kind: "override-close-thread",
        threadId: "th_01",
        reason: "close-now",
        actorAgentId: "human_operator",
        json: true
      })
    ).rejects.toEqual(
      new OperatorCliError(
        "OVERRIDE_REQUIRED",
        "Blocked thread transition requires escalation owner or reason prefix human_override: or coordinator_override:"
      )
    );
  });

  it("supports escalation owner assignment and owner-led unblock", async () => {
    const repo = new InMemoryOperatorRepository();
    repo.seed({
      thread: {
        ...seedThread(),
        status: "blocked"
      },
      participants: ["reviewer_agent", "executioner_agent"]
    });
    const service = new OperatorCliService(repo, "wk_01", () => now);

    const assigned = await service.execute({
      kind: "assign-escalation-owner",
      threadId: "th_01",
      ownerAgentId: "reviewer_agent",
      reason: "manual_assignment:ownership",
      actorAgentId: "coordinator_agent",
      json: true
    });
    expect(assigned.ok).toBe(true);
    expect(assigned.data["escalation_owner_agent_id"]).toBe("reviewer_agent");

    const ownerRead = await service.execute({
      kind: "get-escalation-owner",
      threadId: "th_01",
      json: true
    });
    expect(ownerRead.data["escalation_owner_agent_id"]).toBe("reviewer_agent");

    const unblocked = await service.execute({
      kind: "unblock-thread",
      threadId: "th_01",
      reason: "owner_acknowledged_resolution",
      actorAgentId: "reviewer_agent",
      json: true
    });
    expect(unblocked.data["status"]).toBe("active");

    const ownerAfterUnblock = await service.execute({
      kind: "get-escalation-owner",
      threadId: "th_01",
      json: true
    });
    expect(ownerAfterUnblock.data["escalation_owner_agent_id"]).toBeNull();
  });

  it("rejects non-owner unblock without override and allows override", async () => {
    const repo = new InMemoryOperatorRepository();
    repo.seed({
      thread: {
        ...seedThread(),
        status: "blocked",
        escalationOwnerAgentId: "reviewer_agent",
        escalationAssignedByAgentId: "coordinator_agent",
        escalationAssignedAt: now
      },
      participants: ["reviewer_agent", "executioner_agent"]
    });
    const service = new OperatorCliService(repo, "wk_01", () => now);

    await expect(
      service.execute({
        kind: "unblock-thread",
        threadId: "th_01",
        reason: "normal_unblock_attempt",
        actorAgentId: "executioner_agent",
        json: true
      })
    ).rejects.toEqual(
      new OperatorCliError(
        "OVERRIDE_REQUIRED",
        "Blocked thread transition requires escalation owner or reason prefix human_override: or coordinator_override:"
      )
    );

    const overridden = await service.execute({
      kind: "unblock-thread",
      threadId: "th_01",
      reason: "human_override:manual_intervention",
      actorAgentId: "executioner_agent",
      json: true
    });
    expect(overridden.data["status"]).toBe("active");
  });

  it("enforces assign/reassign escalation owner preconditions", async () => {
    const repo = new InMemoryOperatorRepository();
    repo.seed({
      thread: {
        ...seedThread(),
        status: "blocked"
      },
      participants: ["reviewer_agent", "security_agent", "executioner_agent"]
    });
    const service = new OperatorCliService(repo, "wk_01", () => now);

    await expect(
      service.execute({
        kind: "reassign-escalation-owner",
        threadId: "th_01",
        ownerAgentId: "security_agent",
        reason: "handoff",
        actorAgentId: "coordinator_agent",
        json: true
      })
    ).rejects.toEqual(
      new OperatorCliError(
        "INVALID_ARGUMENT",
        "No escalation owner is currently assigned. Use assign-escalation-owner first."
      )
    );

    await service.execute({
      kind: "assign-escalation-owner",
      threadId: "th_01",
      ownerAgentId: "reviewer_agent",
      reason: "initial_assignment",
      actorAgentId: "coordinator_agent",
      json: true
    });

    await expect(
      service.execute({
        kind: "assign-escalation-owner",
        threadId: "th_01",
        ownerAgentId: "executioner_agent",
        reason: "duplicate_assignment",
        actorAgentId: "coordinator_agent",
        json: true
      })
    ).rejects.toEqual(
      new OperatorCliError(
        "CONFLICT",
        "Escalation owner already assigned: reviewer_agent. Use reassign-escalation-owner."
      )
    );

    const reassigned = await service.execute({
      kind: "reassign-escalation-owner",
      threadId: "th_01",
      ownerAgentId: "security_agent",
      reason: "handoff_security_review",
      actorAgentId: "coordinator_agent",
      json: true
    });
    expect(reassigned.data["escalation_owner_agent_id"]).toBe("security_agent");
  });

  it("rejects owner assignment when thread is not blocked", async () => {
    const repo = new InMemoryOperatorRepository();
    repo.seed({
      thread: seedThread(),
      participants: ["reviewer_agent"]
    });
    const service = new OperatorCliService(repo, "wk_01", () => now);

    await expect(
      service.execute({
        kind: "assign-escalation-owner",
        threadId: "th_01",
        ownerAgentId: "reviewer_agent",
        reason: "attempt_while_active",
        actorAgentId: "coordinator_agent",
        json: true
      })
    ).rejects.toEqual(
      new OperatorCliError(
        "INVALID_TRANSITION",
        "Escalation owner assignment is only allowed when thread status is blocked"
      )
    );
  });
});
