import type {
  UnreadReconciliationResult,
  UnreadReconciliationService
} from "./unread-reconciliation.js";
import type { ReconcileRuntimeResult, RuntimeRegistryService } from "./runtime-registry.js";

export interface SupervisorWorkerLoopResult {
  unreadReconciliation: UnreadReconciliationResult;
  runtimeReconciliation: ReconcileRuntimeResult;
}

export interface SupervisorWorkerLoopInput {
  workspaceId: string;
  staleAfterHours: number;
  tickAt?: Date;
}

export class SupervisorWorkerLoop {
  public constructor(
    private readonly unreadReconciliationService: Pick<UnreadReconciliationService, "reconcile">,
    private readonly runtimeRegistryService: Pick<
      RuntimeRegistryService,
      "reconcileWorkspaceRuntimes"
    >
  ) {}

  public async runTick(input: SupervisorWorkerLoopInput): Promise<SupervisorWorkerLoopResult> {
    const tickAt = input.tickAt ?? new Date();
    const unreadReconciliation = await this.unreadReconciliationService.reconcile({
      workspaceId: input.workspaceId,
      staleAfterHours: input.staleAfterHours,
      polledAt: tickAt
    });
    const runtimeReconciliation = await this.runtimeRegistryService.reconcileWorkspaceRuntimes({
      workspaceId: input.workspaceId,
      staleAfterHours: input.staleAfterHours,
      reconciledAt: tickAt
    });

    return {
      unreadReconciliation,
      runtimeReconciliation
    };
  }
}
