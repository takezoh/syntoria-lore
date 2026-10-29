#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
COMMAND=${1:-help}

compose() {
  docker compose --env-file infra/local/deployment.env --env-file .env.local -f compose.yaml "$@"
}

run_eval() {
  LOCAL_SCOPE_ID=$(node --input-type=module -e 'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID())')
  LOCAL_CAPTURE_SCOPE_IDS=
  for _ in 1 2 3 4 5 6; do
    NEXT_CAPTURE_SCOPE_ID=$(node --input-type=module -e 'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID())')
    LOCAL_CAPTURE_SCOPE_IDS="${LOCAL_CAPTURE_SCOPE_IDS}${LOCAL_CAPTURE_SCOPE_IDS:+ }${NEXT_CAPTURE_SCOPE_ID}"
  done
  export LOCAL_SCOPE_ID
  export LOCAL_CAPTURE_SCOPE_IDS
  LOCAL_EVAL_SCOPE_IDS="$LOCAL_SCOPE_ID $LOCAL_CAPTURE_SCOPE_IDS" compose --profile tools run --rm eval-scope-seed
  node scripts/eval-local.mjs
}

case "$COMMAND" in
  start|up)
    node scripts/local-env.mjs
    compose up -d --build
    node scripts/wait-local-ready.mjs
    ;;
  stop)
    node scripts/local-env.mjs
    compose stop
    ;;
  reset)
    printf '%s\n' 'This removes only the configured Compose project and its two target volumes.'
    node scripts/local-env.mjs
    compose down --volumes --remove-orphans
    rm -f .env.local
    ;;
  status)
    node scripts/local-env.mjs
    compose ps
    ;;
  logs)
    node scripts/local-env.mjs
    compose logs --tail=100 "${2:-api}"
    ;;
  diagnostics)
    node scripts/local-env.mjs
    compose --profile tools run --rm diagnostics
    ;;
  restore-reconcile)
    node scripts/local-env.mjs
    compose --profile tools run --rm restore-reconcile
    ;;
  scheduler)
    node scripts/local-control.mjs scheduler
    ;;
  duplicate-scheduler)
    node scripts/local-control.mjs scheduler-duplicate
    ;;
  fail-next-task)
    node scripts/local-control.mjs task-fail
    ;;
  fail-next-provider)
    node scripts/local-control.mjs "provider-fail-${2:-curator}"
    ;;
  smoke)
    node scripts/local-smoke.mjs
    ;;
  recovery-smoke)
    node scripts/local-recovery-smoke.mjs
    ;;
  eval)
    run_eval
    ;;
  load)
    node scripts/load-local.mjs "${2:-10}" "${3:-4}"
    ;;
  acceptance)
    node scripts/local-env.mjs
    compose --profile tools run --rm quality
    node scripts/local-smoke.mjs
    node scripts/local-recovery-smoke.mjs
    run_eval
    node scripts/load-local.mjs "${LOAD_COUNT:-10}" "${LOAD_CONCURRENCY:-4}"
    node scripts/local-persistence-smoke.mjs prepare
    compose stop
    compose up -d
    node scripts/wait-local-ready.mjs
    node scripts/local-persistence-smoke.mjs verify
    ;;
  help|*)
    cat <<'EOF'
Usage: sh scripts/local.sh COMMAND [ARGS]

  start                 build and start the loopback-only local stack
  stop                  stop containers while preserving all local volumes
  reset                 remove this stack, its two named volumes, and .env.local
  status | logs [NAME]  inspect services
  diagnostics           show counts for failed jobs, outbox lag, purge, index, and ledger
  restore-reconcile     replay the separate deletion ledger through the non-bypass worker role
  scheduler | duplicate-scheduler | fail-next-task | fail-next-provider [curator|embedding]
  smoke | recovery-smoke | eval | load [COUNT] [CONCURRENCY] | acceptance
  smoke needs LOCAL_API_BEARER_TOKEN and a read+write LOCAL_MCP_BEARER_TOKEN
  eval also needs LOCAL_API_READONLY_BEARER_TOKEN for its authorization probes
  acceptance also restarts the Compose stack and verifies previously stored data
EOF
    ;;
esac
