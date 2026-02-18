import { createDb, createDbPool } from "@orkiva/db";
import { formatConfigValidationError, loadSupervisorWorkerConfig } from "@orkiva/shared";

import { DbRuntimeRegistryStore, RuntimeRegistryService } from "./runtime-registry.js";
import {
  DbUnreadReconciliationSnapshotStore,
  InMemoryUnreadReconciliationStateStore,
  UnreadReconciliationService
} from "./unread-reconciliation.js";
import { SupervisorWorkerLoop } from "./worker-loop.js";

const service = "supervisor-worker";

try {
  const config = loadSupervisorWorkerConfig(process.env);
  const dbPool = createDbPool(config.DATABASE_URL);
  const db = createDb(dbPool);
  const reconciliationService = new UnreadReconciliationService(
    new DbUnreadReconciliationSnapshotStore(db),
    new InMemoryUnreadReconciliationStateStore()
  );
  const runtimeRegistryService = new RuntimeRegistryService(new DbRuntimeRegistryStore(db));
  const workerLoop = new SupervisorWorkerLoop(reconciliationService, runtimeRegistryService);

  const runPollingTick = async (): Promise<void> => {
    const result = await workerLoop.runTick({
      workspaceId: config.WORKSPACE_ID,
      staleAfterHours: config.SESSION_STALE_AFTER_HOURS
    });
    const unreadResult = result.unreadReconciliation;
    const runtimeResult = result.runtimeReconciliation;
    if (unreadResult.candidates.length > 0 || runtimeResult.transitionedOffline > 0) {
      console.log(
        `[${service}] tick candidates=${unreadResult.candidates.length} participantsScanned=${unreadResult.stats.participantsScanned} deduplicated=${unreadResult.stats.deduplicatedParticipants} runtimesChecked=${runtimeResult.checkedRuntimes} transitionedOffline=${runtimeResult.transitionedOffline}`
      );
    } else {
      console.log(
        `[${service}] tick completed (participantsScanned=${unreadResult.stats.participantsScanned}, runtimesChecked=${runtimeResult.checkedRuntimes})`
      );
    }
  };

  const tick = (): void => {
    void runPollingTick().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`[${service}] unread reconciliation tick failed: ${message}`);
    });
  };

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    clearInterval(intervalHandle);
    void dbPool
      .end()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "unknown error";
        console.error(`[${service}] failed to close db pool: ${message}`);
      })
      .finally(() => {
        console.log(`[${service}] shutdown complete (${signal})`);
        process.exit(0);
      });
  };

  const intervalHandle = setInterval(tick, config.WORKER_POLL_INTERVAL_MS);
  void runPollingTick().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`[${service}] initial unread reconciliation failed: ${message}`);
  });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log(
    `[${service}] bootstrap complete (workspace=${config.WORKSPACE_ID}, pollIntervalMs=${config.WORKER_POLL_INTERVAL_MS})`
  );
} catch (error) {
  console.error(formatConfigValidationError(error));
  process.exit(1);
}
