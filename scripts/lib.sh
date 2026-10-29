#!/usr/bin/env bash
# Call from the repository root. ECHO_BIND takes precedence over the config.
echo_bind() {
  local bind="${ECHO_BIND:-}"
  if [[ -z "$bind" && -f echo.config.json ]]; then
    bind="$(node -e 'const c = require("./echo.config.json"); if (c.bind) process.stdout.write(c.bind)')" || {
      echo 'Could not read bind from echo.config.json.' >&2
      return 1
    }
  fi
  printf '%s\n' "${bind:-127.0.0.1:3000}"
}
echo_url() {
  local bind port
  bind="$(echo_bind)" || return 1
  port="${bind##*:}"
  [[ "$port" =~ ^[0-9]+$ ]] || { echo "Invalid bind address: $bind" >&2; return 1; }
  printf 'http://localhost:%s\n' "$port"
}
