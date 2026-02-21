import { createDb, createDbPool } from "@orkiva/db";
import { createJsonLogger } from "@orkiva/observability";
import { formatConfigValidationError, loadSupervisorWorkerConfig } from "@orkiva/shared";

import { DbRuntimeRegistryStore, RuntimeRegistryService } from "./runtime-registry.js";
import { BridgeTriggerCallbackExecutor } from "./trigger-callback.js";
import { CodexFallbackExecutor } from "./runtime-fallback.js";
import { ManagedRuntimeTriggerJobExecutor } from "./runtime-trigger-executor.js";
import { NodeCommandExecutor, TmuxTriggerPtyAdapter } from "./tmux-adapter.js";
import { DbTriggerQueueStore, TriggerQueueProcessor } from "./trigger-queue.js";
import {
  DbUnreadReconciliationSnapshotStore,
  InMemoryUnreadReconciliationStateStore,
  UnreadReconciliationService
} from "./unread-reconciliation.js";
import { UnreadTriggerJobScheduler } from "./unread-trigger-jobs.js";
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
  const triggerQueueStore = new DbTriggerQueueStore(db);
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
    crashLoopWindowMs: 15 * 60 * 1000,
    allowDangerousBypass: config.WORKER_FALLBACK_ALLOW_DANGEROUS_BYPASS
  });
  const callbackExecutor = new BridgeTriggerCallbackExecutor({
    bridgeApiBaseUrl: config.WORKER_BRIDGE_API_BASE_URL,
    ...(config.WORKER_BRIDGE_ACCESS_TOKEN === undefined
      ? {}
      : { accessToken: config.WORKER_BRIDGE_ACCESS_TOKEN }),
    requestTimeoutMs: config.WORKER_CALLBACK_REQUEST_TIMEOUT_MS
  });
  const triggerQueueProcessor = new TriggerQueueProcessor(
    triggerQueueStore,
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
    logger,
    config.TRIGGER_ACK_TIMEOUT_MS,
    config.TRIGGERING_LEASE_TIMEOUT_MS,
    config.WORKER_CALLBACK_MAX_RETRIES,
    callbackExecutor,
    config.WORKER_MIN_JOB_CREATED_AT,
    config.WORKER_FALLBACK_EXEC_TIMEOUT_MS,
    config.WORKER_FALLBACK_KILL_GRACE_MS,
    config.WORKER_FALLBACK_MAX_ACTIVE_GLOBAL,
    config.WORKER_FALLBACK_MAX_ACTIVE_PER_AGENT
  );
  const workerLoop = new SupervisorWorkerLoop(
    reconciliationService,
    new UnreadTriggerJobScheduler(triggerQueueStore, {
      maxTriggersPerWindow: config.AUTO_UNREAD_MAX_TRIGGERS_PER_WINDOW,
      windowMs: config.AUTO_UNREAD_WINDOW_MS,
      minIntervalMs: config.AUTO_UNREAD_MIN_INTERVAL_MS,
      breakerBacklogThreshold: config.AUTO_UNREAD_BREAKER_BACKLOG_THRESHOLD,
      breakerCooldownMs: config.AUTO_UNREAD_BREAKER_COOLDOWN_MS
    }),
    runtimeRegistryService,
    triggerQueueStore,
    triggerQueueProcessor
  );

  const runPollingTick = async (): Promise<void> => {
    const result = await workerLoop.runTick({
      workspaceId: config.WORKSPACE_ID,
      staleAfterHours: config.SESSION_STALE_AFTER_HOURS,
      triggerMaxRetries: config.TRIGGER_MAX_RETRIES,
      maxJobsPerTick: config.WORKER_MAX_PARALLEL_JOBS,
      autoUnreadEnabled: config.AUTO_UNREAD_ENABLED
    });
    const unreadResult = result.unreadReconciliation;
    const unreadTriggerScheduling = result.unreadTriggerScheduling;
    const runtimeResult = result.runtimeReconciliation;
    const queueResult = result.triggerQueueProcessing;
    if (
      unreadResult.candidates.length > 0 ||
      unreadTriggerScheduling.enqueued > 0 ||
      runtimeResult.transitionedOffline > 0 ||
      queueResult.claimedJobs > 0
    ) {
      logger.info("tick.completed", {
        candidates: unreadResult.candidates.length,
        unread_triggers_enqueued: unreadTriggerScheduling.enqueued,
        unread_triggers_skipped_pending: unreadTriggerScheduling.skippedPending,
        unread_triggers_reused_existing: unreadTriggerScheduling.reusedExisting,
        unread_triggers_suppressed_budget: unreadTriggerScheduling.suppressedByBudget,
        unread_triggers_suppressed_breaker: unreadTriggerScheduling.suppressedByBreaker,
        unread_trigger_breaker_open: unreadTriggerScheduling.breakerOpen,
        pending_jobs: unreadTriggerScheduling.pendingJobs,
        participants_scanned: unreadResult.stats.participantsScanned,
        deduplicated_participants: unreadResult.stats.deduplicatedParticipants,
        runtimes_checked: runtimeResult.checkedRuntimes,
        transitioned_offline: runtimeResult.transitionedOffline,
        jobs_claimed: queueResult.claimedJobs,
        delivered: queueResult.delivered,
        retried: queueResult.retried,
        fallback_resumed: queueResult.fallbackResumed,
        fallback_spawned: queueResult.fallbackSpawned,
        callback_delivered: queueResult.callbackDelivered,
        callback_retried: queueResult.callbackRetried,
        callback_failed: queueResult.callbackFailed,
        fallback_runs_scanned: queueResult.fallbackRunsScanned,
        fallback_runs_queued_for_completion: queueResult.fallbackRunsQueuedForCompletion,
        fallback_runs_timed_out: queueResult.fallbackRunsTimedOut,
        fallback_runs_killed: queueResult.fallbackRunsKilled,
        fallback_runs_orphaned: queueResult.fallbackRunsOrphaned,
        auto_blocked: queueResult.autoBlocked,
        dead_lettered: queueResult.deadLettered
      });
    } else {
      logger.info("tick.idle", {
        participants_scanned: unreadResult.stats.participantsScanned,
        unread_triggers_enqueued: unreadTriggerScheduling.enqueued,
        unread_trigger_breaker_open: unreadTriggerScheduling.breakerOpen,
        pending_jobs: unreadTriggerScheduling.pendingJobs,
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
    poll_interval_ms: config.WORKER_POLL_INTERVAL_MS,
    auto_unread_enabled: config.AUTO_UNREAD_ENABLED,
    worker_min_job_created_at:
      config.WORKER_MIN_JOB_CREATED_AT === undefined
        ? null
        : config.WORKER_MIN_JOB_CREATED_AT.toISOString(),
    worker_fallback_exec_timeout_ms: config.WORKER_FALLBACK_EXEC_TIMEOUT_MS,
    worker_fallback_kill_grace_ms: config.WORKER_FALLBACK_KILL_GRACE_MS,
    worker_fallback_max_active_global: config.WORKER_FALLBACK_MAX_ACTIVE_GLOBAL,
    worker_fallback_max_active_per_agent: config.WORKER_FALLBACK_MAX_ACTIVE_PER_AGENT
  });
} catch (error) {
  logger.error("config.invalid", {
    error: formatConfigValidationError(error)
  });
  process.exit(1);
}
