# Detailed Todo 02: Core Product Surface (F-M)

## Goal

Implement the first usable Orkiva product slice:

- domain invariants and state transitions
- versioned protocol contracts
- authn/authz guards
- thread/message/session MCP methods
- idempotent write semantics
- governance authority enforcement

This phase covers:

- F (Form)
- G (Generate)
- H (Harden)
- I (Implement thread APIs)
- J (Implement message APIs)
- K (Keep idempotency/retry-safe writes)
- L (Lock governance authority)
- M (Manage session registry/heartbeat)

from `_WIP/implementation_a_to_z.md`.

## Why This Is Next

Foundation is complete. The next highest-leverage work is the core MCP surface and policy guardrails that all runtime orchestration depends on.

If F-M is not completed first:

- worker orchestration cannot safely trigger behavior
- security policy remains doc-only
- pilot workflow cannot be validated end-to-end

## 0) Preconditions (Gate Check)

- [x] Confirm lock-ins in `docs/proposal/07-decisions/open_questions.md` are still unchanged for this sprint.
- [x] Confirm `/v1` protocol and required claim baseline remain authoritative:
  - `docs/proposal/04-protocol/protocol_spec.md`
  - `docs/proposal/05-security/security_and_governance.md`
- [x] Confirm DB baseline from Todo 01 is healthy:
  - `pnpm run db:bootstrap`
  - `pnpm --filter @orkiva/db test:integration`
  - Note: previously validated on foundation completion; current local re-run is blocked because Docker engine is unavailable in this session.

Done when:
- [x] No unresolved scope ambiguity remains for F-M.

## 1) Form (F) — Domain Model and State Transition Rules

- [x] Implement pure domain model modules in `packages/domain/src`:
  - thread aggregate + transition rules
  - message posting constraints
  - participant cursor semantics
  - session registry heartbeat/staleness semantics
- [x] Add explicit domain errors (typed, machine-actionable).
- [x] Define transition guard for `thread_status`:
  - `active -> blocked|resolved|closed`
  - `blocked -> active|closed`
  - `resolved -> closed` (or reopen path only if policy explicitly allows)
  - reject invalid transitions deterministically
- [x] Keep domain package framework-free (no DB/transport/runtime coupling).
- [x] Add unit tests for all transition and invariant paths.

Done when:
- [x] Domain rules are encoded in pure functions/services with exhaustive tests.

## 2) Generate (G) — Protocol Schemas and Shared Contract Package

- [x] Implement versioned protocol schema modules in `packages/protocol/src/v1`:
  - input/output schemas for:
    - `create_thread`, `get_thread`, `update_thread_status`, `summarize_thread`
    - `post_message`, `read_messages`, `ack_read`
    - `heartbeat_session`
  - shared entity schemas (`thread`, `message`, `cursor`, `session`)
  - shared pagination and metadata schemas
- [x] Define normalized error schema + error code catalog for `/v1`.
- [x] Enforce `schema_version` rules for message payloads.
- [x] Export TypeScript types from schemas as the only API contract source for apps/tests.
- [x] Add contract tests with valid/invalid fixtures.

Done when:
- [x] All MCP method payloads are schema-validated and type-safe from one package.

## 3) Harden (H) — Identity Verification and Authorization

- [x] Implement access-token verification in `packages/auth` using `jose`:
  - signature verification (JWKS)
  - `iat/exp/jti` checks
  - required claim presence checks
- [x] Map verified claims to caller context:
  - `agent_id`, `workspace_id`, `role`, `session_id`
- [x] Reject payload identity mismatch with verified claims.
- [x] Implement role policy helpers:
  - `participant`, `coordinator`, `auditor`
- [x] Implement workspace-boundary guard (single-workspace trust domain).
- [x] Add auth tests:
  - missing/expired/invalid token
  - missing claims
  - claim mismatch
  - cross-workspace rejection

Done when:
- [x] Every protected bridge operation depends on verified claims and ACL checks.

## 4) Implement (I) — Thread MCP APIs

- [x] Wire `apps/bridge-api` runtime skeleton:
  - Fastify app bootstrapping
  - MCP method registration surface
  - request context + correlation IDs
- [x] Implement `create_thread` endpoint path:
  - validate input via protocol schema
  - enforce authz
  - persist thread + participants
  - return protocol-compliant response
- [x] Implement `get_thread` path with workspace ACL.
- [x] Implement `update_thread_status` with domain transition guard + authority checks.
- [x] Implement `summarize_thread` baseline behavior (deterministic and bounded).
- [x] Add unit + integration tests for positive/negative paths.

Done when:
- [x] Thread APIs are functional, policy-checked, and covered by tests.

## 5) Implement (J) — Message MCP APIs

- [x] Implement `post_message` path:
  - validated payload
  - claim-derived sender identity
  - monotonic `seq` assignment per thread
  - optional `in_reply_to` validation
- [x] Implement `read_messages` path:
  - deterministic ordering
  - pagination limit guardrails
  - `next_seq` + `has_more` semantics
- [x] Implement `ack_read` path:
  - cursor monotonic update (`last_read_seq` must not regress)
- [x] Add unit + integration tests for ordering and cursor behavior.

Done when:
- [x] Message read/write/ack behavior is deterministic and test-validated.

## 6) Keep (K) — Idempotency and Retry-Safe Writes

- [x] Enforce idempotency on `post_message` using `(thread_id, sender_agent_id, idempotency_key)`.
- [x] Return original persisted result for duplicate keys (no double write).
- [x] Ensure behavior under transient retry/concurrent duplicate request races.
- [x] Add concurrency-focused integration tests for duplicate key semantics.

Done when:
- [x] Duplicate submit behavior is deterministic and side-effect safe.

## 7) Lock (L) — Governance Authority in Code Paths

- [x] Enforce authority rules in `update_thread_status`:
  - worker role cannot force-close disputed threads
  - coordinator/human override path requires explicit reason
- [x] Add conflict handling for competing status updates (`CONFLICT` path).
- [x] Emit audit events for critical operations:
  - status transitions
  - auth failures
  - authority rejections
- [x] Add tests for authority and dispute scenarios.

Done when:
- [x] Governance rules are executable constraints, not documentation-only policy.

## 8) Manage (M) — Session Registry and Heartbeat Lifecycle

- [x] Implement `heartbeat_session` path:
  - upsert by `(agent_id, workspace_id)`
  - update `session_id`, `runtime`, `management_mode`, `resumable`, `status`, `last_heartbeat_at`
- [x] Implement registry lookup helper for latest resumable session by agent/workspace.
- [x] Implement stale session classification helper (`SESSION_STALE_AFTER_HOURS`).
- [x] Add tests for concurrent heartbeat updates and stale detection behavior.

Done when:
- [x] Session registry is reliable for downstream wake orchestration use.

## 9) Cross-Cutting Engineering Requirements

- [x] Keep architecture boundaries clean (`pnpm run deps:check` must pass).
- [x] Avoid adding dependencies without explicit rationale.
- [x] Use shared protocol/domain types across apps to prevent contract drift.
- [x] Keep logs structured and secret-safe.
- [x] Update proposal docs in same change if behavior/policy/protocol diverges.

## 10) Verification Matrix (Required Before Marking F-M Done)

- [x] `tool/agent/pnpmw --no-stdin run format`
- [x] `tool/agent/pnpmw --no-stdin run lint`
- [x] `tool/agent/pnpmw --no-stdin run typecheck`
- [x] `tool/agent/pnpmw --no-stdin run deps:check`
- [x] `tool/agent/pnpmw --no-stdin run test`
- [x] `tool/agent/pnpmw --no-stdin run verify`
- [x] DB-backed API integration tests pass against local Postgres.
- [x] Auth/ACL negative tests pass.
- [x] Contract tests for all implemented MCP methods pass.

## 11) F-M Exit Criteria

- [x] `F, G, H, I, J, K, L, M` all complete.
- [x] Core `/v1` thread/message/session APIs are usable with verified auth.
- [x] Idempotency and governance constraints are enforced and tested.
- [x] No unresolved high-severity risks for single-workspace MVP baseline.
  - Scope note: this applies to F-M core thread/message/session/auth/governance surface; runtime trigger reliability (`N+`) remains tracked separately.

## 12) Out of Scope for This Todo

- Runtime trigger executor reliability chain (`N+`, especially `O/P/Q/R/S/U`)
- Operator CLI full workflow (`W`)
- Load/security drill hardening (`X/Y/Z`)

## 13) Immediate Next Action (Implement First)

- [x] Start with Phase 1 (F): implement domain transition rules + tests.
- [x] Then Phase 2 (G): define protocol schemas for thread/message/session methods.
- [x] Then Phase 3 (H): implement token verification and authorization helpers in `packages/auth`.
- [x] Then Phase 4 (I): wire `bridge-api` runtime skeleton and thread APIs.
- [x] Then Phase 5 (J): implement message MCP methods (`post_message`, `read_messages`, `ack_read`).
- [x] Then Phase 6 (K): enforce idempotency race/concurrency semantics and retry-safety.
- [x] Then Phase 7 (L): enforce governance authority and conflict/audit policy paths.
- [x] Then Phase 8 (M): implement session registry heartbeat lifecycle and stale/session lookup helpers.
- [x] Then Phase 9: complete cross-cutting engineering requirements for this F-M scope.

Reason:
- Contract-first + domain-first sequencing reduces API churn and rework.
