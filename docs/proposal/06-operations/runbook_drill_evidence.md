# Runbook Drill Evidence (MVP)

## Drill Batch

- Date: `2026-02-18`
- Command baseline: `tool/agent/pnpmw --no-stdin run verify`
- Result: pass (all required suites green)

## Evidence Matrix

| Failure class | Drill type | Evidence |
|---|---|---|
| Service unavailable | readiness failure simulation | `apps/bridge-api/src/app.test.ts` (`returns 503 from /ready when dependency check fails`) |
| Storage lock/contention | concurrent write contention and conflict handling | `apps/bridge-api/src/app.test.ts` (`retries concurrent non-idempotent writes and preserves monotonic sequencing`) |
| Message delivery delay | trigger + unread/reconciliation pipeline validation | `apps/supervisor-worker/src/unread-reconciliation.test.ts`, `apps/supervisor-worker/src/trigger-queue.test.ts` |
| Authorization misconfiguration | ACL and identity mismatch rejection | `apps/bridge-api/src/app.test.ts` (`rejects payload identity mismatch hints`, `enforces workspace boundary checks`) |
| Token issuer outage / validation failure | invalid signature and missing token rejection | `packages/auth/src/auth.test.ts` (`rejects token with invalid signature`), `apps/bridge-api/src/app.test.ts` (`rejects requests without bearer token`) |
| Escalation flood | loop/rate guardrail enforcement under repeated findings | `apps/supervisor-worker/src/trigger-queue.test.ts` (`auto-blocks thread when repeated identical findings exceed threshold`, `applies per-thread+agent rate limits with deferred retries`) |
| Wake trigger failure | resume/spawn fallback chain and exhaustion behavior | `apps/supervisor-worker/src/runtime-fallback.test.ts`, `apps/supervisor-worker/src/trigger-queue.test.ts` (`executes fallback chain after max retry exhaustion`) |
| Unmanaged runtime target | deterministic fallback-required path | `apps/bridge-api/src/app.test.ts` (`returns deterministic fallback-required outcomes for unmanaged and missing sessions`), `apps/supervisor-worker/src/runtime-trigger-executor.test.ts` (`fails non-retryable when runtime is unmanaged`) |
| Human-input collision / deferred timeout | operator-busy defer semantics and timeout control | `apps/supervisor-worker/src/tmux-adapter.test.ts` (`returns operator-busy unless force override is enabled`), `apps/supervisor-worker/src/runtime-trigger-executor.test.ts` (`defers when operator is busy and respects defer timeout`) |

## Operational Notes

- Mutable operator actions are covered through CLI workflow tests with audit assertions:
  - `apps/operator-cli/src/main.test.ts`
- Cross-workspace abuse and malformed payload burst resilience are covered in:
  - `apps/bridge-api/src/security-load.test.ts`
