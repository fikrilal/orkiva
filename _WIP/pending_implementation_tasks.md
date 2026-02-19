# Pending Implementation Tasks (Post Verification on `development`)

This list is derived from failed rows in `_WIP/mvp_acceptance_checklist.md` after code-based verification.

## Pending Items

| ID | Gap | What Still Needs Implementation | Suggested Target Files |
|---|---|---|---|
| D-04 | No compatibility suite for additive schema changes | Add fixture-based compatibility tests for previous payload versions to ensure additive changes do not break existing consumers. | `packages/protocol/src/v1/contracts.test.ts` (or new compatibility spec file under `packages/protocol/src/v1/`) |
| R-07 | Force override path is not explicitly audited end-to-end | Persist explicit override audit records (or assert existing records) for force-override trigger paths and add tests proving override intent + audit traceability. | `apps/supervisor-worker/src/trigger-queue.ts`, `apps/supervisor-worker/src/runtime-trigger-executor.ts`, `apps/supervisor-worker/src/trigger-queue.test.ts` |
| O-01 | Missing fault-injection replay assurance after ack | Add fault-injection tests that simulate transient write/read failures after server ack and verify no acknowledged message loss under replay/retry conditions. | `apps/bridge-api/src/app.db.integration.test.ts`, `apps/bridge-api/src/app.test.ts` |
| O-03 | Missing end-to-end API->worker correlation-id assertion | Propagate correlation IDs through trigger queue/job attempts and assert trace continuity across API logs and worker processing logs. | `apps/bridge-api/src/app.ts`, `apps/supervisor-worker/src/trigger-queue.ts`, `apps/supervisor-worker/src/main.ts`, related tests |

## Notes

- All other checklist rows are currently marked pass with evidence links in `_WIP/mvp_acceptance_checklist.md`.
- This file tracks implementation gaps only. Operational re-verification should still run full `verify` before release decisions.
