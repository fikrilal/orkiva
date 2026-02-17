# Repository Guidelines

This file is the AI/contributor implementation policy for Orkiva.
It is intentionally strict: consistency, safety, and long-term maintainability are required.

If a change modifies behavior, architecture, protocol, or governance policy, update the docs in the same change.

## 1) Read First (Mandatory)

Before coding, read the relevant source-of-truth docs:

- Docs index: `docs/proposal/README.md`
- Product/requirements: `docs/proposal/01-product/prd.md`
- Solution architecture: `docs/proposal/02-architecture/solution_architecture.md`
- Stack lock-ins: `docs/proposal/02-architecture/technical_stack_and_architecture.md`
- Runtime trigger design: `docs/proposal/03-runtime/process_level_trigger_design.md`
- tmux supervisor spec: `docs/proposal/03-runtime/tmux_supervisor_implementation_spec.md`
- MCP/protocol contracts: `docs/proposal/04-protocol/protocol_spec.md`
- MCP command catalog: `docs/proposal/04-protocol/mcp_command_catalog.md`
- Security baseline: `docs/proposal/05-security/security_and_governance.md`
- Delivery backlog: `docs/proposal/06-operations/implementation_backlog.md`
- Locked decisions: `docs/proposal/07-decisions/open_questions.md`

## 2) MVP Lock-Ins (Do Not Violate)

- Single-workspace trust domain only. Cross-workspace routing is rejected in MVP.
- Hybrid orchestration: trigger-first with polling fallback.
- Runtime wake order is fixed: managed live trigger -> `resume` (max 2) -> spawn with thread summary.
- Managed runtime is required for autonomous trigger delivery.
- Human-input collision defaults are fixed unless explicitly changed by decision:
  - quiet window `20s`
  - defer re-check `5s`
  - max defer `60s`
- Loop safeguards are fixed unless explicitly changed by decision:
  - auto-block at `20` no-progress turns
  - auto-block at `3` repeated-identical finding cycles
- Personal MVP data policy is fixed:
  - indefinite retention
  - no automated content filtering/redaction pipeline
- API major version baseline is `/v1`.
- Message/event payloads must carry schema version fields (`schema_version`, `event_version` where relevant).

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

## 8) Coding Quality Standards

- Prefer explicit, readable control flow over implicit magic.
- Keep modules cohesive and small; avoid god-classes/services.
- Use domain-oriented naming; no vague names like `data`, `stuff`, `util2`.
- Prefer value objects/enums over untyped stringly-typed state.
- Write meaningful logs with correlation IDs, but never log secrets.
- Handle failure paths deliberately; avoid swallowing errors.
- Keep public interfaces minimal and stable.

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

## 10) Windows/WSL Tooling Policy

This repo is commonly used from WSL on `/mnt/c/...`.
Use wrapper scripts to avoid Linux/Windows artifact drift.

- Preflight: `tool/agent/doctor`
- Git: `tool/agent/gitw --no-stdin ...`
- Node: `tool/agent/nodew --no-stdin ...`
- PNPM: `tool/agent/pnpmw --no-stdin ...`
- Docker: `tool/agent/dockw --no-stdin ...`
- Generic wrapper: `tool/agent/winrun --no-stdin -- <command> ...`

In agent automation and non-interactive flows, always use `--no-stdin`.

## 11) Documentation and Decision Hygiene

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

## 12) AI Agent Workflow (Required)

1. Read relevant docs first.
2. State assumptions and risks before broad implementation.
3. Implement the smallest correct change.
4. Run relevant verification checks.
5. Summarize changed files, risks, and follow-ups.
6. Do not commit or push unless explicitly requested.

## 13) Definition of Done

A task is done only when all of the following are true:

- Implementation satisfies requested behavior and MVP constraints.
- Architecture boundaries are respected.
- Security/authority rules are preserved.
- Relevant tests/checks have been run (or explicitly documented as blocked).
- Required docs/spec updates are included.
- No known regression is left undocumented.
