# Detailed Todo 01: Foundation Bootstrap (Implement First)

## Goal

Create the minimum production-grade foundation required to start implementing Orkiva features without rework.

This phase covers:

- A (Align)
- B (Bootstrap)
- C (Configure)
- D (Define)
- E (Establish)

from `_WIP/implementation_a_to_z.md`.

## Why This Is First

Without this phase, feature work (threads/messages/triggers) will fragment:

- no stable module boundaries
- no repeatable verification pipeline
- no DB migration workflow
- no config contract for runtime behavior

## 1) Align (A) — MVP Acceptance Baseline

- [x] Create `_WIP/mvp_acceptance_checklist.md`.
- [x] Merge acceptance criteria from:
  - `docs/proposal/01-product/prd.md`
  - `docs/proposal/04-protocol/protocol_spec.md`
  - `docs/proposal/06-operations/implementation_backlog.md`
- [x] Resolve conflicts into one normalized checklist:
  - required behavior
  - explicit non-goals
  - test evidence expected
- [x] Add pass/fail columns for each item.

Done when:
- [x] One checklist exists and becomes the reference for implementation PR validation (`_WIP/mvp_acceptance_checklist.md`).

## 2) Bootstrap (B) — Monorepo Skeleton

- [ ] Create root structure:
  - `apps/bridge-api`
  - `apps/supervisor-worker`
  - `apps/operator-cli` (skeleton only)
  - `packages/domain`
  - `packages/protocol`
  - `packages/db`
  - `packages/auth`
  - `packages/observability`
  - `packages/shared`
  - `infra`
- [ ] Add root workspace files:
  - `package.json`
  - `pnpm-workspace.yaml`
  - `tsconfig.base.json`
  - `.gitignore`
  - `.editorconfig`
  - `.npmrc` (if needed)
- [ ] Add minimal app entrypoints:
  - `apps/bridge-api/src/main.ts`
  - `apps/supervisor-worker/src/main.ts`
  - `apps/operator-cli/src/main.ts`
- [ ] Add root scripts for build/dev/test/verify placeholders.

Done when:
- `pnpm install`
- `pnpm -r build`
- `pnpm -r test`
run successfully on baseline skeleton.

## 3) Configure (C) — Quality Gates and CI Baseline

- [ ] Configure TypeScript strict mode globally.
- [ ] Configure ESLint + Prettier with repo-wide standards.
- [ ] Configure Vitest baseline and test file conventions.
- [ ] Add `verify` script chaining:
  - lint
  - typecheck
  - test
- [ ] Add CI workflow skeleton that runs verify on PR.
- [ ] Ensure failures are deterministic and useful.

Done when:
- A deliberate lint/type/test failure is caught by local verify and CI.

## 4) Define (D) — Runtime Config Contract

- [ ] Create environment schema package (`packages/shared` or dedicated config module).
- [ ] Use schema validation (`zod`) for:
  - API config
  - worker config
  - DB config
  - auth/jwks config
  - observability config
  - trigger policy config (timeouts/retries/collision windows)
- [ ] Provide `.env.example` with documented defaults.
- [ ] Fail fast on invalid config at startup.

Done when:
- Starting any app with invalid/missing critical env exits with clear errors.

## 5) Establish (E) — Database and Migration Baseline

- [ ] Set up `packages/db` with Drizzle config.
- [ ] Create initial schema for MVP tables:
  - `threads`
  - `thread_participants`
  - `messages`
  - `participant_cursors`
  - `session_registry`
  - `trigger_jobs`
  - `trigger_attempts`
  - `audit_events`
- [ ] Add migration generation and apply scripts.
- [ ] Add `infra/docker-compose.yml` for Postgres 16.
- [ ] Add DB readiness probe and migration bootstrap command.
- [ ] Add minimal DB integration test for migration + connectivity.

Done when:
- Fresh environment can boot Postgres, run migrations, and pass DB smoke test from CI/local.

## 6) Foundation Exit Criteria

- [ ] MVP acceptance checklist exists.
- [ ] Repo skeleton compiles and tests cleanly.
- [ ] Strict quality gates and CI baseline are active.
- [ ] Runtime env schema is validated at startup.
- [ ] DB schema + migrations are executable from clean checkout.
- [ ] All docs updated for any deviation from proposal defaults.

## 7) Risks to Watch Early

- [ ] Boundary drift between `apps/*` and `packages/*`.
- [ ] Hidden coupling between API and worker internals.
- [ ] Inconsistent script names that break future automation.
- [ ] Migration churn from premature schema changes.
- [ ] WSL/Windows command drift if wrappers are bypassed.

## 8) Immediate Next Action (Do This First)

- [ ] Implement **Bootstrap (B)** first in code:
  - scaffold workspace and package boundaries
  - add minimal runnable entrypoints
  - add root scripts

Reason:
- It unlocks all other workstreams and gives a stable base for C/D/E.
