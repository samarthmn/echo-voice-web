#!/bin/sh
# Start the native meeting runner from its private Python environment.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
case "$(uname -s)" in
  Darwin|Linux) ;;
  *) echo 'The native meeting runner supports macOS and Linux.' >&2; exit 1 ;;
esac
if [ ! -x runner/.venv/bin/python ]; then
  echo 'First run: python3 -m venv runner/.venv && runner/.venv/bin/pip install -r runner/requirements.txt' >&2
  exit 1
fi
mkdir -p "$ROOT/tmp/native-runner"
export TMPDIR="$ROOT/tmp/native-runner"
export PYTHONDONTWRITEBYTECODE=1
exec runner/.venv/bin/python runner/meet_runner.py "$@"
