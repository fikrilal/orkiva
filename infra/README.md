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
