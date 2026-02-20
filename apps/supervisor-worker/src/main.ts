import { createDb, createDbPool } from "@orkiva/db";
import { createJsonLogger } from "@orkiva/observability";
import { formatConfigValidationError, loadSupervisorWorkerConfig } from "@orkiva/shared";

import { DbRuntimeRegistryStore, RuntimeRegistryService } from "./runtime-registry.js";
import { CodexFallbackExecutor } from "./runtime-fallback.js";
import { ManagedRuntimeTriggerJobExecutor } from "./runtime-trigger-executor.js";
import { NodeCommandExecutor, TmuxTriggerPtyAdapter } from "./tmux-adapter.js";
import { DbTriggerQueueStore, TriggerQueueProcessor } from "./trigger-queue.js";
import {
  DbUnreadReconciliationSnapshotStore,
  InMemoryUnreadReconciliationStateStore,
  UnreadReconciliationService
} from "./unread-reconciliation.js";
import { SupervisorWorkerLoop } from "./worker-loop.js";

const service = "supervisor-worker";
const logger = createJsonLogger(service);

try {
  const config = loadSupervisorWorkerConfig(process.env);
  const dbPool = createDbPool(config.DATABASE_URL);
  const db = createDb(dbPool);
  const runtimeRegistryStore = new DbRuntimeRegistryStore(db);
  const reconciliationService = new UnreadReconciliationService(
    new DbUnreadReconciliationSnapshotStore(db),
    new InMemoryUnreadReconciliationStateStore()
  );
  const runtimeRegistryService = new RuntimeRegistryService(runtimeRegistryStore);
  const commandExecutor = new NodeCommandExecutor();
  const triggerExecutor = new ManagedRuntimeTriggerJobExecutor(
    runtimeRegistryStore,
    new TmuxTriggerPtyAdapter(commandExecutor),
    {
      quietWindowMs: config.TRIGGER_QUIET_WINDOW_MS,
      recheckMs: config.TRIGGER_RECHECK_MS,
      maxDeferMs: config.TRIGGER_MAX_DEFER_MS
    }
  );
  const fallbackExecutor = new CodexFallbackExecutor(runtimeRegistryStore, commandExecutor, {
    resumeMaxAttempts: config.TRIGGER_RESUME_MAX_ATTEMPTS,
    staleAfterHours: config.SESSION_STALE_AFTER_HOURS,
    crashLoopThreshold: config.LOOP_MAX_REPEATED_FINDINGS,
    crashLoopWindowMs: 15 * 60 * 1000
  });
  const triggerQueueProcessor = new TriggerQueueProcessor(
    new DbTriggerQueueStore(db),
    triggerExecutor,
    fallbackExecutor,
    {
      deferRecheckMs: config.TRIGGER_RECHECK_MS,
      rateLimitPerMinute: config.TRIGGER_RATE_LIMIT_PER_MINUTE,
      loopMaxTurns: config.LOOP_MAX_TURNS,
      loopMaxRepeatedFindings: config.LOOP_MAX_REPEATED_FINDINGS
    },
    2000,
    60000,
    logger
  );
  const workerLoop = new SupervisorWorkerLoop(
    reconciliationService,
    runtimeRegistryService,
    triggerQueueProcessor
  );

  const runPollingTick = async (): Promise<void> => {
    const result = await workerLoop.runTick({
      workspaceId: config.WORKSPACE_ID,
      staleAfterHours: config.SESSION_STALE_AFTER_HOURS,
      maxJobsPerTick: config.WORKER_MAX_PARALLEL_JOBS
    });
    const unreadResult = result.unreadReconciliation;
    const runtimeResult = result.runtimeReconciliation;
    const queueResult = result.triggerQueueProcessing;
    if (
      unreadResult.candidates.length > 0 ||
      runtimeResult.transitionedOffline > 0 ||
      queueResult.claimedJobs > 0
    ) {
      logger.info("tick.completed", {
        candidates: unreadResult.candidates.length,
        participants_scanned: unreadResult.stats.participantsScanned,
        deduplicated_participants: unreadResult.stats.deduplicatedParticipants,
        runtimes_checked: runtimeResult.checkedRuntimes,
        transitioned_offline: runtimeResult.transitionedOffline,
        jobs_claimed: queueResult.claimedJobs,
        delivered: queueResult.delivered,
        retried: queueResult.retried,
        fallback_resumed: queueResult.fallbackResumed,
        fallback_spawned: queueResult.fallbackSpawned,
        auto_blocked: queueResult.autoBlocked,
        dead_lettered: queueResult.deadLettered
      });
    } else {
      logger.info("tick.idle", {
        participants_scanned: unreadResult.stats.participantsScanned,
        runtimes_checked: runtimeResult.checkedRuntimes,
        jobs_claimed: queueResult.claimedJobs
      });
    }
  };

  const tick = (): void => {
    void runPollingTick().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown error";
      logger.error("tick.failed", {
        error: message
      });
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
        logger.error("shutdown.db_close_failed", {
          error: message
        });
      })
      .finally(() => {
        logger.info("shutdown.complete", {
          signal
        });
        process.exit(0);
      });
  };

  const intervalHandle = setInterval(tick, config.WORKER_POLL_INTERVAL_MS);
  void runPollingTick().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown error";
    logger.error("bootstrap.initial_tick_failed", {
      error: message
    });
  });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("bootstrap.complete", {
    workspace: config.WORKSPACE_ID,
    poll_interval_ms: config.WORKER_POLL_INTERVAL_MS
  });
} catch (error) {
  logger.error("config.invalid", {
    error: formatConfigValidationError(error)
  });
  process.exit(1);
}
