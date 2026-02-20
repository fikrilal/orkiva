import { describe, expect, it } from "vitest";

import { InMemoryRuntimeRegistryStore, RuntimeRegistryService } from "./runtime-registry.js";

describe("runtime registry lifecycle", () => {
  it("registers runtimes and keeps newest heartbeat data", async () => {
    const service = new RuntimeRegistryService(new InMemoryRuntimeRegistryStore());

    await service.registerRuntime({
      agentId: "reviewer_agent",
      workspaceId: "wk_01",
      sessionId: "sess_old",
      runtime: "codex_cli",
      managementMode: "managed",
      resumable: true,
      status: "idle",
      registeredAt: new Date("2026-02-18T10:00:00.000Z")
    });

    const heartbeat = await service.heartbeatRuntime({
      agentId: "reviewer_agent",
      workspaceId: "wk_01",
      sessionId: "sess_new",
      runtime: "codex_cli",
      managementMode: "managed",
      resumable: true,
      status: "active",
      heartbeatAt: new Date("2026-02-18T10:05:00.000Z")
    });

    expect(heartbeat.sessionId).toBe("sess_new");
    expect(heartbeat.status).toBe("active");
    expect(heartbeat.lastHeartbeatAt.toISOString()).toBe("2026-02-18T10:05:00.000Z");
  });

  it("reconciles stale non-offline runtimes to offline", async () => {
    const service = new RuntimeRegistryService(new InMemoryRuntimeRegistryStore());

    await service.registerRuntime({
      agentId: "reviewer_agent",
      workspaceId: "wk_01",
      sessionId: "sess_1",
      runtime: "codex_cli",
      managementMode: "managed",
      resumable: true,
      status: "active",
      registeredAt: new Date("2026-02-18T08:00:00.000Z")
    });
    await service.registerRuntime({
      agentId: "executioner_agent",
      workspaceId: "wk_01",
      sessionId: "sess_2",
      runtime: "codex_cli",
      managementMode: "managed",
      resumable: true,
      status: "offline",
      registeredAt: new Date("2026-02-18T08:00:00.000Z")
    });

    const result = await service.reconcileWorkspaceRuntimes({
      workspaceId: "wk_01",
      staleAfterHours: 1,
      reconciledAt: new Date("2026-02-18T10:10:00.000Z")
    });

    expect(result.checkedRuntimes).toBe(2);
    expect(result.transitionedOffline).toBe(1);
  });

  it("deregisters runtime to offline and non-resumable", async () => {
    const service = new RuntimeRegistryService(new InMemoryRuntimeRegistryStore());

    await service.registerRuntime({
      agentId: "reviewer_agent",
      workspaceId: "wk_01",
      sessionId: "sess_3",
      runtime: "codex_cli",
      managementMode: "managed",
      resumable: true,
      status: "active",
      registeredAt: new Date("2026-02-18T10:00:00.000Z")
    });

    const deregistered = await service.deregisterRuntime({
      agentId: "reviewer_agent",
      workspaceId: "wk_01",
      deregisteredAt: new Date("2026-02-18T10:20:00.000Z")
    });

    expect(deregistered).not.toBeNull();
    expect(deregistered?.status).toBe("offline");
    expect(deregistered?.resumable).toBe(false);
  });
});
