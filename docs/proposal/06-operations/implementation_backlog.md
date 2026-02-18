# Implementation Backlog (Draft)

## Epic 0: Platform Bootstrap and Scaffolding
### Story 0.1: Repository scaffold
Acceptance:
- `orkiva/` root is created with `apps/`, `packages/`, `infra/`, and `docs/`.
- `pnpm` workspace is configured and install/build scripts are working.
- TypeScript strict mode and lint/format tooling are enabled.

### Story 0.2: Core runtime dependencies
Acceptance:
- `Fastify`, `@modelcontextprotocol/sdk`, `Drizzle`, `pg-boss`, `jose`, and observability libraries are integrated.
- Shared config package exposes environment validation and defaults.
- Health endpoint is available in `bridge-api`.

### Story 0.3: Local infrastructure bootstrap
Acceptance:
- Local Postgres starts via `infra/docker-compose.yml`.
- Migration runner can initialize schema from `packages/db`.
- Local run commands for `bridge-api` and `supervisor-worker` are documented.

## Epic 1: Core Thread and Message Domain
### Story 1.1: Thread lifecycle model
Acceptance:
- Create thread with participants and type.
- Transition statuses with valid state rules.
- Reject invalid transitions with clear errors.

### Story 1.2: Message persistence and ordering
Acceptance:
- Persist messages with monotonic `seq` per thread.
- Guarantee deterministic read order.
- Support optional `in_reply_to` linking.

### Story 1.3: Participant cursor tracking
Acceptance:
- Persist `last_read_seq` per participant.
- Return unread count from current cursor.
- Support ack updates.

### Story 1.4: Agent session registry
Acceptance:
- Persist latest resumable session per `agent_id` and workspace.
- Store `last_heartbeat_at`, runtime type, and resumable capability.
- Expose lookup by `agent_id` for wake orchestration.

## Epic 2: MCP Tool Surface
### Story 2.1: Create/read thread endpoints
Acceptance:
- `create_thread` and `get_thread` methods available.
- Access control applied for each method.

### Story 2.2: Post/read/ack message endpoints
Acceptance:
- `post_message`, `read_messages`, `ack_read` available.
- Idempotency behavior validated with retries.

### Story 2.3: Thread status and summary endpoints
Acceptance:
- `update_thread_status` and `summarize_thread` available.
- Summary includes open items and last status.

### Story 2.4: Wake and heartbeat endpoints
Acceptance:
- `heartbeat_session` endpoint updates session liveliness.
- `trigger_participant` endpoint dispatches runtime wake logic.
- Wake response includes result status and trace metadata.

## Epic 3: Policy and Safety
### Story 3.1: Authentication integration
Acceptance:
- Calls fail without valid platform-issued signed token.
- Verified claims include `agent_id`, `workspace_id`, `role`, `session_id`.
- Expired/revoked token path is tested.

### Story 3.2: Authorization matrix
Acceptance:
- Role permissions enforced (`participant`, `coordinator`, `auditor`).
- Cross-workspace access denied by default.
- Worker role cannot force-close disputed threads; human/orchestrator authority path is enforced.

### Story 3.3: Loop and rate controls
Acceptance:
- Message spam limits enforced.
- Loop threshold triggers escalation event.
- No-progress auto-block triggers at 20 turns.
- Repeated-identical-finding auto-block triggers at 3 cycles.

### Story 3.4: Token issuer and validation integration
Acceptance:
- Supervisor/runtime obtains short-lived platform-issued tokens.
- Bridge validates signature, expiry, revocation, and required claims.
- Claim mismatch with payload identity is rejected and audited.

### Story 3.5: Personal MVP data policy guardrail
Acceptance:
- Runtime config explicitly sets indefinite retention mode.
- Automated content filtering/redaction is disabled by default.
- Future feature flags exist for enabling retention expiry and filtering later.

### Story 3.6: Workspace boundary guard
Acceptance:
- Requests with mismatched `workspace_id` are rejected.
- Cross-workspace routing is blocked and audit-logged.
- Tests cover single-workspace trust-domain constraints.

## Epic 4: Reliability and Observability
### Story 4.1: Structured logging
Acceptance:
- Request and response logs include request ID.
- Error logs capture operation and caller identity.

### Story 4.2: Metrics and health checks
Acceptance:
- Metrics exported for throughput, latency, failure, escalations.
- Health endpoint reports liveness and readiness endpoint reports dependency status.
- Metrics are exposed via a scrapeable endpoint (`/metrics`).

### Story 4.3: Retry and idempotency hardening
Acceptance:
- Retry-safe write semantics for transient failures.
- Duplicate idempotency keys return existing result.

### Story 4.4: Wake command executor
Acceptance:
- Codex CLI runtime command execution supports `codex exec resume <session_id> <prompt>`.
- Retry/backoff policy for transient trigger failures.
- Fallback spawn path uses thread summary when resume target is unavailable.
- Resume attempts are capped at 2 before spawn fallback.
- Stale session (`>12h` heartbeat gap) skips resume and uses spawn path.
- Unmanaged runtime targets return explicit status and route to fallback behavior.

### Story 4.5: Versioning baseline implementation
Acceptance:
- All APIs are exposed under `/v1`.
- Message/event payloads include `schema_version` (and `event_version` where relevant).
- Compatibility tests validate additive schema evolution behavior.

## Epic 5: Pilot Workflow Integration
### Story 5.1: Executioner/reviewer pilot thread
Acceptance:
- Real review/fix/re-review flow completes in one thread.
- No human message relay required.

### Story 5.2: Operator escalation workflow
Acceptance:
- Escalation event visible to operator.
- Operator can unblock and continue thread.
- Operator override action requires explicit reason and is audit-logged.

### Story 5.5: CLI/JSON operator workflow validation
Acceptance:
- End-to-end operation is possible via CLI and JSON outputs only.
- No dashboard dependency exists in MVP execution path.
- CLI exposes inspect/escalate/unblock/override control commands.
- Mutating CLI controls emit audit events with explicit operator reason fields.

### Story 5.3: Dormant reviewer wake test
Acceptance:
- Reviewer session marked idle/offline receives wake trigger on unread message.
- Resume path successfully injects trigger prompt to existing logical session.
- Fallback spawn path is validated.

### Story 5.4: Pilot metrics review
Acceptance:
- Compare baseline and pilot cycle times.
- Capture user feedback and top pain points.

## Epic 6: Process-Level Trigger Infrastructure (PTY Supervisor)
### Story 6.1: Runtime registry and supervisor skeleton
Acceptance:
- Supervisor tracks runtime lifecycle (`register`, `heartbeat`, `deregister`).
- Runtime records include PID, PTY backend, PTY target, and logical `session_id`.
- Runtime records include management mode (`managed` or `unmanaged`).
- Stale runtime records expire via heartbeat policy.

### Story 6.2: tmux adapter (WSL/Linux)
Acceptance:
- Managed agents can be launched in named tmux targets.
- Trigger payload can be delivered via PTY write (`send-keys` equivalent).
- Health checks confirm target pane and process liveness.

### Story 6.3: Trigger acknowledgement and fallback chain
Acceptance:
- Trigger marked delivered only after ack signal (heartbeat or read cursor progress).
- Explicit runtime ACK marker support is optional for MVP and not required for success criteria.
- Timeout policy retries and then falls back to `codex exec resume`.
- Fallback path is fully audited with reason codes.

### Story 6.4: Operator safety and collision controls
Acceptance:
- Rate limits and dedupe keys prevent trigger storms.
- Operator can pause/resume trigger injection per runtime.
- Collision handling uses defer-and-queue default when human typing overlaps with triggers.
- Collision defaults are configurable and start with: quiet window `20s`, re-check `5s`, max defer `60s`.
- Force override path requires explicit operator action and audit reason.

### Story 6.5: Managed runtime enforcement
Acceptance:
- Autonomous trigger dispatcher rejects unmanaged runtime targets for process-level injection.
- Rejection returns deterministic error/status for orchestrator fallback handling.
- Operator guidance includes path to spawn/register managed runtime.

## Suggested Milestone Sequence
1. Epic 1
2. Epic 2
3. Epic 3
4. Epic 4
5. Epic 5
6. Epic 6

## Definition of Done (Project-Level)
- Core PRD requirements in MVP scope are implemented.
- Security acceptance criteria validated.
- Operational runbooks are published.
- Pilot success metrics are reported.
