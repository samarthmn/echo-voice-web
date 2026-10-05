#!/bin/sh
# Compatibility entry point; both native platforms use the same launcher.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec sh "$ROOT/scripts/start-runner.sh" "$@"
