# System Tree and Folder Structure (Proposed MVP)

## 1. Recommended Root
Create implementation under a dedicated root:
- `orkiva/`

This keeps bridge runtime code isolated from Flutter app code while staying in the same repository.

## 2. Tree
```text
orkiva/
├─ apps/
│  ├─ bridge-api/
│  │  ├─ src/
│  │  │  ├─ main.ts
│  │  │  ├─ config/
│  │  │  ├─ mcp/
│  │  │  ├─ http/
│  │  │  ├─ modules/
│  │  │  │  ├─ threads/
│  │  │  │  ├─ messages/
│  │  │  │  ├─ sessions/
│  │  │  │  ├─ trigger_orchestration/
│  │  │  │  └─ governance/
│  │  │  ├─ policies/
│  │  │  └─ services/
│  │  └─ test/
│  ├─ supervisor-worker/
│  │  ├─ src/
│  │  │  ├─ main.ts
│  │  │  ├─ queue/
│  │  │  ├─ adapters/
│  │  │  │  └─ tmux/
│  │  │  ├─ collision/
│  │  │  ├─ fallback/
│  │  │  ├─ runtime_registry/
│  │  │  └─ audit/
│  │  └─ test/
│  └─ operator-cli/
│     ├─ src/
│     │  ├─ main.ts
│     │  └─ commands/
│     └─ test/
├─ packages/
│  ├─ domain/
│  │  ├─ thread/
│  │  ├─ message/
│  │  ├─ session/
│  │  ├─ trigger/
│  │  └─ policy/
│  ├─ protocol/
│  │  ├─ mcp_schemas/
│  │  ├─ event_schemas/
│  │  └─ errors/
│  ├─ db/
│  │  ├─ schema/
│  │  ├─ migrations/
│  │  └─ seeds/
│  ├─ auth/
│  ├─ observability/
│  └─ shared/
├─ infra/
│  ├─ docker-compose.yml
│  ├─ postgres/
│  ├─ systemd/
│  └─ scripts/
├─ docs/
│  ├─ 01-product/
│  ├─ 02-architecture/
│  ├─ 03-runtime/
│  ├─ 04-protocol/
│  ├─ 05-security/
│  ├─ 06-operations/
│  ├─ 07-decisions/
│  ├─ runbooks/
│  ├─ adr/
│  └─ api/
├─ .env.example
├─ package.json
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
└─ README.md
```

## 3. Responsibility Split
- `apps/bridge-api`: external MCP/API surface, policy checks, orchestration decisions.
- `apps/supervisor-worker`: async trigger execution and tmux/runtime control.
- `apps/operator-cli`: optional direct operator commands and diagnostics.
- `packages/domain`: pure business logic with no infra dependencies.
- `packages/protocol`: request/response schemas, event schema contracts, shared error codes.
- `packages/db`: schema definitions and migrations.
- `packages/auth`: token verification and claim mapping.
- `packages/observability`: logger/metric setup shared by all apps.
- `infra`: local runtime and deployment scripts.
- `docs/01-product`: problem framing, use cases, PRD.
- `docs/02-architecture`: system design, control model, stack, and repo structure.
- `docs/03-runtime`: PTY trigger and supervisor runtime behavior.
- `docs/04-protocol`: MCP/API command and payload contracts.
- `docs/05-security`: auth, authorization, risk controls.
- `docs/06-operations`: rollout plan, runbooks, and backlog execution.
- `docs/07-decisions`: locked decisions and decision history.

## 4. Architectural Rules
- `apps/*` may depend on `packages/*`.
- `packages/domain` must not depend on app or infra-specific modules.
- tmux/process calls are only allowed in `apps/supervisor-worker`.
- MCP transport details are only allowed in `apps/bridge-api`.

## 5. MVP Build Order
1. Scaffold `packages/protocol`, `packages/domain`, and `packages/db`.
2. Build `apps/bridge-api` MCP methods for thread/message/session flows.
3. Build `apps/supervisor-worker` trigger pipeline with tmux adapter.
4. Add `apps/operator-cli` for inspection/override commands.
5. Add baseline documentation skeleton under `docs/01-product` to `docs/07-decisions`.
6. Add runbooks and operational scripts under `docs/runbooks` and `infra/scripts`.
