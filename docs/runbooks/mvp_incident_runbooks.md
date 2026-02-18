# Orkiva MVP Incident Runbooks

## Scope

This runbook set is the operational baseline for Orkiva MVP.
It covers the required incident classes defined in `docs/proposal/06-operations/rollout_and_operations.md` section `3.1`.

## Standard Incident Flow

1. Open an incident ticket with UTC timestamp and impact statement.
2. Capture current system state before mutation:
   - `tool/agent/pnpmw --no-stdin run dev:operator-cli -- inspect-thread --thread-id <thread_id> --json`
3. Mitigate with the scenario-specific actions below.
4. Confirm recovery with health/readiness checks and targeted thread inspection.
5. Append audit evidence (command outputs, event IDs, and timeline) to the incident record.

## 1) Service Unavailable

Detection:

- `/health` fails or `/ready` returns non-200.

Immediate actions:

1. Verify API process and dependency state.
2. If `/ready` fails only, treat as dependency outage and avoid blind restarts.
3. Restore dependency and re-check `/ready`.

Verification:

- `GET /health` returns 200.
- `GET /ready` returns 200.

## 2) Storage Lock / Contention

Detection:

- Elevated `CONFLICT` responses on `post_message` or `update_thread_status`.

Immediate actions:

1. Inspect affected thread and trigger queue with `inspect-thread`.
2. Confirm retries are bounded and not causing trigger storms.
3. Temporarily reduce write pressure by pausing noisy automation lane if needed.

Verification:

- Conflict rate returns to normal baseline.
- Sequence ordering remains monotonic.

## 3) Message Delivery Delay

Detection:

- Rising post-to-visible or message-to-wake-trigger latency.

Immediate actions:

1. Inspect latest unread state and trigger jobs.
2. Run `trigger_participant` for impacted participant and capture result (`queued`, `fallback_required`).
3. If managed runtime is unavailable, follow fallback path (`resume` then `spawn`).

Verification:

- New messages become visible in expected SLO window.
- Trigger result and follow-up state are auditable.

## 4) Authorization Misconfiguration

Detection:

- Sudden increase in `FORBIDDEN`, `UNAUTHORIZED`, or `WORKSPACE_MISMATCH`.

Immediate actions:

1. Confirm token issuer/audience/JWKS settings.
2. Validate payload identity fields are aligned with verified claims.
3. Reject any request path that bypasses claim-derived authority.

Verification:

- Authorized requests succeed.
- Negative authorization tests still fail as expected.

## 5) Token Issuer Outage / Validation Failure

Detection:

- Signature verification failures or issuer unreachability.

Immediate actions:

1. Confirm issuer and JWKS availability.
2. Preserve fail-closed behavior for API calls.
3. Communicate degraded mode and halt risky manual overrides.

Verification:

- Signature verification path recovers.
- Authentication rejects invalid tokens and accepts valid tokens.

## 6) Escalation Flood

Detection:

- Rapid growth in blocked threads or repeated escalation events.

Immediate actions:

1. Identify high-noise threads via operator inspection.
2. Apply bounded unblocking/escalation workflow with explicit reasons:
   - `escalate-thread --thread-id <id> --reason <text>`
   - `unblock-thread --thread-id <id> --reason <text>`
3. Keep disputed closures protected behind explicit override reasons.

Verification:

- Escalation rate normalizes.
- Audit trail exists for all operator actions.

## 7) Wake Trigger Failure (`resume` unavailable or repeated errors)

Detection:

- Trigger jobs repeatedly timeout/fail and progress to fallback statuses.

Immediate actions:

1. Inspect runtime state and retry counters for affected participant.
2. Confirm deterministic fallback chain execution order:
   - managed trigger
   - `resume` (max 2)
   - spawn with summary
3. Escalate if fallback terminally fails.

Verification:

- Trigger outcomes are deterministic and auditable.
- No unbounded retry loops.

## 8) Unmanaged Runtime Target in Autonomous Lane

Detection:

- `trigger_participant` returns `fallback_required` due to unmanaged runtime.

Immediate actions:

1. Confirm runtime registration mode.
2. Keep autonomous injection disabled for unmanaged targets.
3. Route to fallback path and/or register managed runtime.

Verification:

- Autonomous lane rejects unmanaged targets consistently.
- Fallback behavior remains deterministic.

## 9) Human-Input Collision / Deferred Trigger Timeout

Detection:

- Trigger jobs repeatedly defer because operator is actively typing.

Immediate actions:

1. Respect defer policy defaults:
   - quiet window `20s`
   - re-check `5s`
   - max defer `60s`
2. Avoid force overrides unless necessary.
3. If defer window expires, allow documented fallback path.

Verification:

- Collision handling does not drop trigger intent.
- Override actions (if any) include explicit reason and audit evidence.
