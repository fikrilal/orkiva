import type {
  UnreadReconciliationResult,
  UnreadReconciliationService
} from "./unread-reconciliation.js";
import type { ReconcileRuntimeResult, RuntimeRegistryService } from "./runtime-registry.js";
import type { TriggerQueueProcessingResult, TriggerQueueStore } from "./trigger-queue.js";
import type {
  ScheduleUnreadCandidatesResult,
  UnreadTriggerJobScheduler
} from "./unread-trigger-jobs.js";

export interface SupervisorWorkerLoopResult {
  unreadReconciliation: UnreadReconciliationResult;
  unreadTriggerScheduling: ScheduleUnreadCandidatesResult;
  runtimeReconciliation: ReconcileRuntimeResult;
  triggerQueueProcessing: TriggerQueueProcessingResult;
}

export interface SupervisorWorkerLoopInput {
  workspaceId: string;
  staleAfterHours: number;
  triggerMaxRetries: number;
  maxJobsPerTick: number;
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
      processDueJobs: (input: {
        workspaceId: string;
        limit: number;
        processedAt: Date;
      }) => Promise<TriggerQueueProcessingResult>;
    }
  ) {}

  public async runTick(input: SupervisorWorkerLoopInput): Promise<SupervisorWorkerLoopResult> {
    const tickAt = input.tickAt ?? new Date();
    const unreadReconciliation = await this.unreadReconciliationService.reconcile({
      workspaceId: input.workspaceId,
      staleAfterHours: input.staleAfterHours,
      polledAt: tickAt
    });
    const pendingJobs = await this.triggerQueueBacklogStore.countPendingJobs({
      workspaceId: input.workspaceId
    });
    const unreadTriggerScheduling = await this.unreadTriggerJobScheduler.schedule({
      workspaceId: input.workspaceId,
      candidates: unreadReconciliation.candidates,
      triggerMaxRetries: input.triggerMaxRetries,
      pendingJobs,
      scheduledAt: tickAt
    });
    const runtimeReconciliation = await this.runtimeRegistryService.reconcileWorkspaceRuntimes({
      workspaceId: input.workspaceId,
      staleAfterHours: input.staleAfterHours,
      reconciledAt: tickAt
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
      triggerQueueProcessing
    };
  }
}
