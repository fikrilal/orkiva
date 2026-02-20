import { describe, expect, it } from "vitest";

import { InMemorySessionStore, isSessionRecordStale } from "./session-store.js";

describe("session-store", () => {
  it("keeps the newest heartbeat under concurrent updates", async () => {
    const store = new InMemorySessionStore();

    await Promise.all([
      store.heartbeatSession({
        agentId: "agent_a",
        workspaceId: "wk_01",
        sessionId: "sess_old",
        runtime: "codex_cli",
        managementMode: "managed",
        resumable: true,
        status: "active",
        heartbeatAt: new Date("2026-02-18T10:00:00.000Z")
      }),
      store.heartbeatSession({
        agentId: "agent_a",
        workspaceId: "wk_01",
        sessionId: "sess_new",
        runtime: "codex_cli",
        managementMode: "managed",
        resumable: true,
        status: "idle",
        heartbeatAt: new Date("2026-02-18T10:05:00.000Z")
      })
    ]);

    const latest = await store.getLatestResumableSession({
      agentId: "agent_a",
      workspaceId: "wk_01",
      staleAfterHours: 12,
      referenceTime: new Date("2026-02-18T10:06:00.000Z")
    });

    expect(latest).not.toBeNull();
    expect(latest?.sessionId).toBe("sess_new");
    expect(latest?.status).toBe("idle");
  });

  it("classifies stale sessions and filters stale resumable lookup", async () => {
    const store = new InMemorySessionStore();

    const session = await store.heartbeatSession({
      agentId: "agent_b",
      workspaceId: "wk_01",
      sessionId: "sess_stale_candidate",
      runtime: "codex_cli",
      managementMode: "unmanaged",
      resumable: true,
      status: "offline",
      heartbeatAt: new Date("2026-02-18T06:00:00.000Z")
    });

    const referenceTime = new Date("2026-02-18T12:00:01.000Z");
    expect(isSessionRecordStale(session, 6, referenceTime)).toBe(true);

    const staleFiltered = await store.getLatestResumableSession({
      agentId: "agent_b",
      workspaceId: "wk_01",
      staleAfterHours: 6,
      referenceTime
    });
    expect(staleFiltered).toBeNull();

    const nonStaleLookup = await store.getLatestResumableSession({
      agentId: "agent_b",
      workspaceId: "wk_01",
      staleAfterHours: 7,
      referenceTime
    });
    expect(nonStaleLookup?.sessionId).toBe("sess_stale_candidate");
  });
});
