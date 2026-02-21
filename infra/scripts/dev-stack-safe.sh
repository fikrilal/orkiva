#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEV_AUTH_ENV="$ROOT_DIR/.env.dev-auth"

if [[ ! -f "$DEV_AUTH_ENV" ]]; then
  echo "dev-stack-safe: missing $DEV_AUTH_ENV" >&2
  echo "Run: pnpm run dev:auth:bootstrap" >&2
  exit 1
fi

WORKER_MIN_JOB_CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "dev-stack-safe: starting bridge-api + supervisor-worker"
echo "dev-stack-safe: AUTO_UNREAD_ENABLED=false"
echo "dev-stack-safe: WORKER_MIN_JOB_CREATED_AT=$WORKER_MIN_JOB_CREATED_AT"

bridge_pid=""
worker_pid=""

cleanup() {
  local exit_code=$?
  if [[ -n "$bridge_pid" ]] && kill -0 "$bridge_pid" 2>/dev/null; then
    kill "$bridge_pid" 2>/dev/null || true
  fi
  if [[ -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

(
  cd "$ROOT_DIR"
  pnpm --filter @orkiva/bridge-api dev
) &
bridge_pid="$!"

(
  cd "$ROOT_DIR"
  AUTO_UNREAD_ENABLED=false \
  WORKER_MIN_JOB_CREATED_AT="$WORKER_MIN_JOB_CREATED_AT" \
    pnpm --filter @orkiva/supervisor-worker dev
) &
worker_pid="$!"

wait -n "$bridge_pid" "$worker_pid"
