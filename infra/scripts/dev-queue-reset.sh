#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

set -a
[[ -f "$ROOT_DIR/.env" ]] && source "$ROOT_DIR/.env"
[[ -f "$ROOT_DIR/.env.dev-auth" ]] && source "$ROOT_DIR/.env.dev-auth"
set +a

cd "$ROOT_DIR"
exec tsx infra/scripts/dev-queue-reset.ts "$@"
