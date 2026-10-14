#!/bin/bash
# Run the integration tests in an isolated Docker stack.
#
#   docker/test/run.sh                # build, run, tear down
#   docker/test/run.sh <compose args> # passthrough, e.g. `logs -f runner`
#
# Needs nothing but Docker: the runner builds from source, and core generates
# its keys into the throwaway database.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -f "$SCRIPT_DIR/docker-compose.yml")

if [ $# -gt 0 ]; then
  exec "${COMPOSE[@]}" "$@"
fi

"${COMPOSE[@]}" down -v 2>/dev/null || true

set +e
"${COMPOSE[@]}" up --build --abort-on-container-exit --exit-code-from runner runner
EXIT_CODE=$?
set -e

"${COMPOSE[@]}" down -v
exit $EXIT_CODE
