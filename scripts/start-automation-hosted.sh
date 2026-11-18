#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -eq 0 ]]; then
  data_dir="${AUTOMATION_DATA_DIR:-/var/data}"
  mkdir -p "$data_dir"
  chown pwuser:pwuser "$data_dir"
  exec gosu pwuser env HOME=/home/pwuser bash "$0" "$@"
fi

export DISPLAY="${DISPLAY:-:99}"
Xvfb "$DISPLAY" -screen 0 1280x900x24 -nolisten tcp -noreset &
display_pid=$!
app_pid=''
shutdown() {
  if [[ -n "$app_pid" ]]; then kill "$app_pid" 2>/dev/null || true; fi
  kill "$display_pid" 2>/dev/null || true
  if [[ -n "$app_pid" ]]; then wait "$app_pid" 2>/dev/null || true; fi
}
trap shutdown EXIT TERM INT
for attempt in $(seq 1 50); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  echo "Virtual browser display failed to start" >&2
  exit 1
fi
node scripts/automation-hosted.cjs &
app_pid=$!
wait "$app_pid"
