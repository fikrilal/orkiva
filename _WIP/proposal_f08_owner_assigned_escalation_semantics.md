# Proposal: F-08 Owner-Assigned Escalation Semantics

## Context
- `F-08` in `_WIP/mvp_acceptance_checklist.md` is still failing.
- Current operator workflow supports `escalate-thread`, `unblock-thread`, and `override-close-thread`, but there is no explicit escalation owner assignment lifecycle.
- PRD FR-9 requires escalation markers plus owner assignment.

## Goals
1. Add explicit escalation owner semantics for blocked threads.
2. Support assign, reassign, and read-owner operations.
3. Enforce authority rules for unblock/close when a blocked thread has an escalation owner.
4. Keep behavior auditable and deterministic.

## Non-Goals
1. No new MCP command family for escalation owner in this change.
2. No cross-workspace behavior changes.
3. No change to existing `/v1` command surface in bridge-api.

## Proposed Behavior
- Escalation owner is only meaningful while thread status is `blocked`.
- `escalate-thread` keeps status transition behavior and may include an optional initial owner assignment.
- Add CLI commands:
  - `assign-escalation-owner` (blocked + owner currently unset)
  - `reassign-escalation-owner` (blocked + owner currently set)
  - `get-escalation-owner`
- Unblock/close authority when blocked:
  - If `actor_agent_id == escalation_owner_agent_id`, allow unblock/close.
  - Otherwise require explicit override prefix (`human_override:` or `coordinator_override:`).
- Leaving `blocked` (`active` or `closed`) clears current escalation owner fields.

## Data Model
Add nullable columns on `threads`:
- `escalation_owner_agent_id` (text)
- `escalation_assigned_by_agent_id` (text)
- `escalation_assigned_at` (timestamptz)

Rationale:
- Keeps current owner state queryable without join complexity.
- Historical trail remains in immutable `audit_events`.

## Implementation Plan
### 1) DB + schema
- Update `packages/db/src/schema.ts` with escalation owner fields.
- Generate migration via `packages/db` drizzle workflow.

### 2) Operator CLI commands
- Extend parser (`apps/operator-cli/src/commands.ts`) with:
  - `assign-escalation-owner`
  - `reassign-escalation-owner`
  - `get-escalation-owner`
- Update CLI usage text (`apps/operator-cli/src/main.ts`).

### 3) Operator service + repository
- Extend `ThreadRecord` with optional escalation owner fields.
- Add repository methods for reading/updating owner assignment with optimistic checks.
- Enforce assignment preconditions and authority rules in `OperatorCliService`.
- Clear owner fields on transitions out of `blocked`.

### 4) Protocol schema (additive)
- Add optional escalation owner fields to thread entity schema in protocol.
- Keep fields optional to preserve backward compatibility.

### 5) Tests
- Expand `apps/operator-cli/src/main.test.ts` with scenario coverage:
  - escalate -> assign -> owner unblock
  - non-owner unblock rejected without override
  - non-owner unblock allowed with override
  - reassign semantics
  - invalid state transitions for assign/reassign
  - get owner behavior for assigned/unassigned

### 6) Docs + tracking
- Update rollout operator command docs with new CLI commands.
- Mark `F-08` pass in `_WIP/mvp_acceptance_checklist.md` if tests pass.
- Remove `F-08` from `_WIP/pending_implementation_tasks.md`.

## Risks and Mitigations
- **Risk:** authority ambiguity.
  - **Mitigation:** explicit actor-vs-owner checks and override prefixes.
- **Risk:** stale owner state after unblock/close.
  - **Mitigation:** clear owner fields on exit from blocked status.
- **Risk:** schema drift.
  - **Mitigation:** migration + tests + docs update in same change.

## Verification Plan
1. `pnpm --filter @orkiva/db run typecheck`
2. `pnpm --filter @orkiva/operator-cli run lint`
3. `pnpm --filter @orkiva/operator-cli run typecheck`
4. `pnpm --filter @orkiva/operator-cli test`

## Acceptance Criteria
- Owner assignment lifecycle exists and is enforceable.
- Unblock/close authority respects owner assignment or explicit override.
- Scenario tests cover owner-assigned escalation flow.
- `F-08` can be marked pass with evidence links.
