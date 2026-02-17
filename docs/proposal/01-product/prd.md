# Product Requirements Document (PRD)

## 1. Product Name
Orkiva

## 1.1 Plain Description
MCP that connects AI agent sessions so they can coordinate work on their own.

## 2. Summary
Orkiva enables direct communication between two or more isolated coding-agent sessions, combining free-form chat with structured workflow metadata to automate review/fix/re-review loops.

## 3. Goals
- Remove manual human copy-paste between sessions.
- Support natural chat between agents, not only event passing.
- Preserve machine-readable metadata for automation and observability.
- Enable safe multi-agent coordination with governance controls.

## 4. Non-Goals (MVP)
- Full autonomous orchestration of all software delivery stages.
- Replacing Git hosting platforms or PR systems.
- Cross-organization federated communication.
- End-to-end encryption between untrusted organizations.

## 5. Users
- Primary: advanced developers running multiple agent sessions.
- Secondary: teams using role-based agent workflows.
- Tertiary: platform engineers operating AI tooling infrastructure.

## 6. Problem to Solve
Current multi-session workflows are blocked by manual relaying. This creates latency, context drift, and operational burden, especially in review-heavy cycles.

## 7. Value Proposition
- Faster iteration loops.
- Better fidelity of findings and fixes.
- Higher autonomy with controlled risk.
- Replayable and auditable thread history.

## 8. User Stories
- As an operator, I want reviewer findings to reach execution agent without manual copy-paste.
- As an execution agent, I want to ask clarifying questions directly to reviewer agent in-thread.
- As a reviewer agent, I want to trigger re-review automatically when a fix is pushed.
- As an operator, I want escalation when agents loop or conflict.
- As a platform owner, I want audit logs and policy controls.

## 9. Functional Requirements
### FR-1 Threading
- System must support conversation threads with unique IDs.
- Threads must support multiple participants.
- Threads must expose status (`active`, `blocked`, `resolved`, `closed`).

### FR-2 Messaging
- Agents must be able to post free-form messages.
- Messages must support optional structured metadata.
- Messages must support reply chaining via `in_reply_to`.

### FR-3 Routing
- System must support directed messages (`to: [agent_id]`).
- System must support broadcast to thread participants.
- System must support role-level addressing (`to_role: reviewer`).

### FR-4 Synchronization
- Agents must read messages since cursor/offset.
- System must support ordering guarantees per thread.
- System must support idempotent message submit.

### FR-5 Workflow Signals
- System must support typed events (example: `finding_reported`, `fix_pushed`, `re_review_requested`, `resolved`).
- Events must coexist with free chat, not replace it.

### FR-6 Notifications
- Participants must be able to poll or subscribe for new messages.
- Delivery metadata must include unread count and last seen marker.

### FR-7 Search and Recall
- System should support filtering by thread, sender, event type, and status.
- System should support thread summary generation for context compression.

### FR-8 Governance Controls
- System must enforce workspace/project scoping.
- System must support retention policies.
- System must support immutable audit trail for key events.

### FR-9 Escalation
- System must support escalation markers and owner assignment.
- Escalation must include summarized context payload.

### FR-10 Agent Activation (Wake-Up)
- System must detect participants with unread messages and dormant sessions.
- System must support a wake trigger that reactivates the target agent runtime.
- For Codex CLI runtimes, bridge orchestration must support `codex exec resume <session_id> <prompt>` so new work is injected into the same logical session when available.

### FR-11 Identity Assurance
- All bridge operations must require platform-issued signed identity tokens.
- Authorization must rely on verified token claims, not runtime-asserted identity strings.
- Token claims must include `agent_id`, `workspace_id`, `role`, and `session_id` at minimum.

### FR-12 Primary Control Interface
- System operating model must support one orchestrator agent as the primary human-facing control interface.
- Direct human interaction with worker agents must remain available as a manual override capability.

### FR-13 Conflict Authority Model
- Human operator must hold final override authority for disputed thread closure/acceptance decisions.
- Orchestrator may apply operational status transitions (`blocked`, `reopen`, `needs_human_decision`).
- Worker agents must not force-close disputed threads.

### FR-14 Workspace Boundary Scope
- MVP must enforce single-workspace operation as one trust domain.
- Cross-workspace and cross-organization routing must be rejected in MVP.

### FR-15 Versioning Contract
- API endpoints must use major versioning (start at `/v1`).
- Message/event payloads must include schema version metadata (`schema_version` or `event_version`).
- Additive payload evolution is preferred; breaking changes require endpoint major version bump.

### FR-16 Loop Guard and Recovery Policy
- System must auto-block no-progress loops using configurable thresholds (MVP defaults: 20 turns or 3 repeated-identical finding cycles).
- Recovery order must be deterministic: live trigger -> resume (max 2 attempts) -> spawn with summary.
- Stale sessions (`>12h` heartbeat gap) may bypass resume and spawn directly.

### FR-17 Managed Runtime Policy
- Autonomous trigger lanes must target managed runtimes only (supervisor-controlled PTY targets).
- Unmanaged sessions are allowed for manual interaction but have no deterministic trigger guarantee.
- If a target is unmanaged, orchestration must use documented fallback behavior (`resume` or spawn-to-managed).

### FR-18 Human Input Collision Policy
- Trigger injection must defer when direct human input is active on the same runtime pane.
- MVP defaults: quiet window `20s`, defer re-check interval `5s`, max defer `60s`.
- Force override must require explicit operator intent and be fully audit-logged.

## 10. Non-Functional Requirements
### NFR-1 Reliability
- No message loss after server acknowledgement.
- Recoverable delivery after transient failure.

### NFR-2 Performance
- Median post-to-visibility latency under 500 ms in local deployment.
- P95 under 2 seconds for standard payload sizes.

### NFR-3 Scalability
- Support at least 100 active threads and 20 participants per thread in MVP target environments.

### NFR-4 Security
- Authentication required for all operations.
- Authorization at workspace and thread level.
- Basic secret-safe logging for tokens/credentials.
- Automated content filtering/redaction deferred for personal MVP.

### NFR-5 Observability
- Metrics for throughput, latency, failure, loop detection, and escalations.
- Correlation IDs for traceability across components.

### NFR-6 Compatibility
- Must be accessible as an MCP tool surface.
- Should support multiple agent runtimes with minimal adapter code.

### NFR-7 Activation Latency
- For dormant participants, message-to-wake-trigger dispatch should remain under 3 seconds (p95) in pilot environments.

## 11. MVP Scope
### In Scope
- Create/read/update thread state.
- Send/read chat messages.
- Optional structured metadata on messages.
- Basic role-based routing.
- Hybrid orchestration: trigger-first activation with polling fallback.
- Managed-runtime enforcement for autonomous trigger delivery.
- Human-input collision handling with defer-and-queue default.
- Permanent retention for personal MVP (no automatic expiry).
- Audit logging and minimal admin view.
- CLI/JSON operator experience (no web dashboard required for MVP).

### Out of Scope
- Full event streaming infrastructure.
- Advanced semantic routing and auto-agent assignment.
- Cross-tenant federation.
- Web dashboard/UI beyond CLI/JSON inspection.
- Automated content filtering/redaction pipeline.
- Tiered retention policies and auto-expiry jobs.
- Deterministic trigger delivery to unmanaged terminal tabs/windows.

## 12. Success Metrics
### Adoption
- At least 80 percent of multi-agent review workflows use bridge within pilot team.

### Efficiency
- Reduce manual relay operations by at least 70 percent.
- Reduce median review-fix-re-review cycle time by at least 30 percent.

### Quality
- Reduce lost-context incidents reported by users.
- Increase first-pass resolution rate for reviewer findings.

### Stability
- Less than 1 percent failed message delivery attempts after retry policy.

## 13. Risks
- Agent feedback loops causing runaway conversations.
- Sensitive data leakage in message logs.
- Overly rigid schema reducing conversational usefulness.
- Ambiguous ownership in large participant threads.

## 14. Dependencies
- MCP integration layer.
- Durable storage (Postgres from day one; optional Redis for higher-throughput fanout later).
- Agent identity model and policy engine.

## 15. Assumptions
- Sessions can call MCP tools.
- Platform identity issuer is available to mint and validate short-lived tokens.
- Teams accept chat logs for auditing in controlled environments.
- A lightweight supervisor/orchestrator process can run continuously per workspace.
- MVP runs in a single workspace trust domain.

## 16. Launch Criteria
- Core MVP requirements implemented and validated, including managed-runtime policy and collision handling defaults.
- Security baseline from `security_and_governance.md` met.
- Pilot run with at least one real executioner/reviewer workflow.
- Runbook and incident handling validated.
