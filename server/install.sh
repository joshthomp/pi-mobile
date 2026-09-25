#!/bin/bash
# Install the Pi companion server as a login LaunchAgent (auto-restart, survives reboots).
# Usage: ./install.sh        Uninstall: ./install.sh --uninstall
set -euo pipefail

LABEL="co.bungy.pi-companion"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$HOME/.pi-companion"
# LaunchAgents don't inherit your shell PATH — include where bun/pi usually live.
AGENT_PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Refuse to run from inside the companion service itself (e.g. a Pi agent turn
# spawned by the server): bootout would kill this script's own process tree
# mid-install, leaving the service unloaded and the turn dead.
SVC_PID="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk '/pid =/{print $3; exit}' || true)"
p=$$
while [[ -n "${SVC_PID:-}" && "$p" -gt 1 ]]; do
  if [[ "$p" == "$SVC_PID" ]]; then
    echo "error: install.sh is running inside the pi-companion service it would restart." >&2
    echo "Run it from a regular terminal on the Mac instead." >&2
    exit 1
  fi
  p="$(ps -o ppid= -p "$p" | tr -d ' ')"
done

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  PATH="$AGENT_PATH:$PATH" pi remove "$LOG_DIR/pi-mobile-bridge" >/dev/null 2>&1 || true
  echo "Uninstalled."
  exit 0
fi

command -v bun >/dev/null || { echo "Bun not found — installing…"; curl -fsSL https://bun.sh/install | bash; }
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

# Always install into ~/.pi-companion so LaunchAgent has a stable path, and so
# checkout updates (server.ts + approval extension) are picked up on reinstall.
REPO_RAW="https://raw.githubusercontent.com/MRL-00/pi-mobile/main/server"
if [[ -f "$DIR/server.ts" ]]; then
  cp "$DIR/server.ts" "$LOG_DIR/server.ts"
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
  echo "Downloading pi-mobile-approval…"
  mkdir -p "$LOG_DIR/pi-mobile-approval"
  curl -fsSL "$REPO_RAW/pi-mobile-approval/extension.ts" -o "$LOG_DIR/pi-mobile-approval/extension.ts"
  curl -fsSL "$REPO_RAW/pi-mobile-approval/package.json" -o "$LOG_DIR/pi-mobile-approval/package.json"
  echo "Downloading pi-mobile-bridge…"
  mkdir -p "$LOG_DIR/pi-mobile-bridge"
  curl -fsSL "$REPO_RAW/pi-mobile-bridge/extension.ts" -o "$LOG_DIR/pi-mobile-bridge/extension.ts"
  curl -fsSL "$REPO_RAW/pi-mobile-bridge/package.json" -o "$LOG_DIR/pi-mobile-bridge/package.json"
fi
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
    echo "warning: 'pi install $DIR/pi-mobile-bridge' failed — the phone cannot drive terminal pi sessions." >&2
  fi
fi

# caffeinate -s keeps the Mac awake (on AC power) so agents can run while you're away
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

# Legacy Conductor Mobile companion used the same port (8940). If it's still
# installed, it wins the bind and pi-companion fails with EADDRINUSE — no QR.
LEGACY_LABEL="co.bungy.conductor-companion"
LEGACY_PLIST="$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"
if [[ -f "$LEGACY_PLIST" ]]; then
  echo "Stopping legacy Conductor companion (conflicts on port 8940)…"
  launchctl bootout "gui/$(id -u)" "$LEGACY_PLIST" 2>/dev/null || true
  mv "$LEGACY_PLIST" "${LEGACY_PLIST}.disabled"
fi

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true

# Free port 8940 if an orphaned bun/server is still listening after bootout.
PORT=8940
for _ in $(seq 1 20); do
  PIDS="$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)"
  [[ -z "$PIDS" ]] && break
  # shellcheck disable=SC2086
  kill $PIDS 2>/dev/null || true
  sleep 0.25
done
if lsof -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "error: port $PORT is still in use after stopping old companions." >&2
  lsof -nP -iTCP:$PORT -sTCP:LISTEN >&2 || true
  exit 1
fi

: > "$LOG_DIR/server.log"
: > "$LOG_DIR/server.err.log"
launchctl bootstrap "gui/$(id -u)" "$PLIST"

# Wait for the server to print its pairing banner (QR + token).
for _ in $(seq 1 20); do
  if grep -q "Auth token:" "$LOG_DIR/server.log" 2>/dev/null; then break; fi
  if grep -q "listening on" "$LOG_DIR/server.log" 2>/dev/null; then break; fi
  sleep 0.5
done

echo "Installed and running. Logs: $LOG_DIR/server.log"
if [[ -s "$LOG_DIR/server.log" ]]; then
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
