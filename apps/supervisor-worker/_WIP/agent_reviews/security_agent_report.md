# Security & Architecture Boundary Review

Date: 2026-02-20
Scope: repository-wide review focused on auth claim handling, workspace isolation, unsafe defaults, audit/observability coverage, and architecture boundary adherence.

## Findings

### 1. High - Thread-level ACL is not enforced for read/write operations
- Evidence:
  - `apps/bridge-api/src/app.ts:636` (`get_thread`) only checks role + workspace, not membership.
  - `apps/bridge-api/src/app.ts:737` (`summarize_thread`) only checks role + workspace, not membership.
  - `apps/bridge-api/src/app.ts:911` (`post_message`) only checks role + workspace, not membership.
  - `apps/bridge-api/src/app.ts:1047` (`read_messages`) only checks role + workspace, not membership.
  - `apps/bridge-api/src/app.ts:1086` (`ack_read`) only checks role + workspace, not membership.
  - `apps/bridge-api/src/app.test.ts:509` and `apps/bridge-api/src/app.test.ts:910` demonstrate cross-participant read success by role.
- Risk:
  - Any same-workspace principal with an allowed role can read/post/ack on threads they are not a participant of.
  - Violates strict per-thread authorization intent in the architecture/security docs.
- Recommendation:
  - Enforce `isThreadParticipant` (or explicit coordinator override policy) for thread/message operations.
  - Add contract/integration tests that deny non-participant access within the same workspace.

### 2. High - Single-workspace trust-domain lock-in is not enforced by bridge-api
- Evidence:
  - `packages/shared/src/config/env.ts:38` requires `WORKSPACE_ID` in config.
  - `apps/bridge-api/src/main.ts:64` logs configured workspace, but no enforcement path is wired into request authorization.
  - `apps/bridge-api/src/app.ts:610`, `apps/bridge-api/src/app.ts:642`, `apps/bridge-api/src/app.ts:922` enforce claim-vs-resource matching only.
- Risk:
  - Service behavior is effectively multi-workspace if valid tokens are presented for multiple workspaces.
  - Conflicts with the MVP lock-in of a single-workspace trust domain.
- Recommendation:
  - Add explicit configured-workspace gate (reject requests when `claims.workspaceId !== configuredWorkspaceId`).
  - Add startup/runtime tests asserting non-configured workspace requests are rejected.

### 3. High - Fallback runtime launches with full sandbox/approval bypass by default
- Evidence:
  - `apps/supervisor-worker/src/runtime-fallback.ts:26` hardcodes `--dangerously-bypass-approvals-and-sandbox`.
  - Used in spawn path at `apps/supervisor-worker/src/runtime-fallback.ts:149`.
  - Used in resume path at `apps/supervisor-worker/src/runtime-fallback.ts:193`.
- Risk:
  - Trigger payloads are untrusted text inputs from collaboration flows; fallback execution grants maximal host capability by default.
  - Elevates prompt-injection impact into host-level compromise risk.
- Recommendation:
  - Remove dangerous flag from default path.
  - Gate high-privilege mode behind explicit operator-only override and audited config toggle.

### 4. Medium - Audit write failures are silently dropped
- Evidence:
  - `apps/bridge-api/src/app.ts:446` -> `writeAuditEvent` catches and ignores all failures at `apps/bridge-api/src/app.ts:453`.
- Risk:
  - Critical security events can be lost without any telemetry signal.
  - Undermines incident reconstruction and governance claims.
- Recommendation:
  - Emit explicit error logs + metrics on audit write failures.
  - Consider durable retry/dead-letter for audit writes.

### 5. Medium - Callback auth is optional, causing deterministic callback failure and dead-letter paths
- Evidence:
  - `packages/shared/src/config/env.ts:63` makes `WORKER_BRIDGE_ACCESS_TOKEN` optional.
  - `apps/supervisor-worker/src/trigger-callback.ts:82` fails callback when token missing (`CALLBACK_AUTH_TOKEN_MISSING`).
  - `apps/supervisor-worker/src/trigger-queue.ts:730` transitions callback failures to dead-letter state.
- Risk:
  - Worker-owned completion callback becomes non-functional by default configuration.
  - Produces audit/observability blind spots for trigger completion.
- Recommendation:
  - Make callback token required in production profile.
  - Fail fast on startup when callback is enabled but token is absent.

### 6. Medium - Unauthorized audit events can be attributed to attacker-controlled workspace IDs
- Evidence:
  - In auth failure path, workspace is derived from untrusted body when claims are absent:
    - `apps/bridge-api/src/app.ts:510`
    - `apps/bridge-api/src/app.ts:515`
  - Body extractor reads raw `workspace_id` from request payload:
    - `apps/bridge-api/src/app.ts:395`
- Risk:
  - Attackers can poison audit records with arbitrary workspace identifiers during unauthenticated/forbidden attempts.
  - Reduces trustworthiness of audit partitions and dashboards.
- Recommendation:
  - Use a neutral workspace bucket for unauthenticated failures (e.g., `unauthenticated`).
  - Store payload workspace only as untrusted metadata field.

### 7. Medium - Payload size limits are not explicit at protocol boundary (policy mismatch)
- Evidence:
  - Message/trigger inputs accept non-empty strings without max length constraints:
    - `packages/protocol/src/v1/message.ts:17`
    - `packages/protocol/src/v1/session.ts:40`
    - `packages/protocol/src/v1/common.ts:8`
  - PTY adapter later applies a max payload limit (`8192`) only at trigger delivery stage:
    - `apps/supervisor-worker/src/pty-adapter.ts:3`
    - `apps/supervisor-worker/src/pty-adapter.ts:82`
- Risk:
  - Large payloads can be persisted and propagated before runtime rejection, increasing storage/processing pressure.
  - Contradicts stated safety control requiring explicit max message/metadata sizes.
- Recommendation:
  - Define max body/prompt/metadata sizes in protocol schemas and enforce consistently at bridge ingress.

### 8. Low - Metrics endpoint exposure and unused metrics feature flag
- Evidence:
  - Metrics endpoint is always exposed without auth at `apps/bridge-api/src/app.ts:596`.
  - `METRICS_ENABLED` exists in config (`packages/shared/src/config/env.ts:47`) but is not used to gate route exposure.
  - Default `.env` binds API host to `0.0.0.0` (`.env.example:21`).
- Risk:
  - Unauthenticated operational telemetry exposure can aid reconnaissance.
- Recommendation:
  - Gate `/metrics` behind config and/or network/auth controls.
  - Honor `METRICS_ENABLED` in route registration.

## Architecture Boundary Notes
- No direct boundary violation found for tmux/process control location: process execution remains confined to `apps/supervisor-worker` (`apps/supervisor-worker/src/tmux-adapter.ts:1`).
- Primary boundary risks are policy-boundary drift (thread ACL, single-workspace enforcement), not package import direction.
