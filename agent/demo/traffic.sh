#!/usr/bin/env bash
# Background load for the httptop demo (also the `termgif --bg` payload).
#
# Starts the fake server, waits for it to accept connections, then sends a
# steady, weighted mix of plaintext HTTP requests over loopback until stopped.
# Ctrl-C (or SIGTERM, which `termgif --bg` sends to the group when a recording
# ends) tears the server down and exits.
#
# The requests go to 127.0.0.1 (so httptop captures them on `lo`), but each
# carries a `Host:` header — httptop keys on that, so the dashboard shows
# realistic hostnames (shop.internal, auth.internal, …) instead of the loopback
# address.
#
#   bash demo/traffic.sh              # until Ctrl-C
#   PORT=9001 bash demo/traffic.sh    # different port
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8731}"
BASE="http://127.0.0.1:${PORT}"
SERVER=""
sent=0

# The handler MUST exit. A trap that only cleans up returns into the `while`
# loop below, which then hammers a server it just killed — and because each
# Ctrl-C simply re-runs the handler, the script becomes impossible to interrupt
# without SIGKILL. Untrap first so cleanup can't re-enter itself via EXIT.
cleanup() {
  trap - EXIT INT TERM
  if [ -n "$SERVER" ]; then
    kill "$SERVER" 2>/dev/null || true
    wait "$SERVER" 2>/dev/null || true
  fi
  echo "traffic: stopped after ${sent} requests."
  exit 0
}
trap cleanup EXIT INT TERM

# Refuse to run against someone else's server: it would silently generate
# traffic for whatever is listening (an orphaned demo server, a real service),
# and the dashboard would show its responses, not ours.
if curl -s -o /dev/null --max-time 1 "$BASE/healthz"; then
  echo "traffic: something is already listening on ${PORT}." >&2
  echo "traffic: stop it, or pick another port: PORT=8732 bash demo/traffic.sh" >&2
  trap - EXIT INT TERM
  exit 1
fi

python3 "$HERE/server.py" "$PORT" &
SERVER=$!

# Wait (up to ~5s) for the server to accept connections, and give up loudly
# rather than looping against a server that never came up.
ready=""
for _ in $(seq 1 50); do
  if curl -s -o /dev/null --max-time 1 "$BASE/healthz"; then ready=1; break; fi
  kill -0 "$SERVER" 2>/dev/null || break   # it died (port in use, python error)
  sleep 0.1
done
if [ -z "$ready" ]; then
  echo "traffic: ${HERE}/server.py never came up on ${PORT}." >&2
  exit 1
fi

echo "traffic: serving on ${BASE} — sending a weighted request mix. Ctrl-C to stop."

# method path host  — one request over a fresh connection. --max-time so a
# wedged server can't park this loop forever.
req() { curl -s -o /dev/null --max-time 5 -X "$1" -H "Host: $3" "$BASE$2"; sent=$((sent + 1)); }

# Weighted mix: healthz is chatty, recommendations is rare and slow. Methods
# and hosts vary so every dashboard column has something to show.
while true; do
  req GET    /healthz                            shop.internal
  req GET    /api/products                       shop.internal
  req GET    "/api/products/$((RANDOM % 900 + 100))" shop.internal
  req GET    /healthz                            shop.internal
  req POST   /api/cart                           shop.internal
  req GET    /api/orders                         shop.internal
  req GET    /healthz                            shop.internal
  req POST   /auth/login                         auth.internal
  req DELETE "/api/cart/$((RANDOM % 900 + 100))" shop.internal
  req GET    /static/app.js                      cdn.internal
  req GET    /api/recommendations                reco.internal
  # A heartbeat every ~44 requests (a couple of seconds), so a working generator
  # doesn't look hung — plus a liveness check, so if the server dies we stop
  # instead of spinning against a closed port (every curl would just fail,
  # silently and forever).
  if [ $((sent % 44)) -lt 11 ]; then
    if ! kill -0 "$SERVER" 2>/dev/null; then
      echo "traffic: ${HERE}/server.py exited — stopping." >&2
      exit 1
    fi
    echo "traffic: ${sent} requests sent"
  fi
  sleep 0.15
done
