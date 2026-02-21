# Quality Agent Report: `apps/supervisor-worker`

## Scope
- Reviewed unit/integration tests under `apps/supervisor-worker/src/*.test.ts`.
- Reviewed implementation paths for queue processing, fallback execution, callback delivery, unread reconciliation, tmux adapter, and runtime registry.
- Ran tests:
  - `pnpm test`
  - `pnpm test -- --coverage`

## Overall Assessment
- Current unit coverage is strong for happy paths and several failure branches.
- Highest remaining risk is not branch count, but **missing integration/contract coverage** on DB-backed stores and callback retry state-machine behavior.
- There are also reliability blind spots around restart behavior and clock-driven logic.

## Prioritized Issues

### P1 - No DB-backed integration tests for core store behavior (high reliability risk)
Evidence:
- Complex DB logic is in production paths but tests only exercise in-memory stores.
- `src/trigger-queue.ts:1131` (`DbTriggerQueueStore`) has concurrency/transition semantics not covered by `src/trigger-queue.test.ts` (in-memory only).
- `src/runtime-registry.ts:138` (`DbRuntimeRegistryStore`) has heartbeat ordering logic (`lt(lastHeartbeatAt, ...)`) not covered by `src/runtime-registry.test.ts:1`.
- `src/unread-reconciliation.ts:262` (`DbUnreadReconciliationSnapshotStore`) has query filtering/joins and `suppress_auto_trigger` SQL filtering not covered by `src/unread-reconciliation.test.ts:1`.

Suggested tests:
- Add DB integration tests (similar pattern to bridge API DB integration tests) for:
  - concurrent `claimDueJobs` calls: exactly one claimer wins.
  - `recordAttemptAndTransition` atomicity: attempt row + job status update are consistent.
  - heartbeat ordering: stale heartbeat cannot overwrite newer session state.
  - unread snapshot query: suppressed auto-trigger events are excluded from latest sequence.

### P1 - Callback retry state machine is only partially tested
Evidence:
- Callback path in processor has non-trivial retry transitions and counters at `src/trigger-queue.ts:645`-`734`.
- Tests cover callback success and a terminal callback failure (`src/trigger-queue.test.ts:516`), but not `callback_post_deferred` / retry scheduling.
- Executor can produce deferred with `retry-after` and network/timeout errors at `src/trigger-callback.ts:148`-`185`, but processor-level retry behavior for those outcomes is not validated.

Suggested tests:
- Processor test: `callback_post_deferred` with explicit `retryAfterMs` transitions to `callback_retry` and schedules exact retry time.
- Processor test: deferred without `retryAfterMs` uses exponential backoff.
- Processor test: retries exhausted transitions to `callback_failed` and increments dead-letter counters.
- Processor test: callback timeout/exception path (`TRIGGER_CALLBACK_TIMEOUT`, `TRIGGER_CALLBACK_EXCEPTION`) classification and persistence.

### P1 - Dedupe state is volatile across worker restarts (reliability concern) and untested
Evidence:
- Production wiring uses `InMemoryUnreadReconciliationStateStore` in `src/main.ts:27`-`30`.
- Dedupe behavior is tested only within one process lifetime in `src/unread-reconciliation.test.ts:167`.
- Restarting the worker clears notified state, potentially re-triggering unchanged unread work.

Suggested tests:
- Integration test that simulates worker restart and verifies whether dedupe survives (expected behavior should be explicitly decided and asserted).
- If behavior should persist, introduce a persistent state store and add DB integration coverage.

### P2 - Fallback decision matrix has untested branches
Evidence:
- `CodexFallbackExecutor` has several decision paths in `src/runtime-fallback.ts:39`-`88`:
  - `NO_TARGET_SESSION`, `RUNTIME_NOT_FOUND`, `RUNTIME_SESSION_MISMATCH`, `CRASH_LOOP_SHORTCUT`.
- Tests only cover success, stale-session spawn, and resume->spawn failure (`src/runtime-fallback.test.ts:46`-`173`).
- `startCommand` blocking mode (`commandExecutor.run` path) at `src/runtime-fallback.ts:124`-`142` is untested.

Suggested tests:
- Table-driven tests for each `canAttemptResume.reason` and expected action.
- Test crash-loop shortcut after repeated resume failures.
- Test executor behavior when `startDetached` is unavailable (blocking mode).

### P2 - Quiet-window short-circuit branch in runtime trigger executor is not directly verified
Evidence:
- Executor has pre-delivery defer gate from `lastBusyAtByRuntime` at `src/runtime-trigger-executor.ts:217`-`259`.
- Existing tests cover adapter-reported `OPERATOR_BUSY` and override behavior (`src/runtime-trigger-executor.test.ts:264`, `src/runtime-trigger-executor.test.ts:336`) but do not assert that this pre-check can defer **without calling adapter**.

Suggested tests:
- First attempt returns `OPERATOR_BUSY` and stores busy timestamp.
- Second attempt inside quiet window returns deferred and asserts `deliver` was not called.
- Attempt after quiet window calls adapter again and can deliver.

### P3 - Clock-sensitive callback parsing has deterministic test gaps
Evidence:
- `parseRetryAfterMs` uses `Date.now()` for HTTP-date header parsing (`src/trigger-callback.ts:36`-`39`).
- Tests cover numeric retry-after only (`src/trigger-callback.test.ts:111`-`143`), not HTTP-date format.

Suggested tests:
- Add tests with fake timers (`vi.setSystemTime`) for HTTP-date `retry-after` parsing.
- Validate `retryAfterMs` clamps behavior around past/future header dates.

## Recommended Next Test Additions (Execution Order)
1. DB integration suite for `DbTriggerQueueStore`, `DbRuntimeRegistryStore`, `DbUnreadReconciliationSnapshotStore`.
2. Callback retry/dead-letter state-machine tests in `TriggerQueueProcessor`.
3. Restart/dedupe behavior test for reconciliation state.
4. Fallback decision matrix (all skip reasons + crash-loop + blocking launch mode).
5. Quiet-window short-circuit unit tests.
6. Retry-after HTTP-date deterministic tests.

## Notes on Flaky Risk
- Current suite is mostly deterministic (fixed timestamps, mocked dependencies).
- Remaining flaky risk is primarily around real clock/time parsing and untested timeout/retry boundary paths.
