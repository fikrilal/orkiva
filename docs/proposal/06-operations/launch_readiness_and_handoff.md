# MVP Launch Readiness and Handoff

## Release Scope

- Release track: `MVP pilot`
- API baseline: `/v1`
- Trust model: single-workspace only
- Sign-off date: `2026-02-18`

## Go/No-Go Decision

- Decision: `GO` for pilot rollout
- Scope guard: pilot environments only (no multi-team scale rollout yet)

## Signed Go-Live Checklist

| Checklist item | Status | Evidence |
|---|---|---|
| Functional acceptance criteria passed for pilot workflow | signed | `apps/bridge-api/src/workflow.integration.test.ts`, `_WIP/mvp_acceptance_checklist.md` (`F-09`) |
| Security checks passed | signed | `packages/auth/src/auth.test.ts`, `apps/bridge-api/src/security-load.test.ts` |
| Alerting/operational signals verified | signed | `apps/bridge-api/src/app.test.ts` (`/health`, `/ready`, `/metrics`), `docs/proposal/06-operations/slo_sli_baseline.md` |
| Runbooks published and drill-validated | signed | `docs/runbooks/mvp_incident_runbooks.md`, `docs/proposal/06-operations/runbook_drill_evidence.md` |
| Pilot operator controls verified | signed | `apps/operator-cli/src/main.test.ts` |

Sign-off authority for this document: engineering implementation owner (repository baseline sign-off).

## Known Risks (Accepted)

| Risk | Impact | Mitigation | Follow-up |
|---|---|---|---|
| DB integration suite is skipped when Postgres is not provisioned | medium | keep schema and migration checks in `db:bootstrap`; run pre-release DB smoke in target env | enforce DB-backed integration job in Phase 2 |
| SLI benchmark runs on in-memory harness and does not represent full infra variance | medium | keep threshold guard test + rerun benchmark in target pilot infra before each rollout | add environment-specific perf harness in Phase 2 |
| Operator controls currently rely on manual command execution | low | runbooks define deterministic CLI paths and explicit audit requirements | add guided operator workflows in Phase 2 |

## Rollback Plan

Trigger rollback if any of the following occurs:
- sustained auth failures (`UNAUTHORIZED` / `FORBIDDEN`) caused by config drift
- SLO regression beyond pilot threshold without immediate mitigation
- trigger orchestration failures leading to blocked workflow progress

Rollback steps:
1. Freeze new thread creation from clients.
2. Keep read-only diagnostics enabled (`inspect-thread`, health/readiness endpoints).
3. Revert to last known-good release commit.
4. Re-run `tool/agent/pnpmw --no-stdin run verify`.
5. Re-run pilot smoke workflow (`workflow.integration.test.ts`) before re-enabling writes.

## Operator Handoff

Baseline commands:
- Preflight: `tool/agent/doctor`
- Full quality gate: `tool/agent/pnpmw --no-stdin run verify`
- SLI baseline refresh: `tool/agent/pnpmw --no-stdin run ops:sli:pilot`
- Inspect thread: `tool/agent/pnpmw --no-stdin run dev:operator-cli -- inspect-thread --thread-id <id> --json`
- Escalate thread: `tool/agent/pnpmw --no-stdin run dev:operator-cli -- escalate-thread --thread-id <id> --reason <text>`
- Assign escalation owner: `tool/agent/pnpmw --no-stdin run dev:operator-cli -- assign-escalation-owner --thread-id <id> --owner-agent-id <agent> --reason <text>`
- Reassign escalation owner: `tool/agent/pnpmw --no-stdin run dev:operator-cli -- reassign-escalation-owner --thread-id <id> --owner-agent-id <agent> --reason <text>`
- Get escalation owner: `tool/agent/pnpmw --no-stdin run dev:operator-cli -- get-escalation-owner --thread-id <id> --json`
- Unblock thread: `tool/agent/pnpmw --no-stdin run dev:operator-cli -- unblock-thread --thread-id <id> --reason <text>`
- Override close: `tool/agent/pnpmw --no-stdin run dev:operator-cli -- override-close-thread --thread-id <id> --reason human_override:<text>`

Release cut reference:
- `docs/proposal/06-operations/release_tag_plan.md`

## Phase-2 Backlog (Post-MVP)

1. Add DB-backed integration tests to CI with managed Postgres provisioning.
2. Add environment-realistic latency benchmark pipeline (network + Postgres + worker load).
3. Add dashboard/alert rule package for SLI breach and trigger-failure trends.
4. Introduce retention and archival policy controls (non-personal mode).
5. Expand orchestration from pilot workflows to multi-team production guardrails.
