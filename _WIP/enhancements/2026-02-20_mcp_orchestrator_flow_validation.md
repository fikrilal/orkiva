# MCP Orchestrator Flow Validation - 2026-02-20

## Scope
- Validate live MCP orchestrator flow through `bridge-api` and `supervisor-worker`.
- Use MCP methods only (`create_thread`, `post_message`, `read_messages`, `ack_read`, `update_thread_status`, `summarize_thread`, `heartbeat_session`, `trigger_participant`).
- Validate downstream trigger job processing and fallback behavior.

## Matrix Status
- API-level matrix: **PASS (20/20 cases)**.
- Runtime downstream processing: **PARTIAL PASS WITH ISSUES**.

## Issue 01: Trigger jobs can get stuck in `triggering` with no attempt record
### Evidence
- Trigger jobs moved from `queued` to `triggering`.
- No `trigger_attempts` rows created for those jobs.
- Worker log shows `trigger.job.claimed`, then no corresponding `trigger.attempt.recorded`.

### Repro summary
1. Create thread + managed participant session via MCP.
2. Call `trigger_participant` (managed path), job created as `queued`.
3. Run worker tick.
4. Observe job transitions to `triggering` but no attempt row written.

### Suspected root cause
- `TriggerQueueProcessor.processDueJobs` does not guard `executor.execute` / `fallbackExecutor.execute` with timeout/error boundary.
- If fallback command path hangs (for example `codex exec resume`/`codex exec`), processing can stall before `recordAttemptAndTransition`.

### Proposed tweak
- Add timeout + exception guard around executor and fallback calls.
- Convert unexpected exceptions/timeouts into deterministic outcomes and always persist attempt transition.

### Risk
- Without this, one stuck trigger can block queue progression and leave jobs indefinitely in `triggering`.

## Issue 02: `fallback_resume` / `fallback_spawn` jobs were never claimed
### Evidence
- `trigger_participant` returned `fallback_required` and persisted jobs with status `fallback_spawn` / `fallback_resume`.
- Worker polls showed `jobs_claimed: 0` repeatedly while those jobs remained pending.

### Root cause
- Queue claim filter only included `queued`, `timeout`, `deferred`.
- Fallback-required statuses were excluded from claim set.

### Tweak applied
- Included `fallback_resume` and `fallback_spawn` in due-claim statuses.
- Preserved original claimed status for processor decisioning while still locking DB row as `triggering`.
- Added test: `claims fallback-required jobs and routes them directly to fallback executor`.

## Issue 03: Codex fallback execution does not complete within worker timeout window
### Evidence
- In MCP-driven spawn flow (`fallback_spawn`) with `TRIGGER_ACK_TIMEOUT_MS=5000/20000/60000`, attempts ended with:
  - `attempt_result=fallback_resume_failed`
  - `error_code=TRIGGER_FALLBACK_TIMEOUT`
- No successful `fallback_spawned` observed in current local runtime setup.

### Observed behavior
- Worker does claim and process jobs correctly after the above fixes.
- Fallback command path itself appears long-running/non-terminating in this environment.

### Potential follow-up
- Add non-interactive/timeout-safe execution mode for `codex exec` fallback path.
- Add detached process strategy with explicit spawn audit instead of waiting for process completion.

### Resolution status
- Fixed in current patch set.
- Fallback now uses non-blocking start semantics (detached launch accepted), and live run now records `attempt_result=fallback_spawned` without waiting for task completion.

## Issue 04: Local auth dependency is operationally fragile during testing
### Evidence
- Bridge requests intermittently failed with `UNAUTHORIZED` + `reason: fetch failed` when local JWKS server was not running.

### Notes
- Restarting local JWKS at `http://localhost:8080/.well-known/jwks.json` restores MCP auth flow.
- This is a local test harness dependency, not a protocol bug.

## Issue 05: `triggering` jobs can become stranded after worker interruption
### Evidence
- If worker is terminated while processing a claimed job, the row can remain `status=triggering` with `attempts=0`.
- Subsequent worker ticks do not reclaim these rows.

### Impact
- Job becomes effectively lost (no retry, no fallback progression), which can silently drop an orchestrator trigger.

### Source
- Confirmed in live run and also independently flagged by review pass over `apps/supervisor-worker/src/trigger-queue.ts`.

### Follow-up proposal
- Add stale `triggering` reclaim strategy:
  - Either include stale `triggering` rows in claim query after lease timeout, or
  - Add a periodic reaper that moves stale `triggering` rows to retryable status (`timeout`/`deferred`) with audit trail.

## Small Tweaks Implemented
1. Added bounded timeout and exception guards in trigger processing:
   - `apps/supervisor-worker/src/trigger-queue.ts`
   - Uses `TRIGGER_ACK_TIMEOUT_MS` (already existing config) via worker wiring.
2. Enabled processing for fallback-required trigger statuses:
   - `apps/supervisor-worker/src/trigger-queue.ts`
3. Changed fallback execution to non-blocking start semantics:
   - `apps/supervisor-worker/src/runtime-fallback.ts`
   - `apps/supervisor-worker/src/tmux-adapter.ts`
   - `resume`/`spawn` now succeed on process start acceptance rather than full task completion.
4. Fixed repeated re-processing of fallback jobs:
   - `apps/supervisor-worker/src/trigger-queue.ts`
   - fallback statuses are claim-eligible only for initial attempt (`attempts=0`), preventing repeated spawn loops on subsequent ticks.
5. Added/updated tests:
   - `apps/supervisor-worker/src/trigger-queue.test.ts`
   - `apps/supervisor-worker/src/runtime-fallback.test.ts`
   - New coverage for executor exception handling, fallback timeout handling, fallback-status claim path, and detached fallback launch behavior.

## Additional Live Validation (post-fix)

### Managed delivery path (`trigger_runtime`) with valid tmux target
- Configuration used in heartbeat:
  - `runtime="tmux://orkiva_orch:0.0"`
  - `management_mode="managed"`
  - `status="active"`
- Trigger result:
  - API returned `action=trigger_runtime`, `result=queued`.
  - Worker recorded `attempt_result=delivered`, `next_status=delivered`.
- Evidence:
  - `trigger_jobs`: `status=delivered`, `attempts=1`.
  - `trigger_attempts`: `attempt_no=1`, `result=delivered`.
  - `tmux capture-pane` includes `[BRIDGE_TRIGGER ...]` envelope for this trigger id.

### Fallback paths (`fallback_resume` / `fallback_spawn`)
- Unmanaged target produced deterministic `fallback_resume` and recorded `fallback_resume_succeeded`.
- No-session target produced deterministic `fallback_spawn` and recorded `fallback_spawned`.
- Managed target with invalid tmux target retried via timeout and eventually fell into fallback resume on final attempt, matching policy.

## Issue 06: `pnpm dev` worker can appear healthy while not processing jobs (missing runtime env)
### Evidence
- Local long-running process existed (`pnpm --filter @orkiva/supervisor-worker dev`), but newly created jobs remained in:
  - `status=fallback_spawn`, `attempts=0`
  - no `trigger_attempts` rows
- Running one-shot worker with `.env` sourced immediately processed the same jobs.
- Process environment inspection for the running `tsx watch` process showed missing required config variables (`WORKSPACE_ID`, `DATABASE_URL`, etc.).

### Impact
- Operator may believe worker is running while queue remains unprocessed.
- Triggers can accumulate without execution until worker is restarted with correct environment.

### Follow-up proposal
- Improve dev/start ergonomics so worker/bootstrap fails fast and visibly when required env is absent.
- Option A: enforce env-file loading in runtime entry path.
- Option B: provide a single blessed launcher command that always sources `.env` before `dev` and `start`.

### Tweak applied
- Updated app package scripts to auto-source repository `.env` before runtime bootstrap:
  - `apps/supervisor-worker/package.json`
  - `apps/bridge-api/package.json`
  - `apps/operator-cli/package.json`
- Validation:
  - `env -i ... pnpm --filter @orkiva/supervisor-worker dev` now boots with correct workspace/database config and drains pending trigger jobs.
  - `env -i ... pnpm --filter @orkiva/bridge-api dev` resolves config and fails only on expected `EADDRINUSE` when another API process is already bound to `:3000`.

## Issue 07: Unread reconciliation candidates are computed but never enqueued as trigger jobs
### Evidence
- `UnreadReconciliationService.reconcile` returns dormant unread candidates and worker logs report non-zero `candidates`.
- For thread `th_c86597d1-0958-4955-a354-e469b9856f5f`, participant completion message was present (`seq=2`, sender `reviewer_audit_agent`) while coordinator session remained dormant (`status=idle`, managed runtime).
- No `trigger_jobs` rows were created for `target_agent_id=coordinator_agent` for that thread.

### Root cause
- `SupervisorWorkerLoop.runTick` currently executes:
  1) unread reconciliation,
  2) runtime reconciliation,
  3) queue processing,
  but does not persist unread candidates into `trigger_jobs`.

### Impact
- "Agent finished -> orchestrator auto-wake" path does not function.
- Dormant participants are detected but never actually triggered.

### Follow-up proposal
- Add explicit enqueue stage between unread reconciliation and queue processing:
  - upsert deterministic trigger jobs for each candidate (`reason=new_unread_dormant_participant`)
  - idempotency key should include `(thread_id, participant_agent_id, latest_seq)`
  - ensure dedupe against pending jobs for same target/thread/reason.

### Resolution status
- Fixed in current patch set.
- `SupervisorWorkerLoop` now schedules unread candidates into `trigger_jobs` before queue processing.
- Deterministic trigger ids are generated from `(workspace_id, thread_id, participant_agent_id, latest_seq)` and reused on replay.
- Pending-job dedupe is enforced for the same `(thread_id, target_agent_id, reason)` before enqueue.
- Added tests covering enqueue + dedupe behavior:
  - `apps/supervisor-worker/src/unread-trigger-jobs.test.ts`
  - updated `apps/supervisor-worker/src/worker-loop.test.ts`

## Issue 08: Fallback-spawned `codex exec` agents have no guaranteed completion callback to bridge
### Evidence
- Three fallback spawn jobs were accepted and recorded:
  - `trg_req-real2-trigger-reviewer-1771603392`
  - `trg_req-real2-trigger-security-1771603392`
  - `trg_req-real2-trigger-quality-1771603392`
  - each with `attempt_result=fallback_spawned`.
- Corresponding `codex exec` processes were visible in `ps` and later exited.
- No completion messages were posted to thread from those agents during multi-minute observation.
- Session traces under `~/.codex/sessions/...` show each spawned agent attempted `curl http://localhost:3000/v1/mcp/post_message` and reported:
  - `curl: (7) Failed to connect to localhost port 3000`
  - runtime sandbox context had `network_access=false` for spawned fallback sessions.

### Notes
- Current spawn semantics treat process start acceptance as success, but there is no mandatory bridge callback handshake for task completion.
- Completion reporting is currently best-effort prompt behavior, not enforced protocol.
- In the current runtime profile, fallback-spawned `codex exec` cannot reach bridge network endpoint from its sandbox, so callback-by-curl is not viable.

### Impact
- Orchestrator cannot rely on spawned-agent completion unless runtime explicitly posts to bridge.
- End-to-end orchestration remains partially observable.

### Follow-up proposal
- Define and enforce minimal completion contract for fallback runs:
  - required `post_message` completion event shape (success/failure, summary pointer),
  - timeout watchdog for missing completion callback,
  - optional wrapper command around `codex exec` that posts deterministic completion envelope on exit.

## Issue 09: `codex -a never -s danger-full-access exec ...` does not yield full sandbox in this environment
### Evidence
- Manual command run:
  - `codex -a never -s danger-full-access exec "quick sandbox check"`
- Startup header still reported:
  - `sandbox: workspace-write [...]`
- Spawned fallback sessions launched with `-a never -s danger-full-access` also recorded `sandbox_policy.type=workspace-write` and `network_access=false` in session traces.

### Root cause
- In this runtime profile, `-s danger-full-access` is not sufficient to bypass the default sandbox policy for non-interactive `exec`.

### Tweak applied
- Updated fallback launcher in `apps/supervisor-worker/src/runtime-fallback.ts` to use:
  - `--dangerously-bypass-approvals-and-sandbox`
- Updated tests:
  - `apps/supervisor-worker/src/runtime-fallback.test.ts`

### Validation
- Spawned worker processes now show:
  - `codex --dangerously-bypass-approvals-and-sandbox exec ...`
- Session traces for spawned agents now include:
  - `sandbox_policy.type=danger-full-access`
- End-to-end spawn drill (`th_90e6bfff-119d-4bbd-8189-52dc18ab28ca`) confirmed detached fallback launches for multiple review agents.

### Remaining gap
- Even with full sandbox, callback posting is still not deterministic/guaranteed in current flow because completion remains prompt-driven rather than contract-enforced (see Issue 08).

## Issue 10: Runtime failed to recognize new worker callback env keys until package builds were refreshed
### Evidence
- E2E worker logs initially recorded callback failures with:
  - `attempt_result=callback_post_failed`
  - `error_code=CALLBACK_AUTH_TOKEN_MISSING`
- A direct runtime probe showed `loadSupervisorWorkerConfig(...).WORKER_BRIDGE_ACCESS_TOKEN` was `missing` despite export.

### Root cause
- Runtime resolves `@orkiva/shared` from built package output (`dist`).
- New env keys were added in source but not yet built into `dist`.

### Tweak applied
- Rebuilt changed workspace packages before E2E:
  - `pnpm --filter @orkiva/shared build`
  - `pnpm --filter @orkiva/protocol build`
  - `pnpm --filter @orkiva/db build`
  - `pnpm --filter @orkiva/supervisor-worker build`

## Issue 11: Worker-owned callback events created unread-trigger feedback loops
### Evidence
- First callback-enabled E2E in `wk_callback_test` produced many `trigger.completed` events in one thread.
- Worker logs showed repeated auto-unread triggers for both participants after each callback event.

### Root cause
- Unread reconciliation used latest thread message sequence without excluding worker-owned callback events.
- Callback messages were treated as actionable unread messages.

### Tweak applied
1. Marked worker callback events with metadata flag:
   - `suppress_auto_trigger: true`
   - file: `apps/supervisor-worker/src/trigger-callback.ts`
2. Updated unread reconciliation latest-seq query to ignore suppressed events:
   - `coalesce((metadata->>'suppress_auto_trigger')::boolean, false) = false`
   - file: `apps/supervisor-worker/src/unread-reconciliation.ts`
3. Added assertion coverage for suppression metadata in callback tests:
   - file: `apps/supervisor-worker/src/trigger-callback.test.ts`

### Validation
- Isolated E2E workspace run (`wk_callback_once_1771622461`) produced exactly one callback:
  - `CALLBACK_EVENT_COUNT=1`
  - worker logs show `callback_post_succeeded` and terminal `next_status=callback_delivered`.
