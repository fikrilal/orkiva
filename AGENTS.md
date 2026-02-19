# Repository Guidelines

This file is the AI/contributor implementation policy for Orkiva.
It is intentionally strict: consistency, safety, and long-term maintainability are required.

If a change modifies behavior, architecture, protocol, or governance policy, update the docs in the same change.

## 1) Pre-Change Context (Mandatory)

Before making changes, do this in order:

1. Open the docs index: `docs/proposal/README.md`.
2. Read only the source-of-truth docs relevant to the area you will touch:
   - Product/scope: `docs/proposal/01-product/prd.md`
   - Architecture/boundaries: `docs/proposal/02-architecture/solution_architecture.md`, `docs/proposal/02-architecture/technical_stack_and_architecture.md`
   - Runtime behavior: `docs/proposal/03-runtime/process_level_trigger_design.md`, `docs/proposal/03-runtime/tmux_supervisor_implementation_spec.md`
   - Protocol/API contracts: `docs/proposal/04-protocol/protocol_spec.md`, `docs/proposal/04-protocol/mcp_command_catalog.md`
   - Security/governance: `docs/proposal/05-security/security_and_governance.md`
   - Backlog/decisions: `docs/proposal/06-operations/implementation_backlog.md`, `docs/proposal/07-decisions/open_questions.md`
3. If requirements conflict or are ambiguous, stop and ask before implementing irreversible behavior.

## 2) MVP Lock-Ins (Agent Constraints)

Treat these as hard constraints unless a decision doc is updated in the same change:

- Workspace scope: single-workspace trust domain only; reject cross-workspace routing.
- Runtime orchestration: trigger-first with polling fallback; wake order is `managed live trigger -> resume (max 2) -> spawn with thread summary`.
- Autonomous triggering: managed runtime required; unmanaged runtime must return deterministic fallback-required outcome.
- Collision policy defaults are fixed: quiet `20s`, defer re-check `5s`, max defer `60s`.
- Loop safeguards are fixed: auto-block at `20` no-progress turns or `3` repeated-identical finding cycles.
- Personal MVP data policy is fixed: indefinite retention, no automated filtering/redaction pipeline.
- API and payload versioning are fixed: major path `/v1`; payloads must carry `schema_version` and `event_version` where relevant.
- If any lock-in must change, update decision/docs in the same PR; do not silently drift behavior.

## 3) Non-Negotiables (Hard Rules)

- TypeScript strict mode is mandatory.
- `any`, `as any`, and implicit `any` are forbidden.
- Do not bypass type checks with `@ts-ignore` unless explicitly approved and documented.
- Keep changes small, focused, and reversible.
- No speculative abstractions and no premature generalization.
- When requirements are ambiguous, ask clarifying questions before implementing irreversible behavior.
- Do not add dependencies without clear justification and docs impact review.
- For third-party library behavior, check official docs first (Context7 preferred when available).
- Runtime and package manager baseline are fixed for MVP: Node 22 and `pnpm`.
- Do not hardcode secrets or tokens anywhere in source, fixtures, logs, or docs.
- Do not claim tests/checks passed unless they were actually run.
- Do not silently change protocol shapes, error codes, or authority rules.

## 4) Architecture Boundaries (Strict)

Follow the proposed architecture and keep dependency direction clean.

Target structure baseline:

- `apps/bridge-api`: MCP/HTTP surface, policy enforcement, thread/message/session orchestration.
- `apps/supervisor-worker`: trigger execution, tmux runtime control, fallback chain, collision handling.
- `apps/operator-cli`: operator diagnostics/override commands.
- `packages/domain`: pure domain logic. No transport, DB, tmux, or framework coupling.
- `packages/protocol`: schemas/contracts/errors.
- `packages/db`: schema, migrations, persistence concerns.
- `packages/auth`: token verification and claim mapping.
- `packages/observability`: logging/metrics/tracing setup.

Boundary rules:

- `apps/*` may depend on `packages/*`.
- `packages/domain` must not depend on app or infra modules.
- `tmux` and process-control code only belongs in `apps/supervisor-worker`.
- MCP transport code only belongs in `apps/bridge-api`.

## 5) Protocol and API Discipline

- MCP command surface for MVP is locked to:
  - `create_thread`, `get_thread`, `update_thread_status`, `summarize_thread`
  - `post_message`, `read_messages`, `ack_read`
  - `heartbeat_session`, `trigger_participant`
- `post_message` must support idempotency semantics.
- Message ordering is monotonic per-thread sequence and deterministic on replay.
- Structured metadata is optional for chat but standardized for events.
- Error responses must be explicit, stable, and machine-actionable.
- Breaking protocol changes require a major-version decision and docs update.

## 6) Security and Governance Rules

- Every bridge call must be authenticated with platform-issued signed short-lived tokens.
- Verified claims are the only source of identity truth.
- Required claims baseline: `agent_id`, `workspace_id`, `role`, `session_id`, `iat`, `exp`, `jti`.
- Payload identity fields are informational only and must match verified claims.
- Claim mismatch must be rejected and audited.
- Authorization must be checked per operation and per thread/workspace scope.
- Worker agents cannot force-close disputed threads.
- Human operator has final override authority for disputes.

## 7) Runtime Trigger Safety Rules

- Trigger payloads are text input for agent runtime, never shell-executed commands.
- Sanitize trigger text; enforce payload size limits.
- Every trigger attempt must be auditable with reason/result/fallback metadata.
- Autonomous trigger path must reject unmanaged runtimes and return deterministic fallback-required status.
- Acknowledgement confirmation should come from cursor progression and/or heartbeat updates.
- Retries must be bounded with backoff, then fallback chain must execute.

## 8) Engineering Principles (Default)

Apply these by default when making changes:

- SOLID and DRY: keep responsibilities focused, depend on abstractions at boundaries, remove duplicated logic that can drift.
- KISS: pick the simplest design that satisfies current requirements and remains understandable months later.
- YAGNI: do not add speculative abstractions or extension points without a real second use case.
- Separation of concerns: keep transport, domain, persistence, and integration concerns separated.
- High cohesion, low coupling: keep modules internally focused and externally minimal.
- Composition over inheritance: prefer small composable units to deep inheritance trees.
- Law of Demeter: avoid chain-calling through internals of collaborators.
- Command-query separation: keep side-effecting operations and data retrieval explicit.
- Make invalid states hard to represent: use strict types, value objects, and validation at boundaries.
- Favor explicit state transitions and immutability where practical.
- Boundary robustness: external operations should be idempotent, timeout-bounded, retry-safe, and auditable.
- Observability-first: emit structured logs/metrics/traces with correlation IDs for critical paths.
- Least astonishment: prefer obvious behavior over clever behavior; avoid hidden coupling and magic defaults.

## 9) Testing and Verification (Required)

Run relevant checks before handoff whenever feasible.

Minimum verification expectations for affected scope:

- Lint
- Typecheck
- Unit tests
- Integration tests for touched modules
- Security/auth tests for auth/ACL/claim changes
- Contract tests for MCP/protocol changes

If DB or schema changes are involved:

- Run migrations locally and verify forward application.
- Validate ordering/idempotency behavior for message writes.

If runtime trigger behavior changes:

- Validate happy path trigger delivery.
- Validate timeout/retry/fallback chain.
- Validate human-collision defer path and max-defer fallback.

If checks cannot run, explicitly state why and list the exact commands that should be run.

## 10) Documentation and Decision Hygiene

Any change that affects behavior/spec/policy must update docs in the same change.

Update these files when relevant:

- Protocol behavior or payloads:
  - `docs/proposal/04-protocol/protocol_spec.md`
  - `docs/proposal/04-protocol/mcp_command_catalog.md`
- Runtime trigger behavior:
  - `docs/proposal/03-runtime/process_level_trigger_design.md`
  - `docs/proposal/03-runtime/tmux_supervisor_implementation_spec.md`
- Security/governance changes:
  - `docs/proposal/05-security/security_and_governance.md`
- Scope/requirements or lock-in changes:
  - `docs/proposal/01-product/prd.md`
  - `docs/proposal/07-decisions/open_questions.md`
- Delivery plan/backlog impact:
  - `docs/proposal/06-operations/implementation_backlog.md`
  - `docs/proposal/06-operations/rollout_and_operations.md`

If a lock-in is changed, update the decision register with rationale and date in the same PR.

## 11) AI Agent Workflow (Required)

1. Read relevant docs first.
2. State assumptions and risks before broad implementation.
3. Implement the smallest correct change.
4. Run relevant verification checks.
5. Summarize changed files, risks, and follow-ups.
6. Do not commit or push unless explicitly requested.

## 12) Definition of Done

A task is done only when all of the following are true:

- Implementation satisfies requested behavior and MVP constraints.
- Architecture boundaries are respected.
- Security/authority rules are preserved.
- Relevant tests/checks have been run (or explicitly documented as blocked).
- Required docs/spec updates are included.
- No known regression is left undocumented.
