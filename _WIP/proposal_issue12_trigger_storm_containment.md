# Proposal: Phase A Trigger Storm Containment

Date: 2026-02-20
Owner: Supervisor Worker Runtime
Status: Approved for implementation (Phase A)

## 1. Problem

Recent orchestrator stress runs showed callback delivery success but also a high-volume auto-unread fan-out pattern:

- many `trg_auto_unread_*` jobs created across multi-participant threads
- rising `triggering`/`fallback_spawn` backlog
- repeated process churn (`codex exec` spawn/resume waves)
- workstation-level lag and IDE instability

This is a reliability and operational safety issue.

## 2. Scope (Phase A)

Implement immediate containment and deterministic recovery without breaking protocol/API surface:

1. Per thread+participant auto-trigger budget controls
2. Global backlog circuit breaker for unread auto-scheduling
3. Stale `triggering` reclaim path in queue claiming
4. Visibility improvements (suppression counters and logs)

## 3. Design

## 3.1 Auto-unread budget guard

Apply in `UnreadTriggerJobScheduler` before enqueue:

- `AUTO_UNREAD_MAX_TRIGGERS_PER_WINDOW` (default: 3)
- `AUTO_UNREAD_WINDOW_MS` (default: 300000 / 5m)
- `AUTO_UNREAD_MIN_INTERVAL_MS` (default: 30000 / 30s)

Behavior:

- suppress enqueue when a thread+participant pair exceeds window budget
- suppress enqueue when minimum interval since last auto-trigger not met
- keep deterministic IDs and existing pending-job dedupe behavior

## 3.2 Global backlog breaker

Apply in scheduler using pending queue depth:

- `AUTO_UNREAD_BREAKER_BACKLOG_THRESHOLD` (default: 50)
- `AUTO_UNREAD_BREAKER_COOLDOWN_MS` (default: 60000)

Behavior:

- if pending queue depth >= threshold, open breaker and skip unread auto-enqueue for cooldown
- while breaker is open, skip unread auto-enqueue
- execution of already queued jobs continues unchanged

## 3.3 Stale `triggering` reclaim

Add lease-based reclaim for jobs stuck in `triggering`:

- `TRIGGERING_LEASE_TIMEOUT_MS` (default: 45000)

Behavior:

- stale `triggering` jobs become claim-eligible
- processor classifies reclaimed jobs:
  - if latest execution attempt indicates delivery/fallback success and callback stage likely interrupted -> resume callback path (`callback_retry` behavior)
  - otherwise resume executor retry path (`timeout` semantics)

This keeps recovery deterministic after worker interruption.

## 3.4 Observability

Add runtime counters/fields in tick output:

- `pending_jobs`
- `suppressed_budget`
- `suppressed_breaker`
- `breaker_open`
- reclaimed-triggering logs for diagnosis

## 4. Files (planned)

- `apps/supervisor-worker/src/unread-trigger-jobs.ts`
- `apps/supervisor-worker/src/worker-loop.ts`
- `apps/supervisor-worker/src/trigger-queue.ts`
- `apps/supervisor-worker/src/main.ts`
- `packages/shared/src/config/env.ts`
- `.env.example`

Tests:

- `apps/supervisor-worker/src/unread-trigger-jobs.test.ts`
- `apps/supervisor-worker/src/worker-loop.test.ts`
- `apps/supervisor-worker/src/trigger-queue.test.ts`
- `packages/shared/test/env-config.test.ts`

Docs:

- `docs/proposal/03-runtime/process_level_trigger_design.md`
- `docs/proposal/03-runtime/tmux_supervisor_implementation_spec.md`
- `docs/proposal/06-operations/rollout_and_operations.md`
- `_WIP/enhancements/2026-02-20_mcp_orchestrator_flow_validation.md`

## 5. Risks and mitigations

Risk: over-suppression could delay legitimate wakeups.
Mitigation: conservative defaults, explicit config knobs, and logging for suppression reasons.

Risk: stale-triggering reclaim could misclassify callback vs executor phase.
Mitigation: phase inference from latest execution attempt + explicit reclaim log context.

Risk: breaker may hide backlog root causes.
Mitigation: breaker state and queue depth always emitted in tick logs.

## 6. Acceptance criteria

1. Auto-unread fan-out is bounded by per-pair budget and min interval.
2. New unread auto-enqueue pauses when backlog exceeds threshold and resumes after cooldown.
3. Stale `triggering` jobs are reclaimed and progress without manual DB intervention.
4. No protocol/API breaking changes.
5. Existing callback delivery remains functional.

## 7. Rollout

1. Ship Phase A defaults enabled.
2. Run controlled multi-agent thread test.
3. Verify no unbounded queue growth and stable workstation behavior.
4. Tune thresholds if needed.
