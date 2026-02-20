# Pending Implementation Tasks (Post Verification on `development`)

This list is derived from failed rows in `_WIP/mvp_acceptance_checklist.md` after code-based verification.

## Pending Items

| ID | Gap | What Still Needs Implementation | Suggested Target Files |
|---|---|---|---|
| O-03 | Missing end-to-end API->worker correlation-id assertion | Propagate correlation IDs through trigger queue/job attempts and assert trace continuity across API logs and worker processing logs. | `apps/bridge-api/src/app.ts`, `apps/supervisor-worker/src/trigger-queue.ts`, `apps/supervisor-worker/src/main.ts`, related tests |

## Notes

- All other checklist rows are currently marked pass with evidence links in `_WIP/mvp_acceptance_checklist.md`.
- This file tracks implementation gaps only. Operational re-verification should still run full `verify` before release decisions.
