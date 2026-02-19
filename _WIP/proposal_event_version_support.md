# Proposal: Event Version Support for Message/Event Payloads (D-03)

## Context

- FR-15 requires message/event payload version metadata (`schema_version` or `event_version`).
- Backlog Story 4.5 requires `event_version` where relevant.
- Current code validates only `schema_version`; `event_version` is not modeled or normalized.

References:
- `docs/proposal/01-product/prd.md`
- `docs/proposal/04-protocol/protocol_spec.md`
- `docs/proposal/06-operations/implementation_backlog.md`

## Problem

The current protocol/API accepts event messages without explicit event schema versioning. This leaves event payload evolution ambiguous and keeps `_WIP/mvp_acceptance_checklist.md` row `D-03` unresolved.

## Goals

1. Add explicit event payload version support with backward compatibility.
2. Keep existing clients working (no breaking change for current event publishers).
3. Make idempotency semantics stable when `event_version` is omitted vs explicitly set.
4. Provide evidence via protocol, unit, and integration tests.

## Non-Goals

1. No API major version bump.
2. No broad event-type schema system in this change.
3. No mandatory DB column migration for `event_version` (use metadata JSON for MVP).

## Contract Design

### Canonical placement

- `event_version` is carried at `metadata.event_version` for `kind=event`.

### Compatibility behavior

- For `kind=event`:
  - If `metadata.event_version` is missing, server normalizes to `1`.
  - If present, it must be a positive integer.
- For `kind=chat|system`, no `event_version` requirement is applied.

### Idempotency behavior

- For event messages, payload comparison is done on canonicalized metadata:
  - missing `event_version` and `event_version=1` are equivalent.
  - different versions are different payloads and produce `IDEMPOTENCY_CONFLICT` for reused idempotency keys.

## Data Model Decision

- Keep storing event version in `messages.metadata` JSON (`metadata.event_version`).
- No new DB column in this change.
- Optional follow-up: backfill script/migration to set `event_version=1` for legacy event rows.

## Implementation Plan

### 1) Protocol package (`packages/protocol`)

- Add `CURRENT_EVENT_VERSION` and event version schema in `v1/common`.
- Update `post_message` input schema:
  - validate `metadata.event_version` for events.
  - normalize missing value to default `1`.
- Update message entity/output schema so event messages consistently include normalized metadata versioning.
- Extend contract tests for:
  - defaulting behavior,
  - invalid event version rejection,
  - compatibility with existing chat/system payloads.

### 2) Bridge API (`apps/bridge-api`)

- Canonicalize event metadata before:
  - idempotency replay comparison,
  - persistence.
- Ensure `read_messages` returns normalized event metadata for legacy rows missing `event_version`.

### 3) Thread store (`apps/bridge-api/src/thread-store.ts`)

- Normalize metadata from storage for event kind:
  - inject `event_version=1` when absent/invalid on read mapping.
- Keep behavior stable for non-event messages.

### 4) Docs updates

- Update protocol docs to state canonical/default behavior for event version.
- Update checklist `D-03` evidence after tests pass.
- Update `_WIP/pending_implementation_tasks.md` by removing/resolving `D-03`.

## Risks and Mitigations

### Risk 1: Idempotency behavior drift
- Mitigation: canonicalization helper used consistently for write and compare paths; dedicated tests for missing-vs-1 equivalence.

### Risk 2: Legacy rows without event version fail schema parse
- Mitigation: read-path normalization in thread-store before schema parse.

### Risk 3: Silent protocol drift
- Mitigation: protocol contract tests and docs update in the same change.

## Verification Plan

Required checks after implementation:

1. `tool/agent/pnpmw --no-stdin run lint`
2. `tool/agent/pnpmw --no-stdin run typecheck`
3. `tool/agent/pnpmw --no-stdin run test`
4. Focused suites:
   - `packages/protocol/src/v1/contracts.test.ts`
   - `apps/bridge-api/src/app.test.ts`
   - `apps/bridge-api/src/app.db.integration.test.ts` (if DB available)

## Acceptance Criteria

1. Event payloads support `metadata.event_version` with default normalization to `1`.
2. Existing event clients without `event_version` continue to work.
3. Idempotency behavior is deterministic under event version normalization.
4. Read responses include normalized event metadata versioning.
5. `D-03` can be marked pass with concrete test evidence.
