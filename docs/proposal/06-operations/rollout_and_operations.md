# Rollout and Operations Plan

## 1. Delivery Strategy
Use phased delivery to reduce risk and validate behavior on real workflows before scaling.

## 2. Phases
## Phase 0: Spec and Alignment
Deliverables:
- approved PRD and protocol
- security baseline
- implementation backlog with owners

Exit criteria:
- architecture and protocol sign-off
- pilot workflow selected

## Phase 1: MVP Build (Local/Pilot)
Scope:
- thread creation and participant management
- post/read messages with cursor polling
- basic status transitions
- minimal audit log
- dormant participant wake trigger for Codex CLI runtime

Tech baseline:
- MCP service layer
- Postgres persistence
- simple loop/rate guards
- hybrid orchestration policy (trigger-first, polling fallback)
- managed-runtime requirement for autonomous trigger lanes
- defer-and-queue collision policy for human input overlap
- personal MVP data policy: indefinite retention, no automated content filtering
- single-workspace trust domain enforcement
- API `/v1` + payload schema version baseline

Exit criteria:
- one real executioner/reviewer flow runs end-to-end
- no manual copy-paste required in pilot scenario

## Phase 2: Hardening
Scope:
- richer policy checks and role controls
- message retry/idempotency reliability improvements
- observability dashboard for thread health
- retention/archival controls and content filtering (future enhancement)

Exit criteria:
- stable pilot over multiple projects
- SLO baseline met for latency and reliability

## Phase 3: Scale and Advanced Automation
Scope:
- push/subscription notification option
- advanced routing and escalation policies
- coordinator-agent automation helpers

Exit criteria:
- multi-team usage
- production readiness review passed

## 3. Operational Readiness
## 3.1 Runbooks
Required runbooks:
- service unavailable
- storage lock/contention
- message delivery delay
- authorization misconfiguration
- token issuer outage / token validation failure
- escalation flood
- wake trigger failure (`resume` target unavailable or repeated trigger errors)
- unmanaged runtime target in autonomous lane
- human-input collision and deferred-trigger timeout

Published artifacts:
- runbook set: `docs/runbooks/mvp_incident_runbooks.md`
- drill evidence log: `docs/proposal/06-operations/runbook_drill_evidence.md`

Operator CLI baseline (MVP):
- `inspect-thread --thread-id <id>` for thread/participant/message/trigger inspection.
- `escalate-thread --thread-id <id> --reason <text>` to transition a thread to `blocked`.
- `assign-escalation-owner --thread-id <id> --owner-agent-id <agent> --reason <text>` to assign escalation ownership for blocked threads.
- `reassign-escalation-owner --thread-id <id> --owner-agent-id <agent> --reason <text>` to transfer escalation ownership while blocked.
- `get-escalation-owner --thread-id <id>` to read current escalation owner state.
- `unblock-thread --thread-id <id> --reason <text>` to transition a thread back to `active`.
- `override-close-thread --thread-id <id> --reason <human_override:...>` for explicit close overrides.
- `fallback-list [--status running|all] [--limit <n>]` to inspect fallback execution inventory.
- `fallback-kill (--trigger-id <id> | --thread-id <id>) --reason <text>` to terminate running fallback executions and queue terminal callback handling.
- All mutable operations append audit events with operator actor identity.

## 3.2 Observability
Metrics:
- messages posted per minute
- read latency (median, p95)
- message delivery failure rate
- active threads by state
- escalations per day
- loop-detection trigger count
- wake attempts by result (`triggered`, `already_active`, `failed`, `fallback_spawned`)
- fallback run states (`running`, `completed`, `timed_out`, `killed`, `orphaned`)
- API request counters and cumulative duration exported from `/metrics`

Logs:
- request-level structured logs with request ID
- policy decision traces for denied operations
- supervisor tick lifecycle logs (`tick.completed`, `tick.idle`, `tick.failed`)

Health and readiness:
- `/health`: process liveness signal.
- `/ready`: dependency readiness signal (DB query check in bridge-api bootstrap path).

Tracing:
- correlation from agent request to persistence and notification path

## 3.3 SLO/SLI Baseline (MVP)
SLIs:
- message post success rate
- post-to-visible latency
- read API success rate

Initial SLO targets:
- post success >= 99.0%
- read success >= 99.5%
- p95 post-to-visible <= 2s
- p95 message-to-wake-trigger <= 3s

Measurement artifacts:
- benchmark runner: `infra/scripts/pilot-sli-baseline.ts`
- baseline report: `docs/proposal/06-operations/reports/pilot_sli_baseline.json`
- threshold guard test: `apps/bridge-api/src/sli-benchmark.test.ts`

Default hybrid policy (MVP):
- supervisor polling interval: 5s
- trigger ack timeout: 8s
- trigger retries before fallback: 2
- triggering lease timeout before stale reclaim: 45s
- human-input quiet window before trigger injection: 20s
- deferred trigger re-check interval: 5s
- max defer window before fallback: 60s
- auto-unread max triggers per thread/participant per 5m: 3
- auto-unread minimum interval per thread/participant: 30s
- auto-unread backlog breaker threshold (pending jobs): 50
- auto-unread backlog breaker cooldown: 60s
- auto-unread enabled: true (default, may be disabled in local-safe profile)
- no-progress auto-block threshold: 20 turns
- repeated-identical-finding auto-block threshold: 3 cycles
- resume attempts before spawn: 2
- stale session cutoff before spawn: `>12h` heartbeat gap
- worker min claim cutoff timestamp: unset by default (local-safe profile sets startup timestamp)
- fallback execution timeout: 900000ms (15m)
- fallback kill grace window: 5000ms
- fallback max active (global): 8
- fallback max active (per agent): 2

## 3.4 Local Development Guardrails
Local guardrails to avoid accidental queue replay and background fanout during iterative testing:

- `AUTO_UNREAD_ENABLED=false` disables unread reconciliation/scheduling while keeping manual trigger flows available.
- `WORKER_MIN_JOB_CREATED_AT=<ISO timestamp>` limits job claiming to jobs created at or after startup.
- `pnpm run dev:supervisor-worker:fresh` starts worker with startup cutoff set to current UTC.
- `pnpm run dev:queue:reset -- --workspace-id <id>` inspects resettable pending jobs (`--apply` required to persist).
- `pnpm run dev:stack:safe` starts `bridge-api` plus worker with `AUTO_UNREAD_ENABLED=false` and startup cutoff guard.

## 4. Testing Strategy
## 4.1 Unit Tests
- routing logic
- policy checks
- state transition rules
- idempotency behavior

## 4.2 Integration Tests
- multi-agent messaging in one thread
- directed and broadcast delivery
- failure/retry paths
- loop escalation path
- dormant participant wake and resume behavior
- unmanaged-target fallback behavior
- human-input collision defer/override behavior
- stale `triggering` reclaim path behavior (executor-stage and callback-stage continuation)
- auto-unread storm containment behavior (budget suppression and backlog breaker cooldown)
- cross-workspace request rejection in MVP mode
- backward-compatible payload handling by `schema_version`

## 4.3 Security Tests
- unauthorized access attempts
- token claim mismatch and expired-token rejection
- cross-workspace isolation
- malformed payload handling
- repeated malformed payload bursts remain bounded to deterministic `INVALID_ARGUMENT` responses

## 4.4 Load Tests
- sustained multi-thread writes/reads
- burst traffic behavior
- storage contention thresholds
- concurrent write burst scenarios confirm no internal server errors and monotonic persisted sequencing

## 5. Migration and Backward Compatibility
- Start with versioned MCP methods (`v1`).
- Introduce additive fields only in minor revisions.
- Plan explicit deprecation windows for breaking changes.

## 6. Team Responsibilities
- Product owner: prioritization and adoption metrics.
- Platform engineer: service reliability, infra, operations.
- Security owner: policy and threat model review.
- Agent workflow owner: runtime integration and user education.

## 7. Go-Live Checklist
- Functional acceptance criteria passed.
- Security checks passed.
- Alerting configured and tested.
- Runbooks published.
- Pilot sign-off from primary users.

Launch sign-off artifact:
- `docs/proposal/06-operations/launch_readiness_and_handoff.md`
- `docs/proposal/06-operations/local_deployment_and_usage.md`

## 8. Post-Launch Review
Within 2 weeks:
- compare baseline and post-launch cycle times
- review escalation events and false positives
- gather operator feedback on autonomy improvements
- prioritize Phase 2 backlog
