# Local Deployment and Usage (MVP)

## Purpose

Run Orkiva locally for pilot usage (API + supervisor worker + operator CLI) with the same guardrails used in the repository verification flow.

## 1) Prerequisites

- Node `22.x`
- `pnpm`
- Docker (for local Postgres)
- `tmux` (required for managed runtime trigger path in worker flows)
- WSL recommended for this repository path (`/mnt/c/...`)

## 2) Initial Setup

From repository root:

```bash
tool/agent/doctor
tool/agent/pnpmw --no-stdin install
cp .env.example .env
```

## 3) Configure Environment

Edit `.env` as needed.
Required baseline values:

- `WORKSPACE_ID`
- `DATABASE_URL`
- `AUTH_JWKS_URL`
- `AUTH_ISSUER`
- `AUTH_AUDIENCE`

Auth note:
- Bridge API enforces signed platform tokens.
- Required claims: `agent_id`, `workspace_id`, `role`, `session_id`, `iat`, `exp`, `jti`.

## 4) Bootstrap Database

```bash
tool/agent/pnpmw --no-stdin run db:bootstrap
```

This starts Postgres, waits for readiness, applies migrations, and runs smoke checks.

## 5) Start Services

Use separate terminals from repo root.

Terminal A (bridge API):

```bash
set -a; source .env; set +a
tool/agent/pnpmw --no-stdin run dev:bridge-api
```

Terminal B (supervisor worker):

```bash
set -a; source .env; set +a
tool/agent/pnpmw --no-stdin run dev:supervisor-worker
```

Optional Terminal C (operator CLI usage):

```bash
set -a; source .env; set +a
tool/agent/pnpmw --no-stdin run dev:operator-cli -- inspect-thread --thread-id <thread_id> --json
```

## 6) Service Health Checks

```bash
curl -sS http://localhost:3000/health
curl -sS http://localhost:3000/ready
curl -sS http://localhost:3000/metrics
```

Expected:
- `/health` => `200`
- `/ready` => `200` when DB is reachable
- `/metrics` => Prometheus-formatted metrics

## 7) Basic MCP Usage

Set a valid JWT first:

```bash
export TOKEN="<platform-issued-jwt>"
```

Create thread:

```bash
curl -sS -X POST "http://localhost:3000/v1/mcp/create_thread" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "workspace_id": "wk_local",
    "title": "Local pilot thread",
    "type": "workflow",
    "participants": ["executioner_agent","reviewer_agent"]
  }'
```

Post message:

```bash
curl -sS -X POST "http://localhost:3000/v1/mcp/post_message" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "thread_id": "<thread_id>",
    "schema_version": 1,
    "kind": "chat",
    "body": "hello from local",
    "sender_agent_id": "executioner_agent",
    "sender_session_id": "sess_executioner_agent"
  }'
```

Read messages:

```bash
curl -sS -X POST "http://localhost:3000/v1/mcp/read_messages" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "thread_id": "<thread_id>",
    "since_seq": 0,
    "limit": 50
  }'
```

## 8) Operator CLI Commands

```bash
tool/agent/pnpmw --no-stdin run dev:operator-cli -- inspect-thread --thread-id <thread_id> --json
tool/agent/pnpmw --no-stdin run dev:operator-cli -- escalate-thread --thread-id <thread_id> --reason "manual-escalation"
tool/agent/pnpmw --no-stdin run dev:operator-cli -- unblock-thread --thread-id <thread_id> --reason "issue-resolved"
tool/agent/pnpmw --no-stdin run dev:operator-cli -- override-close-thread --thread-id <thread_id> --reason "human_override:approved"
```

## 9) Verification and Operations Baseline

Before local rollout validation:

```bash
tool/agent/pnpmw --no-stdin run verify
tool/agent/pnpmw --no-stdin run ops:sli:pilot
```

Reference artifacts:

- `docs/proposal/06-operations/slo_sli_baseline.md`
- `docs/runbooks/mvp_incident_runbooks.md`
- `docs/proposal/06-operations/launch_readiness_and_handoff.md`

## 10) Shutdown

Stop dev terminals (`Ctrl+C`), then:

```bash
tool/agent/pnpmw --no-stdin run db:down
```
