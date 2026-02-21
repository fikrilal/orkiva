import type {
  UnreadReconciliationResult,
  UnreadReconciliationService
} from "./unread-reconciliation.js";
import type { ReconcileRuntimeResult, RuntimeRegistryService } from "./runtime-registry.js";
import type {
  FallbackRunReconciliationResult,
  TriggerQueueProcessingResult,
  TriggerQueueStore
} from "./trigger-queue.js";
import type {
  ScheduleUnreadCandidatesResult,
  UnreadTriggerJobScheduler
} from "./unread-trigger-jobs.js";

export interface SupervisorWorkerLoopResult {
  unreadReconciliation: UnreadReconciliationResult;
  unreadTriggerScheduling: ScheduleUnreadCandidatesResult;
  runtimeReconciliation: ReconcileRuntimeResult;
  triggerQueueProcessing: TriggerQueueProcessingResult;
  fallbackRunReconciliation: FallbackRunReconciliationResult;
}

export interface SupervisorWorkerLoopInput {
  workspaceId: string;
  staleAfterHours: number;
  triggerMaxRetries: number;
  maxJobsPerTick: number;
  autoUnreadEnabled?: boolean;
  tickAt?: Date;
}

export class SupervisorWorkerLoop {
  public constructor(
    private readonly unreadReconciliationService: Pick<UnreadReconciliationService, "reconcile">,
    private readonly unreadTriggerJobScheduler: Pick<UnreadTriggerJobScheduler, "schedule">,
    private readonly runtimeRegistryService: Pick<
      RuntimeRegistryService,
      "reconcileWorkspaceRuntimes"
    >,
    private readonly triggerQueueBacklogStore: Pick<TriggerQueueStore, "countPendingJobs">,
    private readonly triggerQueueProcessor: {
      reconcileFallbackRuns: (input: {
        workspaceId: string;
        limit: number;
        processedAt: Date;
      }) => Promise<FallbackRunReconciliationResult>;
      processDueJobs: (input: {
        workspaceId: string;
        limit: number;
        processedAt: Date;
      }) => Promise<TriggerQueueProcessingResult>;
    }
  ) {}

  public async runTick(input: SupervisorWorkerLoopInput): Promise<SupervisorWorkerLoopResult> {
    const tickAt = input.tickAt ?? new Date();
    const autoUnreadEnabled = input.autoUnreadEnabled ?? true;
    const unreadReconciliation = autoUnreadEnabled
      ? await this.unreadReconciliationService.reconcile({
          workspaceId: input.workspaceId,
          staleAfterHours: input.staleAfterHours,
          polledAt: tickAt
        })
      : {
          workspaceId: input.workspaceId,
          polledAt: tickAt,
          candidates: [],
          stats: {
            participantsScanned: 0,
            unreadParticipants: 0,
            dormantUnreadParticipants: 0,
            deduplicatedParticipants: 0
          }
        };
    const pendingJobs = autoUnreadEnabled
      ? await this.triggerQueueBacklogStore.countPendingJobs({
          workspaceId: input.workspaceId
        })
      : 0;
    const unreadTriggerScheduling = autoUnreadEnabled
      ? await this.unreadTriggerJobScheduler.schedule({
          workspaceId: input.workspaceId,
          candidates: unreadReconciliation.candidates,
          triggerMaxRetries: input.triggerMaxRetries,
          pendingJobs,
          scheduledAt: tickAt
        })
      : {
          workspaceId: input.workspaceId,
          scheduledAt: tickAt,
          candidates: 0,
          enqueued: 0,
          skippedPending: 0,
          reusedExisting: 0,
          suppressedByBudget: 0,
          suppressedByBreaker: 0,
          breakerOpen: false,
          pendingJobs
        };
    const runtimeReconciliation = await this.runtimeRegistryService.reconcileWorkspaceRuntimes({
      workspaceId: input.workspaceId,
      staleAfterHours: input.staleAfterHours,
      reconciledAt: tickAt
    });
    const fallbackRunReconciliation = await this.triggerQueueProcessor.reconcileFallbackRuns({
      workspaceId: input.workspaceId,
      limit: input.maxJobsPerTick,
      processedAt: tickAt
    });
    const triggerQueueProcessing = await this.triggerQueueProcessor.processDueJobs({
      workspaceId: input.workspaceId,
      limit: input.maxJobsPerTick,
      processedAt: tickAt
    });

    return {
      unreadReconciliation,
      unreadTriggerScheduling,
      runtimeReconciliation,
      triggerQueueProcessing: {
        ...triggerQueueProcessing,
        fallbackRunsScanned: fallbackRunReconciliation.scanned,
        fallbackRunsQueuedForCompletion: fallbackRunReconciliation.queuedForCompletion,
        fallbackRunsTimedOut: fallbackRunReconciliation.timedOut,
        fallbackRunsKilled: fallbackRunReconciliation.killed,
        fallbackRunsOrphaned: fallbackRunReconciliation.orphaned
      },
      fallbackRunReconciliation
    };
  }
}
