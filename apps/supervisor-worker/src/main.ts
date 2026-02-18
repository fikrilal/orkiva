import { createDb, createDbPool } from "@orkiva/db";
import { formatConfigValidationError, loadSupervisorWorkerConfig } from "@orkiva/shared";

import {
  DbUnreadReconciliationSnapshotStore,
  InMemoryUnreadReconciliationStateStore,
  UnreadReconciliationService
} from "./unread-reconciliation.js";

const service = "supervisor-worker";

try {
  const config = loadSupervisorWorkerConfig(process.env);
  const dbPool = createDbPool(config.DATABASE_URL);
  const db = createDb(dbPool);
  const reconciliationService = new UnreadReconciliationService(
    new DbUnreadReconciliationSnapshotStore(db),
    new InMemoryUnreadReconciliationStateStore()
  );

  const runPollingTick = async (): Promise<void> => {
    const result = await reconciliationService.reconcile({
      workspaceId: config.WORKSPACE_ID,
      staleAfterHours: config.SESSION_STALE_AFTER_HOURS
    });
    if (result.candidates.length > 0) {
      console.log(
        `[${service}] unread reconciliation candidates=${result.candidates.length} participantsScanned=${result.stats.participantsScanned} deduplicated=${result.stats.deduplicatedParticipants}`
      );
    } else {
      console.log(
        `[${service}] unread reconciliation tick completed (participantsScanned=${result.stats.participantsScanned})`
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
