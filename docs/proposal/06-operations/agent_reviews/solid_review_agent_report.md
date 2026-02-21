# SOLID Review Report (Supervisor Worker)

## Scope
Review focus:
- Single Responsibility Principle (SRP)
- Dependency boundaries
- Composition-over-inheritance

Reviewed area:
- `apps/supervisor-worker/src`
- Relevant architecture/runtime docs under `docs/proposal`

## Findings

### 1. High: Queue orchestration, loop policy, callback flow, and persistence adapters are collapsed into one module
- Evidence:
  - `apps/supervisor-worker/src/trigger-queue.ts:1` (DB imports at top-level)
  - `apps/supervisor-worker/src/trigger-queue.ts:359` (`TriggerQueueProcessor`)
  - `apps/supervisor-worker/src/trigger-queue.ts:940` (`InMemoryTriggerQueueStore`)
  - `apps/supervisor-worker/src/trigger-queue.ts:1131` (`DbTriggerQueueStore`)
- Why this is a boundary/SRP issue:
  - One file owns policy decisions, retry/backoff behavior, callback orchestration, loop safeguards, and DB adapter implementations.
  - This blurs domain/application/infrastructure boundaries and raises change-coupling risk.
- Actionable fix:
  - Split into modules with explicit ports:
    1. `queue/processor.ts` (pure orchestration + policy)
    2. `queue/policy.ts` (rate limit + loop guard)
    3. `queue/store.port.ts` (interfaces + records)
    4. `queue/store.db.ts` and `queue/store.memory.ts` (adapters)
  - Keep `processor` importing only port types, not DB tables or Drizzle operators.

### 2. High: Fallback flow depends on tmux adapter module for a generic command abstraction
- Evidence:
  - `apps/supervisor-worker/src/runtime-fallback.ts:10` imports `CommandExecutionInput` and `CommandExecutor` from `apps/supervisor-worker/src/tmux-adapter.ts`
- Why this is a boundary issue:
  - `fallback` should be independent from a specific PTY adapter module.
  - Current dependency direction couples fallback behavior to tmux adapter internals and makes adapter replacement harder.
- Actionable fix:
  - Extract process execution port into a neutral module, e.g. `apps/supervisor-worker/src/process/command-executor.ts`.
  - Have both `runtime-fallback.ts` and `tmux-adapter.ts` depend on that shared port, not on each other.

### 3. Medium: `UnreadReconciliationService` uses domain type indirectly via synthetic placeholder objects
- Evidence:
  - `apps/supervisor-worker/src/unread-reconciliation.ts:95`
  - `apps/supervisor-worker/src/unread-reconciliation.ts:172`
- Why this is an SRP/boundary issue:
  - Reconciliation builds fake `SessionRecord` values (`agentId: "n/a"`, `runtime: "n/a"`) just to call `isSessionStale`.
  - This indicates the domain API is not aligned with the service’s actual data shape (`SessionSnapshot`), and service logic is compensating.
- Actionable fix:
  - Add a domain helper that accepts a minimal snapshot shape for staleness checks (or a dedicated value object).
  - Remove placeholder object construction from reconciliation service.

### 4. Medium: Timeout wrapper does not cancel in-flight execution, which weakens composition contracts
- Evidence:
  - `apps/supervisor-worker/src/trigger-queue.ts:491` (`runWithTimeout` uses `Promise.race`)
  - Executor/callback/fallback invocations:
    - `apps/supervisor-worker/src/trigger-queue.ts:649`
    - `apps/supervisor-worker/src/trigger-queue.ts:746`
    - `apps/supervisor-worker/src/trigger-queue.ts:793`
- Why this matters architecturally:
  - The timed-out operation can still complete and side-effect after the processor has moved to retry/fallback paths.
  - This can produce duplicate deliveries or inconsistent state transitions under load.
- Actionable fix:
  - Extend executor/fallback/callback ports to accept `AbortSignal`.
  - Propagate cancellation into adapters (`fetch`, child-process wrappers where possible).
  - Treat timeout as cancellation-first, not only "ignore late completion".

### 5. Medium: Loop-block reason is computed but dropped by DB store implementation
- Evidence:
  - Reason generated and passed: `apps/supervisor-worker/src/trigger-queue.ts:844`
  - Reason ignored: `apps/supervisor-worker/src/trigger-queue.ts:1409`
- Why this is a boundary/SRP issue:
  - Loop-governance decision and persistence are disconnected; the store interface accepts a reason but DB adapter discards it.
  - This undermines auditability and makes governance behavior opaque.
- Actionable fix:
  - Persist block reason in a dedicated audit/event table (or thread metadata field if contract already allows it).
  - Keep store contract aligned with persisted behavior (remove unused arg only if reason is intentionally not persisted, and document that decision).

## Composition-over-inheritance assessment
- No inheritance-heavy design issues found.
- The codebase mostly uses composition via constructor-injected interfaces (`TriggerJobExecutor`, `TriggerFallbackExecutor`, stores, adapters), which is the right direction.
- Main issue is not inheritance, but coarse-grained composition units (modules/classes that own too many responsibilities).

## Suggested refactor order (low-risk sequence)
1. Extract `CommandExecutor` port into neutral `process` module.
2. Split `trigger-queue.ts` into port + processor + adapters without changing behavior.
3. Add cancellable executor contracts (`AbortSignal`) and wire through timeout paths.
4. Align staleness domain API with `SessionSnapshot`.
5. Persist loop block reason for auditability.
