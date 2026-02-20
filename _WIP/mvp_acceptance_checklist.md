# Orkiva MVP Acceptance Checklist

## Purpose

Single normalized checklist for MVP acceptance, merged from:

- `docs/proposal/01-product/prd.md`
- `docs/proposal/04-protocol/protocol_spec.md`
- `docs/proposal/06-operations/implementation_backlog.md`

Use this checklist as the implementation validation baseline.

## How To Use

- Mark exactly one of `Pass` or `Fail` for each row during review.
- Attach links to evidence (tests, logs, recordings, payloads, metrics) in `Notes`.
- If `Fail`, open or reference a remediation task.

## A) Functional Scope and Command Surface

| ID | Acceptance Criterion | Source | Evidence Required | Pass | Fail | Notes |
|---|---|---|---|---|---|---|
| F-01 | MCP `/v1` exposes required thread commands: `create_thread`, `get_thread`, `update_thread_status`, `summarize_thread` | PRD FR-1/FR-15, Protocol §3, Backlog 2.1/2.3 | Contract tests + route/tool registry snapshot | [x] | [ ] | `apps/bridge-api/src/app.ts`, `packages/protocol/src/v1/thread.ts`, `apps/bridge-api/src/app.test.ts` |
| F-02 | MCP `/v1` exposes required message commands: `post_message`, `read_messages`, `ack_read` | PRD FR-2/FR-4/FR-15, Protocol §3, Backlog 2.2 | Contract tests + route/tool registry snapshot | [x] | [ ] | `apps/bridge-api/src/app.ts`, `packages/protocol/src/v1/message.ts`, `apps/bridge-api/src/app.test.ts` |
| F-03 | MCP `/v1` exposes required session/wake commands: `heartbeat_session`, `trigger_participant` | PRD FR-10/FR-15, Protocol §3, Backlog 2.4 | Contract tests + route/tool registry snapshot | [x] | [ ] | `apps/bridge-api/src/app.ts`, `packages/protocol/src/v1/session.ts`, `apps/bridge-api/src/app.test.ts` |
| F-04 | Thread lifecycle supports `active`, `blocked`, `resolved`, `closed` with valid transition enforcement | PRD FR-1/FR-9/FR-13, Protocol Thread model, Backlog 1.1 | Unit + integration tests for valid/invalid transitions | [x] | [ ] | `packages/domain/src/thread.ts`, `packages/domain/src/domain.test.ts`, `apps/bridge-api/src/app.test.ts` |
| F-05 | Messages support chat and event usage with optional metadata + `in_reply_to` | PRD FR-2/FR-5, Protocol Message model, Backlog 1.2 | Integration tests for chat/event/reply chaining | [x] | [ ] | `packages/protocol/src/v1/entities.ts`, `packages/domain/src/message.ts`, `apps/bridge-api/src/app.test.ts` |
| F-06 | Read flow supports cursor-based retrieval and ack updates per participant | PRD FR-4/FR-6, Protocol `read_messages`/`ack_read`, Backlog 1.3/2.2 | Integration tests for cursor progression + unread behavior | [x] | [ ] | `apps/bridge-api/src/app.ts`, `apps/bridge-api/src/app.test.ts`, `apps/bridge-api/src/app.db.integration.test.ts` |
| F-07 | Thread summarization returns compressed context and open items | PRD FR-7, Protocol `summarize_thread`, Backlog 2.3 | Unit/integration tests for summary output shape | [x] | [ ] | Baseline summary shape implemented in `apps/bridge-api/src/thread-store.ts`, validated in `apps/bridge-api/src/app.test.ts` |
| F-08 | Escalation markers and owner-assigned escalation flow are supported | PRD FR-9, Backlog 5.2 | Scenario test showing escalation + unblock path | [x] | [ ] | Owner assignment lifecycle + authority checks implemented in `apps/operator-cli/src/commands.ts`, `apps/operator-cli/src/service.ts`, `apps/operator-cli/src/main.test.ts`; thread owner fields added in `packages/db/src/schema.ts` with migration `packages/db/migrations/0001_spooky_elektra.sql` |
| F-09 | Pilot executioner-reviewer flow completes end-to-end without manual relay | PRD Goals/Launch Criteria, Backlog 5.1 | Recorded E2E run + assertions on automated handoff | [x] | [ ] | `apps/bridge-api/src/workflow.integration.test.ts` |

## B) Data, Ordering, Idempotency, and Versioning

| ID | Acceptance Criterion | Source | Evidence Required | Pass | Fail | Notes |
|---|---|---|---|---|---|---|
| D-01 | Per-thread message ordering is monotonic and deterministic (`seq`) | PRD FR-4, Protocol Message model, Backlog 1.2 | Concurrency test validating deterministic ordering | [x] | [ ] | `packages/domain/src/message.ts`, `apps/bridge-api/src/app.test.ts` (`retries concurrent non-idempotent writes and preserves monotonic sequencing`) |
| D-02 | `post_message` idempotency key behavior returns original result on retries | PRD FR-4, Protocol §7, Backlog 2.2/4.3 | Retry tests + duplicate-key behavior assertions | [x] | [ ] | `apps/bridge-api/src/app.ts`, `apps/bridge-api/src/app.test.ts`, `apps/bridge-api/src/app.db.integration.test.ts` |
| D-03 | Protocol payloads include `schema_version`; events support `event_version` evolution | PRD FR-15, Protocol §1.2/§2.2, Backlog 4.5 | Contract tests across versioned payloads | [x] | [ ] | `packages/protocol/src/v1/common.ts`, `packages/protocol/src/v1/message.ts`, `packages/protocol/src/v1/entities.ts`, `packages/protocol/src/v1/contracts.test.ts`, `apps/bridge-api/src/app.test.ts` |
| D-04 | Backward-compatible additive changes do not break existing payload consumers | PRD FR-15, Protocol §9, Backlog 4.5 | Compatibility suite with baseline fixtures | [x] | [ ] | Fixture-driven compatibility suite added in `packages/protocol/src/v1/compatibility/fixtures.ts` and `packages/protocol/src/v1/compatibility/compatibility.test.ts`; verified via `pnpm --filter @orkiva/protocol test` |
| D-05 | MVP tables exist and support thread/message/cursor/session/trigger/audit flows | PRD Dependencies, Backlog 0.3/1.x/6.x | Migration run + DB integration tests | [x] | [ ] | `packages/db/src/schema.ts`, `packages/db/test/migration-connectivity.test.ts`, `apps/bridge-api/src/app.db.integration.test.ts` |

## C) Identity, Auth, Authorization, and Governance

| ID | Acceptance Criterion | Source | Evidence Required | Pass | Fail | Notes |
|---|---|---|---|---|---|---|
| S-01 | All operations require valid platform-issued signed token | PRD FR-11/NFR-4, Protocol §1.1, Backlog 3.1 | Security tests for unauthenticated rejection | [x] | [ ] | `apps/bridge-api/src/app.ts` auth hook + `apps/bridge-api/src/app.test.ts` (401 paths) |
| S-02 | Required token claims are enforced (`agent_id`, `workspace_id`, `role`, `session_id`, `iat`, `exp`, `jti`) | PRD FR-11, Protocol §1.1, Backlog 3.1/3.4 | Claim validation tests including expired/revoked tokens | [x] | [ ] | `packages/auth/src/claims.ts`, `packages/auth/src/verifier.ts`, `packages/auth/src/auth.test.ts` |
| S-03 | Payload identity mismatch vs verified claims is rejected and audited (`CLAIM_MISMATCH`) | Protocol §1.1/§6, Backlog 3.4 | Negative tests + audit log assertion | [x] | [ ] | `apps/bridge-api/src/app.ts`, `apps/bridge-api/src/app.test.ts` (payload identity mismatch + audit rejection cases) |
| S-04 | Role-based authorization enforced for participant/coordinator/auditor actions | PRD FR-8/FR-13, Backlog 3.2 | ACL matrix tests | [x] | [ ] | `packages/auth/src/roles.ts`, `packages/auth/src/auth.test.ts`, `apps/bridge-api/src/app.test.ts` |
| S-05 | Worker agents cannot force-close disputed threads | PRD FR-13, Protocol `update_thread_status` authority rule, Backlog 3.2 | Negative transition tests | [x] | [ ] | Guard in `apps/bridge-api/src/app.ts` + disputed-close tests in `apps/bridge-api/src/app.test.ts` |
| S-06 | Human/orchestrator authority path supports operational overrides with audit trail | PRD FR-12/FR-13, Backlog 5.2 | Scenario test + audit event assertions | [x] | [ ] | `apps/operator-cli/src/service.ts`, `apps/operator-cli/src/main.test.ts`, `apps/bridge-api/src/app.test.ts` |
| S-07 | Cross-workspace requests are rejected and audit-logged | PRD FR-14, Protocol §1.2/§6, Backlog 3.6 | Isolation tests + audit verification | [x] | [ ] | `packages/auth/src/claims.ts`, `apps/bridge-api/src/app.test.ts`, `apps/bridge-api/src/security-load.test.ts` |
| S-08 | Personal MVP data policy is enforced: indefinite retention, no automated content filtering | PRD MVP Scope/Out of Scope, Backlog 3.5 | Config + behavior checks, policy test notes | [x] | [ ] | `packages/shared/src/config/env.ts` (`RETENTION_MODE=permanent`, `ENABLE_AUTOMATED_REDACTION=false`) |

## D) Runtime Activation, Triggering, and Safety Controls

| ID | Acceptance Criterion | Source | Evidence Required | Pass | Fail | Notes |
|---|---|---|---|---|---|---|
| R-01 | Dormant participant detection and trigger dispatch are implemented | PRD FR-10, Protocol `trigger_participant`, Backlog 2.4/5.3 | Integration test for idle/offline wake | [x] | [ ] | `apps/supervisor-worker/src/unread-reconciliation.ts`, `apps/supervisor-worker/src/unread-reconciliation.test.ts`, `apps/bridge-api/src/workflow.integration.test.ts` |
| R-02 | Autonomous trigger path targets managed runtimes only | PRD FR-17, Protocol `trigger_participant`, Backlog 6.5 | Tests for managed/unmanaged routing decisions | [x] | [ ] | `apps/supervisor-worker/src/runtime-trigger-executor.ts`, `apps/supervisor-worker/src/runtime-trigger-executor.test.ts` |
| R-03 | Unmanaged runtime targets return deterministic fallback-required status | PRD FR-17, Protocol errors, Backlog 6.5 | Negative test assertions on status/error code | [x] | [ ] | `apps/bridge-api/src/app.ts`, `packages/protocol/src/v1/session.ts`, `apps/bridge-api/src/app.test.ts` |
| R-04 | Fallback order is deterministic: live trigger -> resume (max 2) -> spawn | PRD FR-16, Backlog 4.4/6.3 | Orchestration tests across all failure branches | [x] | [ ] | `apps/supervisor-worker/src/runtime-fallback.ts`, `apps/supervisor-worker/src/runtime-fallback.test.ts` |
| R-05 | Session staleness (`>12h`) and crash-loop shortcut influence fallback behavior correctly | PRD FR-16, Runtime design, Backlog 4.4 | Policy tests with synthetic timestamps/failure counts | [x] | [ ] | `apps/supervisor-worker/src/runtime-fallback.ts`, `apps/supervisor-worker/src/runtime-fallback.test.ts` |
| R-06 | Human-input collision policy enforced (`20s` quiet, `5s` re-check, `60s` max defer) | PRD FR-18, Protocol `trigger_participant`, Backlog 6.4 | Collision simulation tests + outcome assertions | [x] | [ ] | `apps/supervisor-worker/src/runtime-trigger-executor.ts`, `apps/supervisor-worker/src/runtime-trigger-executor.test.ts`, `apps/supervisor-worker/src/tmux-adapter.test.ts` |
| R-07 | Force override requires explicit operator intent and is fully audited | PRD FR-18, Runtime specs, Backlog 6.4 | Override scenario tests + audit entries | [x] | [ ] | Override audit metadata persisted in trigger attempts (`apps/supervisor-worker/src/runtime-trigger-executor.ts`, `apps/supervisor-worker/src/trigger-queue.ts`) and validated by tests in `apps/supervisor-worker/src/runtime-trigger-executor.test.ts` and `apps/supervisor-worker/src/trigger-queue.test.ts` |
| R-08 | Loop safeguards auto-block at `20` turns or `3` repeated-identical cycles | PRD FR-16, Backlog 3.3 | Loop simulation tests + blocked-state assertions | [x] | [ ] | `apps/supervisor-worker/src/trigger-queue.ts`, `apps/supervisor-worker/src/trigger-queue.test.ts` |

## E) Reliability, Observability, and Operations

| ID | Acceptance Criterion | Source | Evidence Required | Pass | Fail | Notes |
|---|---|---|---|---|---|---|
| O-01 | No message loss after server acknowledgement under transient failure scenarios | PRD NFR-1, Backlog 4.3 | Fault-injection + replay tests | [x] | [ ] | Fault-injection replay coverage added in `apps/bridge-api/src/app.test.ts` (`replays idempotent post_message after transient post-write failure without losing persisted message`) and `apps/bridge-api/src/app.db.integration.test.ts` (`replays idempotent post_message after transient db post-write failure without message loss`, `retains acknowledged messages after transient db read failure on replay`) |
| O-02 | Throughput/latency metrics and health endpoints are exposed | PRD NFR-5, Backlog 4.1/4.2 | Metrics scrape + health/readiness checks | [x] | [ ] | `apps/bridge-api/src/app.ts` (`/health`, `/ready`, `/metrics`), `apps/bridge-api/src/app.test.ts` |
| O-03 | Correlation IDs are present across API/worker logs and trace paths | PRD NFR-5, Backlog 4.1 | Structured log assertions | [x] | [ ] | Correlation helper contract is codified in `packages/protocol/src/v1/common.ts` (`buildTriggerId`, `extractRequestIdFromTriggerId`), API trigger IDs are deterministic from request IDs in `apps/bridge-api/src/app.ts`, and worker attempt traces/logs include `request_id` + `trigger_id` via `apps/supervisor-worker/src/trigger-queue.ts` with assertions in `apps/supervisor-worker/src/trigger-queue.test.ts`. |
| O-04 | Post success/read success/latency SLO baseline can be measured | PRD NFR-2/NFR-7, Rollout SLOs, Backlog 5.4 | Pilot metric report with p95 values | [x] | [ ] | `docs/proposal/06-operations/reports/pilot_sli_baseline.json`, `apps/bridge-api/src/sli-benchmark.test.ts` |
| O-05 | Message-to-wake-trigger p95 <= 3s in pilot environment | PRD NFR-7, Rollout SLOs | Timed integration benchmark report | [x] | [ ] | `docs/proposal/06-operations/reports/pilot_sli_baseline.json` (`messageToWakeTriggerP95Ms=4.107ms`) |
| O-06 | Runbooks cover required failure classes and are validated by drill | PRD Launch Criteria, Rollout plan §3.1, Backlog DoD | Runbook docs + drill evidence | [x] | [ ] | `docs/runbooks/mvp_incident_runbooks.md`, `docs/proposal/06-operations/runbook_drill_evidence.md` |

## F) Explicit MVP Non-Goals (Must Stay Out)

| ID | Non-Goal Constraint | Source | Verification Method | Pass | Fail | Notes |
|---|---|---|---|---|---|---|
| NG-01 | No cross-workspace or cross-organization federation in MVP | PRD Non-goals/FR-14 | Architecture review + rejection tests | [x] | [ ] | Single-workspace guards in `packages/auth/src/claims.ts`; rejection tests in `apps/bridge-api/src/app.test.ts` and `apps/bridge-api/src/security-load.test.ts` |
| NG-02 | No web dashboard required in MVP execution path | PRD MVP Scope, Backlog 5.5 | Repo/component inventory + pilot flow proof | [x] | [ ] | Repo scope is API/worker/CLI only (`apps/bridge-api`, `apps/supervisor-worker`, `apps/operator-cli`) |
| NG-03 | No advanced semantic auto-routing/auto-agent assignment in MVP | PRD Out of Scope | Feature inventory review | [x] | [ ] | Trigger routing is policy/rule-based (`apps/bridge-api/src/app.ts`, `apps/supervisor-worker/src/trigger-queue.ts`) |
| NG-04 | No full event-streaming infrastructure requirement in MVP | PRD Out of Scope | Architecture review | [x] | [ ] | Runtime is trigger/polling queue based (`apps/supervisor-worker/src/*`), no event-streaming subsystem in repo |
| NG-05 | No automated content filtering/redaction pipeline in personal MVP | PRD Out of Scope, Backlog 3.5 | Config + implementation review | [x] | [ ] | `ENABLE_AUTOMATED_REDACTION` is hard-disabled in `packages/shared/src/config/env.ts` |
| NG-06 | No tiered retention/auto-expiry jobs in personal MVP | PRD Out of Scope, Backlog 3.5 | Data policy review | [x] | [ ] | `RETENTION_MODE` is fixed to `permanent` in `packages/shared/src/config/env.ts`; no expiry jobs found in apps |
| NG-07 | No deterministic process-trigger SLA promised for unmanaged terminals | PRD Out of Scope/FR-17 | Runtime behavior tests | [x] | [ ] | Unmanaged runtimes deterministically route to fallback-required (`apps/bridge-api/src/app.test.ts`) |

## G) Exit Rule

MVP is accepted only when:

- All required functional/security/runtime/reliability rows pass, and
- All non-goal constraints pass (no forbidden scope creep), and
- Evidence links are present for each accepted row.
