#!/bin/bash
# Run the integration tests in isolated Docker stacks: the suite split into
# TEST_SHARDS shards (default 4), each run at once in its own stack.
#
#   docker/test/run.sh                # build, run, tear down
#   TEST_SHARDS=1 docker/test/run.sh  # the whole suite in one stack
#   docker/test/run.sh <compose args> # passthrough to every shard's stack, e.g. `logs -f runner`
#
# Needs nothing but Docker: the runner builds from source, and core generates
# its keys into each shard's throwaway database. A shard's files share one
# server and database and run one at a time; shards share nothing.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARDS="${TEST_SHARDS:-4}"

compose() {
  local shard=$1
  shift
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" -p "tereo-test-$shard" "$@"
}

# `compose <shard> "$@"` for every shard at once, each line prefixed with its
# shard. Fails if any of them did.
each_shard() {
  local pids=() status=0 shard
  for shard in $(seq 1 "$SHARDS"); do
    (
      set -o pipefail
      TEST_SHARD="$shard/$SHARDS" compose "$shard" "$@" 2>&1 |
        awk -v p="[$shard/$SHARDS] " '{ print p $0; fflush() }'
    ) &
    pids+=($!)
  done
  for pid in "${pids[@]}"; do
    wait "$pid" || status=$?
  done
  return $status
}

if [ $# -gt 0 ]; then
  each_shard "$@"
  exit
fi

each_shard down -v >/dev/null 2>&1 || true
trap 'each_shard down -v >/dev/null 2>&1 || true' EXIT

# One image, tagged in the compose file, that every shard's stack runs.
compose 1 build runner

each_shard up --no-build --abort-on-container-exit --exit-code-from runner runner
