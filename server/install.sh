#!/bin/bash
# Install and control the Pi companion server (a launchd service that auto-restarts on crash).
#
#   install.sh                 Install on demand: start now, but not at login (default)
#   install.sh --always-on     Install always on: also start at every login
#   install.sh start|stop|status
#   install.sh --uninstall
#
# The installer puts a copy at ~/.pi-companion/install.sh and links it as
# ~/.local/bin/pi-companion, so `pi-companion stop` works without a checkout.
set -euo pipefail

LABEL="co.bungy.pi-companion"
SERVICE="gui/$(id -u)/$LABEL"
LOG_DIR="$HOME/.pi-companion"
ALWAYS_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist" # launchd loads this at login
DEMAND_PLIST="$LOG_DIR/$LABEL.plist"                   # launchd never sees this unless we bootstrap it
LINK="$HOME/.local/bin/pi-companion"
PORT=8940
# Follow the ~/.local/bin/pi-companion symlink to the real script folder.
# Under `curl | bash`, $0 is "bash" and this falls back to it unchanged.
SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
DIR="$(cd "$(dirname "$SELF")" && pwd)"
REPO_RAW="https://raw.githubusercontent.com/MRL-00/pi-mobile/main/server"
# LaunchAgents don't inherit your shell PATH — include where bun/pi usually live.
AGENT_PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

usage() { sed -n '2,10p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || echo "usage: install.sh [--always-on] | start | stop | status | --uninstall"; }

CMD=install
ALWAYS_ON=0
for a in "$@"; do
  case "$a" in
    --always-on) ALWAYS_ON=1 ;;
    --uninstall|uninstall) CMD=uninstall ;;
    install|start|stop|status) CMD="$a" ;;
    -h|--help|help) usage; exit 0 ;;
    *) echo "error: unknown argument: $a" >&2; usage >&2; exit 1 ;;
  esac
done

running() { launchctl print "$SERVICE" >/dev/null 2>&1; }
service_pid() { launchctl print "$SERVICE" 2>/dev/null | awk '/pid =/{print $3; exit}' || true; }
installed_plist() {
  if [[ -f "$ALWAYS_PLIST" ]]; then echo "$ALWAYS_PLIST"
  elif [[ -f "$DEMAND_PLIST" ]]; then echo "$DEMAND_PLIST"; fi
}
mode() {
  if [[ -f "$ALWAYS_PLIST" ]]; then echo "always on (starts at login)"
  elif [[ -f "$DEMAND_PLIST" ]]; then echo "on demand"
  else echo "not installed"; fi
}

# Refuse to change the service from inside it (e.g. a Pi agent turn spawned
# by the server): bootout would kill this script's own process tree midway,
# leaving the service unloaded and the turn dead.
if [[ "$CMD" != status ]]; then
  SVC_PID="$(service_pid)"
  p=$$
  while [[ -n "${SVC_PID:-}" && "$p" -gt 1 ]]; do
    if [[ "$p" == "$SVC_PID" ]]; then
      echo "error: install.sh is running inside the pi-companion service it would stop." >&2
      echo "Run it from a regular terminal on the Mac instead." >&2
      exit 1
    fi
    p="$(ps -o ppid= -p "$p" | tr -d ' ')"
  done
fi

# bootout stops caffeinate; an orphaned bun can still hold the port.
free_port() {
  for _ in $(seq 1 20); do
    PIDS="$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)"
    [[ -z "$PIDS" ]] && return 0
    # shellcheck disable=SC2086
    kill $PIDS 2>/dev/null || true
    sleep 0.25
  done
  echo "error: port $PORT is still in use." >&2
  lsof -nP -iTCP:$PORT -sTCP:LISTEN >&2 || true
  exit 1
}

stop_service() {
  launchctl bootout "$SERVICE" 2>/dev/null || true
  free_port
}

# Start the service from a plist, then print the pairing banner (QR + token).
start_service() {
  free_port
  : > "$LOG_DIR/server.log"
  : > "$LOG_DIR/server.err.log"
  launchctl bootstrap "gui/$(id -u)" "$1"
  for _ in $(seq 1 20); do
    grep -q "Auth token:\|listening on" "$LOG_DIR/server.log" 2>/dev/null && break
    sleep 0.5
  done
  if [[ -s "$LOG_DIR/server.log" ]]; then
    sleep 0.5 # let the QR finish printing
    cat "$LOG_DIR/server.log"
  else
    echo
    echo "Server didn't print a banner yet — check $LOG_DIR/server.err.log"
    if grep -q "EADDRINUSE\|port $PORT" "$LOG_DIR/server.err.log" 2>/dev/null; then
      echo "Hint: something else is bound to port $PORT (often a leftover Conductor companion)."
    fi
    if [[ -f "$LOG_DIR/token" ]]; then
      HOST="$(scutil --get LocalHostName 2>/dev/null || hostname | sed 's/\.local$//')"
      echo
      echo "Pair manually in the iPhone app Settings:"
      echo "  Server address:  http://${HOST}.local:$PORT"
      echo "  Auth token:      $(cat "$LOG_DIR/token")"
    fi
  fi
}

case "$CMD" in
  status)
    if running; then echo "running (pid $(service_pid)) — $(mode)"
    else echo "stopped — $(mode)"; fi
    exit 0 ;;

  stop)
    if ! running; then echo "Already stopped."; exit 0; fi
    echo "Stopping the Pi companion server. Any agent turn it is running stops too."
    stop_service
    echo "Stopped. Start it again with: pi-companion start"
    exit 0 ;;

  start)
    PLIST="$(installed_plist)"
    [[ -z "$PLIST" ]] && { echo "error: not installed. Run the installer first." >&2; exit 1; }
    if running; then echo "Already running (pid $(service_pid))."; exit 0; fi
    start_service "$PLIST"
    exit 0 ;;

  uninstall)
    stop_service
    rm -f "$ALWAYS_PLIST" "$DEMAND_PLIST"
    [[ -L "$LINK" ]] && rm -f "$LINK"
    PATH="$AGENT_PATH:$PATH" pi remove "$LOG_DIR/pi-mobile-bridge" >/dev/null 2>&1 || true
    echo "Uninstalled."
    exit 0 ;;
esac

# ---- install ----
command -v bun >/dev/null || { echo "Bun not found — installing…"; curl -fsSL https://bun.sh/install | bash; }
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents" "$(dirname "$LINK")"

# Always install into ~/.pi-companion so launchd has a stable path, and so
# checkout updates (server.ts, approval extension, this script) are picked up on reinstall.
if [[ "$DIR" == "$LOG_DIR" ]]; then
  : # re-running the installed copy: files are already in place
elif [[ -f "$DIR/server.ts" ]]; then
  cp "$DIR/server.ts" "$LOG_DIR/server.ts"
  cp "$DIR/install.sh" "$LOG_DIR/install.sh"
  if [[ -d "$DIR/pi-mobile-approval" ]]; then
    rm -rf "$LOG_DIR/pi-mobile-approval"
    cp -R "$DIR/pi-mobile-approval" "$LOG_DIR/pi-mobile-approval"
  fi
  if [[ -d "$DIR/pi-mobile-bridge" ]]; then
    rm -rf "$LOG_DIR/pi-mobile-bridge"
    cp -R "$DIR/pi-mobile-bridge" "$LOG_DIR/pi-mobile-bridge"
  fi
else
  echo "Downloading server.ts…"
  curl -fsSL "$REPO_RAW/server.ts" -o "$LOG_DIR/server.ts"
  curl -fsSL "$REPO_RAW/install.sh" -o "$LOG_DIR/install.sh"
  echo "Downloading pi-mobile-approval…"
  mkdir -p "$LOG_DIR/pi-mobile-approval"
  curl -fsSL "$REPO_RAW/pi-mobile-approval/extension.ts" -o "$LOG_DIR/pi-mobile-approval/extension.ts"
  curl -fsSL "$REPO_RAW/pi-mobile-approval/package.json" -o "$LOG_DIR/pi-mobile-approval/package.json"
  echo "Downloading pi-mobile-bridge…"
  mkdir -p "$LOG_DIR/pi-mobile-bridge"
  curl -fsSL "$REPO_RAW/pi-mobile-bridge/extension.ts" -o "$LOG_DIR/pi-mobile-bridge/extension.ts"
  curl -fsSL "$REPO_RAW/pi-mobile-bridge/package.json" -o "$LOG_DIR/pi-mobile-bridge/package.json"
fi
chmod +x "$LOG_DIR/install.sh"
ln -sf "$LOG_DIR/install.sh" "$LINK"
DIR="$LOG_DIR"
# Ask mode fails closed without this package — don't launch a half-installed agent.
if [[ ! -f "$DIR/pi-mobile-approval/extension.ts" || ! -f "$DIR/pi-mobile-approval/package.json" ]]; then
  echo "error: pi-mobile-approval package missing in $DIR (needed for Ask mode)." >&2
  exit 1
fi

# Terminal bridge: lets the phone see, stop and message terminal pi sessions.
# Optional: a failed install only loses that feature.
if [[ -f "$DIR/pi-mobile-bridge/extension.ts" ]]; then
  if PATH="$AGENT_PATH:$PATH" pi install "$DIR/pi-mobile-bridge" >/dev/null 2>&1; then
    echo "Installed the pi-mobile-bridge Pi extension (terminal pi sessions started from now on connect to the phone)."
  else
    echo "warning: 'pi install $DIR/pi-mobile-bridge' failed. The phone cannot drive terminal pi sessions." >&2
  fi
fi

# Legacy Conductor Mobile companion used the same port (8940). If it's still
# installed, it wins the bind and pi-companion fails with EADDRINUSE — no QR.
LEGACY_LABEL="co.bungy.conductor-companion"
LEGACY_PLIST="$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"
if [[ -f "$LEGACY_PLIST" ]]; then
  echo "Stopping legacy Conductor companion (conflicts on port 8940)…"
  launchctl bootout "gui/$(id -u)" "$LEGACY_PLIST" 2>/dev/null || true
  mv "$LEGACY_PLIST" "${LEGACY_PLIST}.disabled"
fi

stop_service
rm -f "$ALWAYS_PLIST" "$DEMAND_PLIST" # one mode at a time
if [[ "$ALWAYS_ON" == 1 ]]; then PLIST="$ALWAYS_PLIST"; else PLIST="$DEMAND_PLIST"; fi

# caffeinate -s keeps the Mac awake (on AC power) while the server runs.
# KeepAlive restarts it after a crash. Only `stop` (bootout) ends it.
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-s</string>
    <string>$BUN</string>
    <string>run</string>
    <string>$DIR/server.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$AGENT_PATH</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/server.err.log</string>
</dict>
</plist>
EOF

start_service "$PLIST"
echo
echo "Installed ($(mode)) and running. Logs: $LOG_DIR/server.log"
echo "Control it with: pi-companion start | stop | status"
if ! command -v pi-companion >/dev/null 2>&1; then
  echo "(~/.local/bin is not on your PATH — use $LOG_DIR/install.sh start | stop | status)"
fi
