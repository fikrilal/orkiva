# SOLID + Architecture Boundary Review (WIP)

## Scope
- Reviewed architecture constraints from:
  - `docs/proposal/02-architecture/solution_architecture.md`
  - `docs/proposal/02-architecture/technical_stack_and_architecture.md`
  - `docs/proposal/03-runtime/process_level_trigger_design.md`
  - `docs/proposal/03-runtime/tmux_supervisor_implementation_spec.md`
- Reviewed implementation across:
  - `apps/supervisor-worker/src/*`
  - `apps/bridge-api/src/app.ts`
  - `packages/shared/src/config/env.ts`
  - `.dependency-cruiser.cjs`

## Findings

### 1) High: `supervisor-worker` directly mutates thread lifecycle state (cross-app responsibility bleed)
- Files:
  - `apps/supervisor-worker/src/trigger-queue.ts:840`
  - `apps/supervisor-worker/src/trigger-queue.ts:1404`
  - `apps/supervisor-worker/src/trigger-queue.ts:1411`
- Evidence:
  - `TriggerQueueProcessor` decides auto-block and directly calls `markThreadBlocked(...)`.
  - `DbTriggerQueueStore.markThreadBlocked(...)` updates `threads.status = "blocked"` directly in worker process.
- Why this is an architecture issue:
  - Architecture docs place thread lifecycle/domain authority in `bridge-api`; worker should execute triggers/fallbacks and record outcomes.
  - This creates dual write-authority over thread state and weakens boundary ownership.
- Impact:
  - Potential drift in policy enforcement and thread-state invariants.
  - Harder to reason about “single source of truth” for thread transitions.
- Suggested direction:
  - Move thread-block transition authority behind bridge API/domain path (e.g., explicit command/event path), keep worker as signal producer.

### 2) High: Mandatory trigger completion callback can be disabled by config shape
- Files:
  - `packages/shared/src/config/env.ts:63`
  - `apps/supervisor-worker/src/main.ts:49`
  - `apps/supervisor-worker/src/trigger-callback.ts:82`
- Evidence:
  - `WORKER_BRIDGE_ACCESS_TOKEN` is optional in config schema.
  - `main.ts` conditionally injects token.
  - `BridgeTriggerCallbackExecutor` returns non-retryable `CALLBACK_AUTH_TOKEN_MISSING` when token is absent.
- Why this is an architecture issue:
  - Runtime docs describe worker-owned completion callback as mandatory.
  - Current setup allows booting in a mode where callback delivery is guaranteed to fail.
- Impact:
  - Trigger lifecycle can end in callback dead-letter with no completion signal to bridge.
- Suggested direction:
  - Make callback auth token required for worker startup in environments where callback path is enabled/required.

### 3) Medium: Fallback module is coupled to tmux adapter module (DIP boundary leak)
- Files:
  - `apps/supervisor-worker/src/runtime-fallback.ts:10`
  - `apps/supervisor-worker/src/tmux-adapter.ts:11`
- Evidence:
  - `runtime-fallback.ts` imports `CommandExecutionInput` and `CommandExecutor` from `tmux-adapter.ts`.
- Why this is a SOLID/boundary issue:
  - Fallback behavior (`codex exec resume/spawn`) is runtime orchestration logic, not tmux-specific.
  - Importing its command port from tmux adapter inverts intended dependency direction.
- Impact:
  - Tight coupling between independent modules; harder to evolve fallback independently of tmux adapter details.
- Suggested direction:
  - Extract command execution port into a neutral module (e.g., `command-executor.ts`) owned by worker core.

### 4) Medium: `trigger-queue.ts` is a multi-responsibility mega-module
- Files:
  - `apps/supervisor-worker/src/trigger-queue.ts:359`
  - `apps/supervisor-worker/src/trigger-queue.ts:940`
  - `apps/supervisor-worker/src/trigger-queue.ts:1131`
- Evidence:
  - One file contains:
    - queue orchestration (`TriggerQueueProcessor`)
    - retry/backoff/rate-limiting/loop-guard policy
    - callback transition policy
    - in-memory store
    - DB store with SQL transitions
- Why this is a SOLID issue:
  - Violates SRP and increases change blast radius.
  - Domain policy and persistence adapter concerns are mixed.
- Impact:
  - Higher regression risk and lower test isolation.
- Suggested direction:
  - Split into:
    - policy/orchestration service
    - persistence ports
    - in-memory adapter
    - DB adapter

### 5) Medium: `bridge-api` app entrypoint is a God module
- File:
  - `apps/bridge-api/src/app.ts:437`
- Evidence:
  - Single file (~1150 LOC) handles auth hooks, error mapping, metrics/logging, protocol routing, and all MCP command business paths.
- Why this is a SOLID issue:
  - SRP/OCP pressure point; every new command or policy touches central module.
- Impact:
  - Harder to maintain and review; easier to introduce cross-command regressions.
- Suggested direction:
  - Split by vertical use-case (command handlers) and horizontal concerns (auth/error/telemetry middleware).

### 6) Medium: Unread dedupe state is process-memory only in production bootstrap
- Files:
  - `apps/supervisor-worker/src/main.ts:27`
  - `apps/supervisor-worker/src/unread-reconciliation.ts:234`
- Evidence:
  - Worker wiring uses `InMemoryUnreadReconciliationStateStore` for `markNotified` state.
- Why this is an architecture/reliability issue:
  - Restart resets dedupe state; behavior depends on process uptime.
- Impact:
  - Duplicate trigger scheduling after restart and weaker deterministic behavior.
- Suggested direction:
  - Persist dedupe/checkpoint state in DB, or derive it from durable trigger/job history.

### 7) Low: Boundary rules are not fully codified in static dependency checks
- File:
  - `.dependency-cruiser.cjs:11`
- Evidence:
  - Existing rules catch app-to-app and package-to-app violations, but do not encode key repo constraints such as:
    - tmux/process-control code only in `apps/supervisor-worker`
    - MCP transport surface only in `apps/bridge-api`
- Why this is an architecture governance issue:
  - Relies on manual discipline for critical boundaries.
- Impact:
  - Boundary drift risk increases over time.
- Suggested direction:
  - Add explicit dependency-cruiser rules for these two locked boundaries.

## Summary
- Main risks are boundary ownership drift (thread lifecycle writes from worker), mandatory callback contract fragility, and large SRP violations concentrated in `trigger-queue.ts` and `app.ts`.
