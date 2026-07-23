#!/usr/bin/env bash
# Start the in-container yeet daemon, wait for its privileged socket (the BPF
# load path the exporter needs), then start the node server — which spawns the
# httpinspect exporter isolate and serves the browser dashboard. When either
# child exits (or we get a signal), tear both down cleanly.
#
# We wait for the PRIVILEGED socket (BPF requires it) and launch our own server.

set -euo pipefail

server_pid=""
yeetd_pid=""

goodbye() {
  if [ -n "${YEET_AUTH_KEY:-}" ]; then
    yeet logout --delete-host 2>/dev/null || true
  fi
  [ -n "$server_pid" ] && kill -TERM "$server_pid" 2>/dev/null || true
  [ -n "$yeetd_pid" ] && kill -TERM "$yeetd_pid" 2>/dev/null || true
}
trap goodbye TERM INT

# 0. Give the container its OWN bpffs (private, torn down with the container) and
#    point yeetd at it with --bpf-fs. We mount it at /opt/fs/bpf, NOT under
#    /sys/fs/bpf: Docker mounts /sys read-only and locks the flag for
#    non-privileged containers, so /sys/fs/bpf can't be a mountpoint without
#    --privileged. A writable path avoids that. The mount() itself also needs
#    Docker's AppArmor confinement lifted (run with --security-opt
#    apparmor=unconfined) — the default profile denies mount even with
#    CAP_SYS_ADMIN. Both are the pieces --privileged would otherwise hand us.
BPF_FS="${BPF_FS:-/opt/fs/bpf}"
if grep -q " ${BPF_FS} bpf " /proc/mounts; then
  echo "[entrypoint] bpffs already mounted at ${BPF_FS}"
else
  echo "[entrypoint] mounting private bpffs at ${BPF_FS}"
  mkdir -p "$BPF_FS"
  mount -t bpf bpf "$BPF_FS" || {
    echo "[entrypoint] failed to mount bpffs at ${BPF_FS}." >&2
    echo "[entrypoint] run with --security-opt apparmor=unconfined — the default AppArmor profile denies the mount." >&2
    exit 1
  }
fi

# 1. yeet daemon (root — it owns the privileged BPF load). Point it at our
#    writable bpffs so it pins there instead of the default /sys/fs/bpf.
echo "[entrypoint] starting yeetd..."
setsid /usr/sbin/yeetd --bpf-fs="$BPF_FS" &
yeetd_pid="$!"

# 2. Wait for the privileged socket (up to ~15s). `yeet run` selects it for the
#    BPF load; without it the exporter can't attach its TC programs.
SOCK="${YEET_SOCKET:-/run/yeet/yeetd.sock}"
echo "[entrypoint] waiting for yeetd socket $SOCK ..."
for _ in $(seq 1 150); do
  [ -S "$SOCK" ] && break
  sleep 0.1
done
if [ ! -S "$SOCK" ]; then
  echo "[entrypoint] yeetd privileged socket never appeared at $SOCK" >&2
  goodbye
  exit 1
fi
echo "[entrypoint] yeetd is up."

# 3. Node server (spawns the exporter isolate + serves the dashboard).
echo "[entrypoint] starting httpwatch on :${PORT:-8080}..."
node /app/server/index.js &
server_pid="$!"

# 4. Exit as soon as either process does, then clean up the other.
wait -n
goodbye
