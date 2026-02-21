# Reliability Review Report (supervisor-worker)

## Scope
- Focus areas reviewed: test coverage, determinism, retries/timeouts, idempotency, and observability.
- Code paths reviewed: queue processing, runtime trigger execution, fallback executor, callback delivery, scheduler/reconciliation, worker loop bootstrap.

## Checks run
- `pnpm test` (pass)
- `pnpm typecheck` (pass)
- `pnpm lint` (pass)

## Findings

### 1) High: Callback retries reuse one idempotency key but mutate payload across attempts
- Evidence:
  - Static key: `src/trigger-callback.ts:119`
  - Per-attempt mutable metadata in same payload: `src/trigger-callback.ts:116`, `src/trigger-callback.ts:117`
- Why this is risky:
  - Retries with the same idempotency key should send the same logical payload. Here `finished_at` and `callback_attempt_no` change each attempt, which can cause `409` idempotency conflicts or inconsistent dedupe behavior on the bridge side.
  - Current retry classifier treats `409` as retryable (`src/trigger-callback.ts:23-24`), which can repeatedly defer and still end as `callback_failed` even if the first call was actually accepted.
- Actionable fix:
  - Keep callback payload stable for a given `trigger_id` (remove attempt-varying fields from remote payload, or derive deterministic values once and persist them).
  - Keep `callback_attempt_no` in local attempt details only.
  - Revisit `409` handling to distinguish idempotent replay success vs true conflict.
- Test gap:
  - Add a test that executes callback twice with same job and verifies request body is byte-stable for the same idempotency key.

### 2) High: Timeout handling does not cancel in-flight work
- Evidence:
  - Timeout wrapper uses `Promise.race` without cancelling underlying task: `src/trigger-queue.ts:491-511`
  - Process execution has no cancellation/kill path: `src/tmux-adapter.ts:33-56`
  - Fallback runs external `codex exec` commands that can outlive queue timeout: `src/runtime-fallback.ts:96-125`, `src/runtime-fallback.ts:145-190`
- Why this is risky:
  - After queue timeout, the underlying operation may still complete and produce side effects (late resume/spawn/injection), creating duplicate or out-of-order behavior.
- Actionable fix:
  - Plumb `AbortSignal` through executor/fallback/callback interfaces.
  - On timeout, terminate child processes (`SIGTERM` then bounded `SIGKILL`) and mark outcome deterministically.
  - Ensure adapter/fallback implementations are cancellation-aware.
- Test gap:
  - Add a test with a long-running command that verifies process termination on timeout and no late side effects.

### 3) Medium: Claim order is not fully deterministic when `createdAt` ties
- Evidence:
  - In-memory sorting only by `createdAt`: `src/trigger-queue.ts:1000-1004`
  - DB ordering only by `createdAt`: `src/trigger-queue.ts:1229`
- Why this is risky:
  - Many jobs are created with the same timestamp in one tick; tie-order then depends on insertion/physical order.
  - This can change rate-limit outcomes and loop-guard progression between runs.
- Actionable fix:
  - Use a stable secondary key (e.g. `triggerId`) in both in-memory and DB claim ordering.
- Test gap:
  - Add deterministic-order test with same `createdAt` across jobs, asserting stable processing order.

### 4) Medium: DB attempt row can be inserted even when state transition fails
- Evidence:
  - Transaction inserts into `trigger_attempts` before verifying `trigger_jobs.status='triggering'`: `src/trigger-queue.ts:1292-1312`
- Why this is risky:
  - If update affects zero rows (stale state/race/manual status change), attempt history can contain records without corresponding job transition.
  - This degrades audit correctness and can complicate retries.
- Actionable fix:
  - Perform conditional update first; only insert attempt if update succeeded.
  - Prefer one SQL statement/CTE for atomic “transition + attempt insert”.
- Test gap:
  - Add DB integration test asserting no attempt row is written when job is not in `triggering` status.

### 5) Medium: Critical safeguards are memory-only and reset on worker restart
- Evidence:
  - Queue safeguards tracked in-memory only: `src/trigger-queue.ts:360-368`
  - Fallback crash-loop memory is in-process only: `src/runtime-fallback.ts:31`, `src/runtime-fallback.ts:71-76`, `src/runtime-fallback.ts:90-94`
- Why this is risky:
  - Restarting the worker resets rate-limits, loop-guard counters, and crash-loop suppression, allowing repeated trigger storms or resumed loops.
- Actionable fix:
  - Persist safeguard state (or derive from recent `trigger_attempts`) keyed by workspace/thread/agent.
  - Warm in-memory cache from DB on startup if full persistence is deferred.
- Test gap:
  - Add restart simulation test proving safeguards still hold after processor re-instantiation.

### 6) Low: Observability is mostly log-based; no explicit trigger reliability metrics
- Evidence:
  - Structured logs exist (`src/main.ts:97-116`, `src/trigger-queue.ts:641-646`, `src/trigger-queue.ts:884-890`), but no counters/histograms for trigger latency, timeouts, fallback rate, callback retry exhaustion.
- Why this is risky:
  - Harder to enforce SLOs and detect regressions quickly in production.
- Actionable fix:
  - Emit explicit metrics per phase (`executor`, `fallback`, `callback`) for attempts, success/failure class, timeout, and latency.
  - Include labels for `error_code`, `result`, and `workspace_id` (bounded-cardinality policy).

## Test coverage notes
- Existing unit coverage is solid for happy/error paths in core services.
- Current suite is heavily in-memory and mock-driven (for example `src/trigger-queue.test.ts:7`, `src/trigger-queue.test.ts:52`), with no DB-backed concurrency/transition invariants.
- Highest-value additions are integration tests around DB transition correctness and idempotent callback replay semantics.
