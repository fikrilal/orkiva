# Proposal: Dev-Safe Worker Startup and Queue Guardrails

## 1. Problem

Worker startup replays persisted pending jobs (`fallback_spawn`, `fallback_resume`, `callback_pending`, `queued`) from previous sessions.
In local development, that re-triggers `codex exec` and callback traffic, causing unexpected token spend.

This is not a JWT leak; it is expected queue replay behavior with stale test backlog.

## 2. Goals

1. Prevent old backlog from auto-executing during local startup.
2. Allow explicit fresh-start behavior for the worker.
3. Make auto-unread fanout easy to disable in development.
4. Provide safe reset tooling for local workspace state.
5. Keep production default behavior unchanged.

## 3. Design

### A. Startup backlog cutoff (worker claim guard)

Add optional config:

- `WORKER_MIN_JOB_CREATED_AT` (ISO datetime, optional)

Behavior:

- `claimDueJobs` only claims jobs with `created_at >= WORKER_MIN_JOB_CREATED_AT` when set.
- If unset, behavior remains unchanged.

Add convenience command:

- `pnpm run dev:supervisor-worker:fresh`
- Sets `WORKER_MIN_JOB_CREATED_AT` to current UTC timestamp and starts worker.

Result: worker startup no longer replays historical queue by default in fresh mode.

### B. Auto-unread toggle (dev fanout guard)

Add config:

- `AUTO_UNREAD_ENABLED` (boolean, default `true`)

Behavior:

- If `false`, worker skips unread reconciliation and unread-trigger scheduling.
- Existing queued jobs still process (subject to cutoff).
- Manual `trigger_participant` remains available.

Result: background auto-fanout can be disabled during local testing.

### C. Dev queue reset tool (explicit cleanup)

Add command:

- `pnpm run dev:queue:reset -- --workspace-id <id> [--dry-run] [--apply]`

Default mode:

- `--dry-run` summary counts by status and target agent.

`--apply` mode:

- Transition pending statuses:
  - `queued|triggering|deferred|timeout|fallback_resume|fallback_spawn -> failed`
  - `callback_pending|callback_retry -> callback_failed`
- Scoped by `workspace_id` only.

Result: deterministic cleanup without silent deletes.

### D. Dev profile wrapper

Add one command for daily usage:

- `pnpm run dev:stack:safe`

Behavior:

1. Ensure `.env.dev-auth` exists.
2. Start `bridge-api`.
3. Start worker with:
   - `AUTO_UNREAD_ENABLED=false`
   - `WORKER_MIN_JOB_CREATED_AT=<startup time>`

Result: predictable local startup with minimal unexpected token usage.

## 4. Validation Plan

1. Seed old pending jobs in DB (timestamps before startup).
2. Start worker with fresh mode.
3. Assert:
   - old jobs are not claimed,
   - no `fallback_spawned` attempts from historical jobs,
   - no unexpected `codex exec` process surge.
4. Enable manual trigger and verify single expected execution.
5. Run reset command dry-run plus apply and verify status transitions.

## 5. Acceptance Criteria

1. Worker restart in safe mode does not execute historical pending jobs.
2. `AUTO_UNREAD_ENABLED=false` prevents new auto-unread trigger job creation.
3. Reset command is workspace-scoped and explicit (`--apply` required).
4. Production behavior is unchanged when new configs are not set.
5. Docs are updated with safe local workflow.

## 6. Files to Change

- `packages/shared/src/config/env.ts`
- `packages/shared/test/env-config.test.ts`
- `apps/supervisor-worker/src/trigger-queue.ts`
- `apps/supervisor-worker/src/trigger-queue.test.ts`
- `apps/supervisor-worker/src/worker-loop.ts`
- `apps/supervisor-worker/src/worker-loop.test.ts`
- `apps/supervisor-worker/src/main.ts`
- `apps/supervisor-worker/package.json`
- `package.json` (root scripts)
- `infra/scripts/dev-queue-reset.ts` (new)
- `infra/scripts/dev-stack-safe.sh` (new)
- `.env.example`
- `README.md`
- `docs/proposal/06-operations/rollout_and_operations.md`
