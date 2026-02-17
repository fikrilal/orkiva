# Orkiva

MCP that connects AI agent sessions so they can coordinate work on their own.

## Status

This repository is currently in **proposal-first** stage.

- Product, architecture, protocol, runtime, security, and rollout specs are defined.
- Implementation scaffolding (`apps/*`, `packages/*`, infra) is not created yet.
- Current code is documentation plus Windows/WSL helper wrappers under `tool/agent/`.

## Why Orkiva Exists

Multi-agent development workflows are bottlenecked by human copy-paste between isolated agent sessions.

Orkiva removes that bottleneck by providing:

- direct agent-to-agent thread messaging
- structured workflow metadata for automation
- deterministic wake/fallback behavior for dormant agents
- auditable lifecycle and policy controls

## MVP Scope (Locked)

- Single-workspace trust domain (no cross-workspace routing in MVP)
- MCP `/v1` API surface for thread/message/session/wake flows
- Postgres-backed durable storage and ordering
- Hybrid orchestration:
  - trigger-first to managed runtimes
  - polling fallback
  - resume/spawn recovery chain
- Loop guardrails, escalation, and audit logging
- CLI/JSON-first operation (no dashboard required in MVP)

## Core Architecture

Planned runtime topology:

1. `bridge-api`
- MCP and HTTP entrypoints
- thread/message/session orchestration
- policy and governance enforcement
- trigger job scheduling

2. `supervisor-worker`
- trigger execution engine
- managed runtime control (`tmux` first)
- human-input collision handling
- fallback chain (`resume` then spawn)

3. `operator-cli` (MVP optional, planned)
- operator diagnostics, inspection, and overrides

4. Shared packages
- `domain`, `protocol`, `db`, `auth`, `observability`, `shared`

Reference:
- `docs/proposal/02-architecture/solution_architecture.md`
- `docs/proposal/02-architecture/technical_stack_and_architecture.md`
- `docs/proposal/02-architecture/system_tree_folder_structure.md`

## MVP MCP Commands

Thread:

- `create_thread`
- `get_thread`
- `update_thread_status`
- `summarize_thread`

Message:

- `post_message`
- `read_messages`
- `ack_read`

Session/Wake:

- `heartbeat_session`
- `trigger_participant`

Reference:
- `docs/proposal/04-protocol/mcp_command_catalog.md`
- `docs/proposal/04-protocol/protocol_spec.md`

## Security and Governance Baseline

- All calls require platform-issued signed short-lived tokens.
- Verified claims (`agent_id`, `workspace_id`, `role`, `session_id`, `iat`, `exp`, `jti`) are the only identity source of truth.
- Cross-workspace calls are rejected in MVP.
- Worker agents cannot force-close disputed threads.
- Human operator has final override authority.

Reference:
- `docs/proposal/05-security/security_and_governance.md`
- `docs/proposal/07-decisions/open_questions.md`

## Runtime Trigger Baseline

Default wake sequence:

1. Trigger active managed runtime (PTY/tmux path)
2. Fallback `codex exec resume <session_id> <prompt>` (max 2 attempts)
3. Spawn fresh session with thread summary

Collision policy defaults:

- quiet window: `20s`
- defer re-check interval: `5s`
- max defer window: `60s`

Loop guard defaults:

- block at `20` no-progress turns
- block at `3` repeated-identical finding cycles

Reference:
- `docs/proposal/03-runtime/process_level_trigger_design.md`
- `docs/proposal/03-runtime/tmux_supervisor_implementation_spec.md`

## Repository Layout (Current)

```text
.
├─ AGENTS.md                 # strict contributor/AI rules
├─ docs/proposal/            # full proposal specs
└─ tool/agent/               # Windows/WSL wrappers for dev commands
```

## Read the Proposal (Start Here)

1. `docs/proposal/01-product/problem_statement.md`
2. `docs/proposal/01-product/use_cases.md`
3. `docs/proposal/01-product/prd.md`
4. `docs/proposal/02-architecture/solution_architecture.md`
5. `docs/proposal/04-protocol/protocol_spec.md`

Or read the complete map:
- `docs/proposal/proposal_overview.md`

## Development Environment (Current)

This repo is commonly used from WSL on a Windows-mounted workspace (`/mnt/c/...`).
Use wrappers to avoid Linux/Windows artifact drift:

- `tool/agent/doctor`
- `tool/agent/gitw --no-stdin ...`
- `tool/agent/nodew --no-stdin ...`
- `tool/agent/pnpmw --no-stdin ...`
- `tool/agent/dockw --no-stdin ...`
- `tool/agent/winrun --no-stdin -- <command> ...`

## Planned Build Sequence

From `docs/proposal/06-operations/implementation_backlog.md`:

1. Scaffold workspace structure (`apps/`, `packages/`, `infra/`)
2. Build core thread/message/session domain
3. Expose MCP command surface (`/v1`)
4. Add policy/security enforcement
5. Add reliability/observability hardening
6. Validate pilot executioner-reviewer workflow
7. Implement and validate PTY supervisor trigger infrastructure

## Contribution Rules

- Follow `AGENTS.md` strictly.
- Keep changes small, explicit, and reversible.
- Do not silently change lock-ins from proposal docs.
- If behavior/protocol/governance changes, update docs in the same change.

## License

TBD
