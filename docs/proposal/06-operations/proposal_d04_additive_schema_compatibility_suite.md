# Proposal: D-04 Add Compatibility Suite for Additive Schema Changes

## Context
- `D-04` in `_WIP/mvp_acceptance_checklist.md` is currently failing.
- The protocol package already validates current request/response schemas (`packages/protocol/src/v1/contracts.test.ts`), but it does not have a dedicated compatibility suite proving additive evolution safety across older payload shapes.
- MVP lock-in requires explicit schema/event versioning and compatibility coverage for additive changes.

## Goal
Add a fixture-based compatibility suite in `packages/protocol` that proves additive schema evolution does not break existing payload consumers.

## Non-Goals
1. No protocol major version changes.
2. No behavioral changes to API handlers in `apps/*`.
3. No breaking schema changes to existing contract fields.

## Requirements
1. Legacy payload fixtures (without newly-added optional fields) must still parse.
2. Additive payload fixtures (with optional newer fields) must parse.
3. Guardrail fixtures with incompatible changes (e.g., renamed/removed required fields, invalid version literals) must fail.
4. Coverage should include core protocol entities and method payloads where schema evolution risk is highest.

## Design

### 1) Fixture-Driven Compatibility Model
Create a compatibility fixture manifest under:
- `packages/protocol/src/v1/compatibility/fixtures.ts`

Each fixture case will contain:
- `id`: stable test identifier
- `schema`: schema target label
- `expect`: `"pass" | "fail"`
- `payload`: unknown JSON-like object

This keeps tests data-driven, easy to extend, and readable during future additive changes.

### 2) Harness and Schema Registry
Create:
- `packages/protocol/src/v1/compatibility/compatibility.test.ts`

The harness maps fixture `schema` keys to concrete Zod schemas from protocol v1, then executes parse assertions:
- `expect: "pass"` => `safeParse` success
- `expect: "fail"` => `safeParse` failure

### 3) Scope of Compatibility Coverage
Initial coverage set:
- `thread_entity`
- `message_entity`
- `session_entity`
- `post_message_input`
- `read_messages_output`
- `trigger_participant_output`

These cover additive evolution around:
- optional object fields,
- event metadata normalization,
- status/action enums,
- schema-version invariants.

### 4) Guardrail Strategy
Include explicit negative fixtures for non-additive changes:
- missing required fields,
- invalid `schema_version`,
- invalid enum literals,
- invalid explicit `metadata.event_version`.

This prevents false confidence where “compatibility” silently allows incompatible drift.

## Implementation Plan
1. Add compatibility fixture manifest in `packages/protocol/src/v1/compatibility/fixtures.ts`.
2. Add schema-registry harness in `packages/protocol/src/v1/compatibility/compatibility.test.ts`.
3. Add fixtures for legacy/additive/negative coverage for target schema list.
4. Run protocol checks (`lint`, `typecheck`, `test`).
5. Update `_WIP/mvp_acceptance_checklist.md` (`D-04` => pass with evidence).
6. Remove `D-04` from `_WIP/pending_implementation_tasks.md`.

## Risks and Mitigations
- **Risk:** Fixtures become stale when schema evolves.
  - **Mitigation:** Keep fixtures colocated with protocol source and add explicit IDs for surgical updates.
- **Risk:** Compatibility tests overlap heavily with existing contract tests.
  - **Mitigation:** Keep contract tests focused on current behavior; compatibility suite focuses on cross-version payload shape safety.
- **Risk:** Overly broad fixture scope increases maintenance cost.
  - **Mitigation:** Start with high-risk schema surfaces only; expand only when new additive changes land.

## Verification Plan
1. `pnpm --filter @orkiva/protocol run lint`
2. `pnpm --filter @orkiva/protocol run typecheck`
3. `pnpm --filter @orkiva/protocol test`

## Acceptance Criteria
- Dedicated fixture-based compatibility suite exists under `packages/protocol/src/v1/compatibility/`.
- Suite includes legacy-pass, additive-pass, and incompatible-fail fixtures.
- Protocol test run passes with compatibility suite enabled.
- `_WIP/mvp_acceptance_checklist.md` and `_WIP/pending_implementation_tasks.md` are updated accordingly.
