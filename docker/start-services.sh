#!/usr/bin/env bash
set -euo pipefail

backend_pid=""
worker_pid=""

cleanup() {
  local exit_code=$?

  if [[ -n "${backend_pid}" ]] && kill -0 "${backend_pid}" 2>/dev/null; then
    kill "${backend_pid}" 2>/dev/null || true
  fi

  if [[ -n "${worker_pid}" ]] && kill -0 "${worker_pid}" 2>/dev/null; then
    kill "${worker_pid}" 2>/dev/null || true
  fi

  wait || true
  exit "${exit_code}"
}

trap cleanup SIGINT SIGTERM EXIT

cd /app/backend
node dist/index.js &
backend_pid=$!

cd /app/worker
python worker.py &
worker_pid=$!

wait -n "${backend_pid}" "${worker_pid}"

