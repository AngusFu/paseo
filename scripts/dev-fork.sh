#!/bin/bash
# Run the full Paseo stack (daemon + Expo web) from this checkout in one command.
#
# Data lives under .dev/paseo-home (see scripts/dev-home.sh) — fully isolated from
# both the packaged desktop app's ~/.paseo (port 6767) and this repo's own
# `npm run dev` daemon (port 6768, see docs/development.md). This script defaults
# to port 6868 so it can run alongside either of those without colliding.
#
# Usage:
#   ./scripts/dev-fork.sh
#   PASEO_LISTEN=127.0.0.1:7000 EXPO_PORT=8090 ./scripts/dev-fork.sh
#
# Equivalent to running these two commands in separate terminals:
#   PASEO_LISTEN=127.0.0.1:6868 ./scripts/dev-daemon.sh
#   PASEO_LISTEN=127.0.0.1:6868 EXPO_PORT=8081 ./scripts/dev-app.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

node_major="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
if [ "$node_major" != "22" ]; then
  echo "Paseo requires Node 22 (found: $(node -v 2>/dev/null || echo 'no node on PATH'))." >&2
  echo "Install/select it with mise:" >&2
  echo "  mise use -g nodejs@22" >&2
  echo "  export PATH=\"\$(mise where nodejs@22)/bin:\$PATH\"" >&2
  exit 1
fi

export PASEO_LISTEN="${PASEO_LISTEN:-127.0.0.1:6868}"
export EXPO_PORT="${EXPO_PORT:-8081}"

echo "══════════════════════════════════════════════════════"
echo "  Paseo — run from source"
echo "══════════════════════════════════════════════════════"
echo "  Daemon:  ${PASEO_LISTEN}"
echo "  Metro:   http://localhost:${EXPO_PORT}"
echo "══════════════════════════════════════════════════════"

exec npx concurrently --kill-others --names daemon,app --prefix-colors cyan,blue \
  "$SCRIPT_DIR/dev-daemon.sh" \
  "$SCRIPT_DIR/dev-app.sh"
