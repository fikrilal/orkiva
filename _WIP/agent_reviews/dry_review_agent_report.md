# DRY/KISS/YAGNI Review Report

Scope reviewed: `apps/supervisor-worker` with cross-repo checks where the same runtime/thread contracts are reused.

## Findings

### 1) High: Trigger job contract is duplicated across apps (DRY violation, drift risk)
- Duplicate status union and record shape are defined in:
  - `apps/supervisor-worker/src/trigger-queue.ts:6`
  - `apps/bridge-api/src/trigger-store.ts:5`
  - `apps/operator-cli/src/service.ts:31`
- Why this is a problem:
  - Any status evolution now requires synchronized edits in multiple apps.
  - A missing update in one app will compile locally but fail behaviorally at runtime/reporting boundaries.
- KISS/DRY fix:
  - Move `TriggerJobStatus` and `TriggerJobRecord` to one shared contract source (`packages/protocol` or `packages/domain`), and consume it from all three apps.

### 2) High: `createOrReuseTriggerJob` logic is reimplemented twice (same DB semantics, same conflict flow)
- Very similar upsert-and-read-conflict code exists in:
  - `apps/bridge-api/src/trigger-store.ts:119`
  - `apps/supervisor-worker/src/trigger-queue.ts:1154`
- In-memory mirror is also duplicated:
  - `apps/bridge-api/src/trigger-store.ts:95`
  - `apps/supervisor-worker/src/trigger-queue.ts:975`
- Why this is a problem:
  - Same persistence behavior is maintained in parallel, raising regression risk.
  - Behavior drift (e.g., column handling, null normalization) is easy to introduce.
- DRY fix:
  - Extract shared trigger-job repository implementation (likely under `packages/db`), and keep app-specific stores thin adapters only when truly required.

### 3) High: Session heartbeat upsert pipeline is duplicated (runtime registry vs session store)
- Near-identical write path exists in:
  - `apps/supervisor-worker/src/runtime-registry.ts:166`
  - `apps/bridge-api/src/session-store.ts:99`
- Both perform:
  - normalize heartbeat
  - optimistic update by heartbeat timestamp
  - fallback read
  - insert on miss
  - read-after-insert
  - throw on impossible miss
- Why this is a problem:
  - Critical consistency logic is copy-maintained in two services.
  - Any correctness fix must be remembered twice.
- DRY fix:
  - Promote this to one shared session-registry persistence primitive in `packages/db` (or shared service module) and compose it in both apps.

### 4) Medium: Stale-session calculation uses repeated synthetic object construction (`"n/a"` placeholders)
- Repeated manual object reconstruction appears in:
  - `apps/supervisor-worker/src/unread-reconciliation.ts:95`
  - `apps/supervisor-worker/src/unread-reconciliation.ts:172`
- Why this is a problem:
  - Boilerplate obscures intent.
  - Placeholder fields (`agentId: "n/a"`, `runtime: "n/a"`) are a smell and can hide misuse.
- KISS fix:
  - Add a local helper `isSessionSnapshotStale(sessionSnapshot, staleAfterHours, at)` and use it in both call sites.

### 5) Medium: Override reason policy is duplicated across API and CLI
- Same literal policy exists in:
  - `apps/bridge-api/src/app.ts:214`
  - `apps/operator-cli/src/service.ts:7`
- Same prefix-check helpers:
  - `apps/bridge-api/src/app.ts:218`
  - `apps/operator-cli/src/service.ts:293`
- Why this is a problem:
  - Governance/security rule can drift between operator and API paths.
- DRY fix:
  - Extract one shared constant/helper (e.g., `packages/domain` policy module) and import it in both places.

### 6) Low: Pass-through abstractions with no behavioral value (YAGNI/KISS)
- `isSessionRecordStale` is a direct alias:
  - `apps/bridge-api/src/session-store.ts:29`
- `normalizeMessageMetadataForKind` is a direct alias:
  - `apps/bridge-api/src/app.ts:348`
- `toCallbackStatusForRetry` always returns a constant:
  - `apps/supervisor-worker/src/trigger-queue.ts:519`
- Why this is a problem:
  - Increases indirection without adding domain behavior.
- KISS fix:
  - Inline/remove these wrappers unless they are meant as stable extension points (and document that intent if so).

### 7) Low: Timeout/exception outcome shaping is partially duplicated in trigger processing
- Generic helpers exist:
  - `apps/supervisor-worker/src/trigger-queue.ts:383`
  - `apps/supervisor-worker/src/trigger-queue.ts:445`
- Callback-specific duplicates still exist:
  - `apps/supervisor-worker/src/trigger-queue.ts:428`
  - `apps/supervisor-worker/src/trigger-queue.ts:472`
- Fallback timeout/exception is inlined again:
  - `apps/supervisor-worker/src/trigger-queue.ts:804`
  - `apps/supervisor-worker/src/trigger-queue.ts:816`
- Why this is a problem:
  - Error semantics for phases are encoded in multiple places.
- DRY fix:
  - Centralize all phase-outcome builders into one helper map/factory.

## Overall
- The biggest leverage is centralizing:
  1. Trigger job contracts
  2. Trigger job persistence primitives
  3. Session heartbeat persistence primitive
- These three changes remove most high-risk duplication without broad architectural churn.
