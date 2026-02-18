import { describe, expect, it } from "vitest";

import { parseOperatorCommand } from "./commands.js";
import {
  OperatorCliError,
  OperatorCliService,
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

  public seed(input: {
    thread: ThreadRecord;
    participants?: string[];
    messages?: ThreadMessageRecord[];
    jobs?: TriggerJobSummaryRecord[];
  }): void {
    this.threads.set(input.thread.threadId, input.thread);
    this.participants.set(input.thread.threadId, input.participants ?? []);
    this.messages.set(input.thread.threadId, input.messages ?? []);
    this.jobs.set(input.thread.threadId, input.jobs ?? []);
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

    const updated: ThreadRecord = {
      ...current,
      status: input.nextStatus,
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
});

describe("operator-cli service", () => {
  const now = new Date("2026-02-18T12:00:00.000Z");

  const seedThread = (): ThreadRecord => ({
    threadId: "th_01",
    workspaceId: "wk_01",
    title: "Workflow",
    type: "workflow",
    status: "active",
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
        "Closing a blocked thread requires reason prefix human_override: or coordinator_override:"
      )
    );
  });
});
