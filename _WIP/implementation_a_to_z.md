# Orkiva Implementation A-Z (High-Level)

## Purpose

This file is the end-to-end high-level implementation roadmap for Orkiva MVP.
Detailed task breakdowns will be created later per workstream.

Detailed workstream todos:

- `_WIP/todo_01_foundation_bootstrap.md` (A-E)
- `_WIP/todo_02_core_product_surface.md` (F-M)
- `_WIP/todo_03_runtime_orchestration.md` (N-U)

## Scope

- MVP only (single-workspace trust domain)
- Proposal lock-ins are mandatory
- No cross-workspace federation
- No dashboard requirement in MVP

## Gate 0 (Before Coding)

- [ ] Confirm proposal lock-ins are frozen for current sprint (`docs/proposal/07-decisions/open_questions.md`)
- [ ] Confirm architecture, protocol, security docs are the implementation source of truth
- [ ] Confirm Node 22 + `pnpm` + Postgres + tmux runtime baseline

## A-Z High-Level Todo

- [x] **A — Align** acceptance criteria across PRD, protocol, and backlog.
Done when: one merged MVP acceptance checklist exists and conflicts are removed.

- [x] **B — Bootstrap** repository structure (`apps/`, `packages/`, `infra/`) and workspace config.
Done when: monorepo builds and runs baseline scripts without feature code.

- [x] **C — Configure** quality gates (strict TypeScript, lint, format, test harness, CI skeleton).
Done when: local `verify` pipeline fails on violations and passes on clean baseline.

- [x] **D — Define** runtime configuration and environment contract.
Done when: validated env schema exists for API, worker, auth, db, and observability.

- [x] **E — Establish** Postgres schema and migration pipeline.
Done when: core tables (`threads`, `messages`, `cursors`, `sessions`, `trigger_*`, `audit`) are migrated and tested.

- [x] **F — Form** domain model and state-transition rules.
Done when: thread/message/session invariants are encoded in domain services with tests.

- [x] **G — Generate** protocol schemas and shared contract package.
Done when: `/v1` request/response + error schemas are versioned and reused by API and tests.

- [x] **H — Harden** identity verification and authorization.
Done when: signed token claims are required, claim mismatch is rejected, and ACL checks are enforced.

- [x] **I — Implement** thread APIs (`create_thread`, `get_thread`, `update_thread_status`, `summarize_thread`).
Done when: APIs pass unit + integration tests, including invalid transition paths.

- [x] **J — Implement** message APIs (`post_message`, `read_messages`, `ack_read`).
Done when: monotonic ordering, pagination, and cursor updates are validated.

- [x] **K — Keep** idempotency and retry-safe write behavior correct.
Done when: duplicate `idempotency_key` returns original write result deterministically.

- [x] **L — Lock** governance authority model in code paths.
Done when: worker cannot force-close disputes; orchestrator/human authority paths are enforced and audited.

- [x] **M — Manage** session registry and heartbeat lifecycle.
Done when: latest resumable session lookup per agent/workspace is reliable under concurrent updates.

- [ ] **N — Notify** participants via unread-state reconciliation flow.
Done when: polling fallback path consistently detects unread work and updates participant state.

- [ ] **O — Orchestrate** wake initiation (`trigger_participant`) at API layer.
Done when: wake requests enqueue deterministic trigger jobs with policy-aware routing decisions.

- [ ] **P — Provide** supervisor-worker runtime skeleton and registry reconciliation loop.
Done when: worker can register, reconcile, and transition runtime states robustly.

- [ ] **Q — Queue** trigger jobs with retries/backoff and dead-letter handling.
Done when: transient failure recovery works and irrecoverable jobs are visible for operator action.

- [ ] **R — Run** managed-runtime PTY adapter (tmux first).
Done when: supervisor can launch, target, and health-check role-specific tmux panes.

- [ ] **S — Safeguard** collision, loop, and rate-control policies.
Done when: busy-pane defer policy, loop auto-block, and rate limits are all enforced and test-covered.

- [ ] **T — Telemetry** baseline (logs, metrics, health/readiness, correlation IDs).
Done when: API and worker expose actionable metrics and structured audit-ready logs.

- [ ] **U — Unblock** fallback chain (`live trigger -> resume -> spawn`) and failure classification.
Done when: timeout/retry exhaustion deterministically selects fallback path and emits correct reason codes.

- [ ] **V — Validate** end-to-end integration scenarios.
Done when: executioner-reviewer workflow completes without manual relay in test environment.

- [ ] **W — Workflow** pilot operations and operator CLI/JSON controls.
Done when: operator can inspect, escalate, unblock, and override with auditable outcomes.

- [ ] **X — eXercise** security, resilience, and load tests.
Done when: auth abuse, cross-workspace rejection, failure spikes, and concurrency stress are validated.

- [ ] **Y — Yardstick** SLO/SLI and runbook readiness.
Done when: MVP targets are measured and incident runbooks are verified in drills.

- [ ] **Z — Zero-gap** launch readiness and handoff.
Done when: go-live checklist is signed off with known risks, rollback plan, and phase-2 backlog.

## Critical Path (Start Here)

- [x] 1. Complete **A, B, C, D, E** first (platform foundation).
- [x] 2. Then complete **F, G, H, I, J, K, L, M** (core product surface).
- [ ] 3. Then complete **N, O, P, Q, R, S, U** (runtime orchestration reliability).
- [ ] 4. Finish with **T, V, W, X, Y, Z** (operations, validation, launch readiness).

## Non-Goals in This File

- No detailed ticket-level subtasks yet
- No effort estimates yet
- No owner assignment yet

## Source References

- `docs/proposal/01-product/prd.md`
- `docs/proposal/02-architecture/solution_architecture.md`
- `docs/proposal/03-runtime/process_level_trigger_design.md`
- `docs/proposal/03-runtime/tmux_supervisor_implementation_spec.md`
- `docs/proposal/04-protocol/protocol_spec.md`
- `docs/proposal/05-security/security_and_governance.md`
- `docs/proposal/06-operations/implementation_backlog.md`
- `docs/proposal/07-decisions/open_questions.md`
