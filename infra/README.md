# Infra

Infrastructure assets for local and deployment environments.

MVP bootstrap note:

- This folder is intentionally minimal in Phase 2.
- Postgres compose and migration bootstrap will be added in Phase 5 (Establish).

Current local database baseline:

- `docker-compose.yml` provides PostgreSQL 16 on `localhost:54322`.
- Use root scripts:
  - `pnpm run db:up`
  - `pnpm run db:ready`
  - `pnpm run db:migrate`
  - `pnpm run db:smoke`
  - `pnpm run db:bootstrap`

Local auth bootstrap:

- `pnpm run dev:auth:bootstrap` generates `.env.dev-auth` with inline JWKS and local dev tokens.
- App dev/start scripts auto-source `.env.dev-auth` when available.
- Regenerate/rotate with `DEV_AUTH_ROTATE=1 pnpm run dev:auth:bootstrap`.

Local queue guardrails:

- `pnpm run dev:supervisor-worker:fresh` starts worker with `WORKER_MIN_JOB_CREATED_AT` set to startup time.
- `pnpm run dev:queue:reset -- --workspace-id <id>` inspects resettable pending jobs (`--apply` to persist).
- `pnpm run dev:stack:safe` starts bridge-api plus worker with safe defaults (`AUTO_UNREAD_ENABLED=false`, startup cutoff set).
