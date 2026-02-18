# Detailed Todo 03: Runtime Orchestration Reliability (N-U)

## Goal

Implement reliable autonomous wake/orchestration behavior on top of the completed core surface (F-M):

- unread-state reconciliation
- trigger initiation and execution pipeline
- managed runtime control (tmux first)
- retry/fallback reliability chain
- collision/loop/rate safeguards

This phase covers:

- N (Notify)
- O (Orchestrate)
- P (Provide)
- Q (Queue)
- R (Run)
- S (Safeguard)
- U (Unblock)

from `_WIP/implementation_a_to_z.md`.

## Why This Is Next

Core APIs, authz, governance, and session registry are complete.
The largest remaining MVP risk is runtime activation reliability, not API correctness.

If N-U is not completed:

- dormant participants will not be re-engaged consistently
- orchestration remains manual and brittle
- fallback behavior cannot be trusted in production-like flow

## 0) Preconditions (Gate Check)

- [x] Confirm lock-ins remain unchanged in:
  - `docs/proposal/07-decisions/open_questions.md`
- [x] Confirm runtime trigger design sources are authoritative:
  - `docs/proposal/03-runtime/process_level_trigger_design.md`
  - `docs/proposal/03-runtime/tmux_supervisor_implementation_spec.md`
  - `docs/proposal/04-protocol/protocol_spec.md`
- [x] Confirm F-M remains green (`tool/agent/pnpmw --no-stdin run verify`).
- [x] Confirm local runtime prerequisites:
  - Docker engine reachable
  - Postgres ready + migrated
  - tmux available in WSL runtime host

Done when:
- [x] No unresolved architecture/policy ambiguity remains for N-U scope.

## 1) Notify (N) — Unread-State Reconciliation Flow

- [x] Implement unread-state reconciliation service:
  - compare participant cursor vs latest thread sequence
  - detect unread work per participant deterministically
- [x] Implement polling fallback path for unread detection.
- [x] Ensure reconciliation is idempotent per tick/run window.
- [x] Add participant eligibility checks:
  - thread membership required
  - workspace boundary required
  - closed thread exclusion (unless explicitly allowed by policy)
- [x] Add tests:
  - no-unread path
  - unread exists path
  - multi-participant mixed state
  - deterministic repeat polling behavior

Done when:
- [x] Polling fallback reliably identifies unread participants without duplicate churn.

## 2) Orchestrate (O) — `trigger_participant` API Path

- [x] Implement `trigger_participant` MCP handler in `apps/bridge-api`.
- [x] Validate caller authority and workspace/thread scope.
- [x] Validate target participant membership in thread.
- [x] Resolve target session from session registry with stale policy inputs.
- [x] Persist deterministic trigger job records (`trigger_jobs`) with trace metadata.
- [x] Return protocol-compliant action/result envelope:
  - managed runtime path
  - fallback-required path for unmanaged/offline/no-session cases
- [x] Add tests:
  - happy path enqueue
  - unmanaged runtime deterministic fallback-required result
  - missing target/not participant failures
  - idempotent/retry-safe command behavior

Done when:
- [x] Wake initiation decisions are deterministic, auditable, and policy-safe.

## 3) Provide (P) — Supervisor Worker Skeleton

- [x] Implement `apps/supervisor-worker` runtime skeleton:
  - worker bootstrap + config loading
  - polling/dispatch loop
  - graceful shutdown
- [x] Add runtime registry lifecycle handlers:
  - register
  - heartbeat
  - reconcile status
  - deregister
- [x] Keep dependency boundaries strict:
  - process control only in worker app
  - no MCP transport leakage into worker internals
- [x] Add tests for worker loop and registry state transitions.

Done when:
- [x] Worker can reconcile and progress runtime states safely under normal and degraded paths.

## 4) Queue (Q) — Trigger Job Processing + Retry/Backoff

- [ ] Implement trigger job claim/lock strategy to avoid double-processing.
- [ ] Implement retry/backoff policy with bounded attempts.
- [ ] Implement dead-letter/final-failed visibility path.
- [ ] Persist attempt outcomes in `trigger_attempts` with reason codes.
- [ ] Add tests:
  - transient failure retry behavior
  - max-retry exhaustion behavior
  - concurrent worker safety

Done when:
- [ ] Trigger queue processing is retry-safe, bounded, and operationally transparent.

## 5) Run (R) — Managed Runtime PTY Adapter (tmux First)

- [ ] Implement PTY adapter interface in worker.
- [ ] Implement tmux adapter:
  - target resolution
  - safe stdin text delivery (`send-keys` style)
  - pane/process liveness checks
- [ ] Enforce payload safety:
  - trigger payload is text input only
  - bounded payload size
  - sanitized control chars per policy
- [ ] Add tests/mocks for adapter behavior and failure classifications.

Done when:
- [ ] Managed tmux runtimes can be targeted and validated reliably.

## 6) Safeguard (S) — Collision, Loop, and Rate Controls

- [ ] Implement collision policy defaults:
  - quiet window `20s`
  - re-check `5s`
  - max defer `60s`
- [ ] Implement per-agent/per-thread trigger rate limits.
- [ ] Implement loop safeguards:
  - auto-block after `20` no-progress turns
  - auto-block after `3` repeated-identical finding cycles
- [ ] Implement explicit force-override path with required audit reason.
- [ ] Add tests for collision defer/override and safeguard thresholds.

Done when:
- [ ] Safety controls are policy-complete, deterministic, and test-covered.

## 7) Unblock (U) — Fallback Chain and Failure Classification

- [ ] Implement deterministic fallback order:
  - live managed trigger
  - `resume` attempt (max 2)
  - spawn with thread summary
- [ ] Apply stale-session shortcut:
  - `>12h` stale skips direct resume when policy requires
- [ ] Apply crash-loop shortcut policy.
- [ ] Emit clear status/error classifications for every fallback hop.
- [ ] Add tests for each branch and terminal failure status.

Done when:
- [ ] Fallback chain execution is bounded, explainable, and auditable.

## 8) Cross-Cutting Engineering Requirements

- [ ] Maintain architecture boundaries (`tool/agent/pnpmw --no-stdin run deps:check`).
- [ ] Keep strict typing (`any`/implicit-any disallowed).
- [ ] Keep logs structured with correlation IDs and no secrets.
- [ ] Avoid new dependencies unless justified and documented.
- [ ] Update docs in same change when behavior/spec/policy changes:
  - protocol: `docs/proposal/04-protocol/*`
  - runtime: `docs/proposal/03-runtime/*`
  - security/governance: `docs/proposal/05-security/security_and_governance.md`
  - backlog/operations: `docs/proposal/06-operations/*`

## 9) Verification Matrix (Required During N-U)

- [x] `tool/agent/pnpmw --no-stdin run format`
- [x] `tool/agent/pnpmw --no-stdin run lint`
- [x] `tool/agent/pnpmw --no-stdin run typecheck`
- [x] `tool/agent/pnpmw --no-stdin run deps:check`
- [x] `tool/agent/pnpmw --no-stdin run test`
- [x] `tool/agent/pnpmw --no-stdin run verify`
- [ ] DB-backed integration tests pass for trigger/session/runtime paths.
- [ ] Deterministic fallback and collision behavior validated by scenario tests.

## 10) N-U Exit Criteria

- [ ] `N, O, P, Q, R, S, U` all complete.
- [ ] `trigger_participant` is production-safe for MVP lock-ins.
- [ ] Managed-runtime trigger + fallback chain is deterministic and auditable.
- [ ] No unresolved high-severity risks in runtime orchestration scope.

## 11) Out of Scope for This Todo

- Full telemetry maturation and SLO reporting (`T`, `Y`)
- Pilot workflow/go-live validation (`V`, `W`, `Z`)
- Broad resilience/load/security exercises outside scoped runtime paths (`X`)

## 12) Immediate Next Action (Implement First)

- [x] Start with Phase 1 (N): unread-state reconciliation and polling fallback baseline.
- [x] Then Phase 2 (O): implement `trigger_participant` API enqueue/decision path.

Reason:
- Reliable unread detection and deterministic trigger initiation are prerequisites for all downstream worker/runtime mechanics.
