#!/bin/bash
# Check: phone API → server → pi-mobile-bridge → interactive terminal pi, and back.
# Temp HOME, server on 18940, fake model on 18951, pi in a pty via expect. No API cost.
# Usage: ./server/test-bridge.sh
set -euo pipefail
cd "$(dirname "$0")"; HERE="$(pwd)"
T="$(cd "$(mktemp -d)" && pwd -P)"; PORT=18940; B="http://127.0.0.1:$PORT"
PIDS=()
# Every test pi has this path on its command line, so pkill finds only test pis.
kill_test_pis() { pkill -f "$HERE/pi-mobile-bridge/extension.ts" 2>/dev/null || true; }
cleanup() { kill ${PIDS[@]+"${PIDS[@]}"} 2>/dev/null || true; kill_test_pis; wait 2>/dev/null || true; rm -rf "$T"; }
trap cleanup EXIT
PROJ="$T/proj"; mkdir -p "$PROJ" "$T/.pi-companion"
echo "[{\"path\":\"$PROJ\",\"added\":1}]" > "$T/.pi-companion/projects.json"

fail() { echo "FAIL: $1"; echo "--- server log"; tail -20 "$T/log" 2>/dev/null; exit 1; }
start_server() {
  HOME="$T" PORT=$PORT PI_PATH=/usr/bin/true BRIDGE_HOLD_MS=3000 BRIDGE_TTL_MS=5000 \
    bun run server.ts >"$T/log" 2>&1 & PIDS+=($!); SRV=$!
  for _ in $(seq 1 40); do grep -q "Auth token:" "$T/log" 2>/dev/null && break; sleep 0.25; done
  AUTH="Authorization: Bearer $(cat "$T/.pi-companion/token")"
}
# start_pi NAME [ENV...] — interactive pi in a pty, cwd = $PROJ, TUI log in $T/NAME.tty
start_pi() {
  local name="$1"; shift
  (cd "$PROJ" && expect -c "
    set timeout 600
    spawn -noecho env HOME=$T PI_MOBILE_PORT=$PORT FAKE_LLM_PORT=18951 TERM=xterm-256color COLUMNS=120 LINES=40 $* \
      pi -ne -e $HERE/test/fake-provider.ts -e $HERE/pi-mobile-bridge/extension.ts --model fake/fake
    log_file -noappend $T/$name.tty
    expect eof
  " >/dev/null 2>&1) & PIDS+=($!); LAST_PI=$!
}
req() {
  local f; f="$(mktemp "$T/body.XXXXXX")" # one file per call: background calls run at the same time
  local a=(-s -o "$f" -w '%{http_code}' -X "$1" -H "$AUTH" -H 'content-type: application/json')
  [[ $# -ge 3 ]] && a+=(-d "$3")
  curl "${a[@]}" "$B$2"; echo " $(cat "$f")"
}
wait_for() { for _ in $(seq 1 "${3:-60}"); do eval "$2" >/dev/null 2>&1 && return 0; sleep 0.5; done; fail "$1"; }
sid() { req GET /bridge/list | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4; }
session_has() { grep -q "$1" "$T"/.pi/agent/sessions/*/*.jsonl; }
tui_clean() { perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g; s/\e\][^\a]*\a//g; s/\r/\n/g' "$T/$1.tty"; }

bun run test/fake-llm.ts >"$T/llm.log" 2>&1 & PIDS+=($!)

# 9. pi starts BEFORE the server: the bridge backs off quietly, then registers (Review Focus 4)
start_pi main; PI_MAIN=$LAST_PI
sleep 4
start_server
wait_for "9 bridge registers after server start" '[[ -n "$(sid)" ]]' 80
# The TUI lists extension paths (they contain "bridge"), so match only error text.
tui_clean main | grep -qiE "ECONNREFUSED|fetch failed|Extension .*error" && fail "9 TUI shows a bridge error"
S="$(sid)"

# 1. registered bridge → status idle
req GET "/sessions/$S/status" | grep -q '"running":false' || fail "1 idle status"

# 2. phone send while idle → terminal runs it
[[ "$(req POST "/sessions/$S/send" '{"text":"PING1","model":"anthropic/x"}')" == '200 {"ok":true}' ]] || fail "2 send 200"
wait_for "2 ECHO: PING1 in session file" 'session_has "ECHO: PING1"'
tui_clean main | grep -q "PING1" || fail "2 terminal shows PING1"

# 3. long turn → status running with a bash activity
wait_for "3 idle before SLEEP" 'req GET "/sessions/$S/status" | grep -q "\"running\":false"'
req POST "/sessions/$S/send" '{"text":"SLEEP 20"}' | grep -q '^200' || fail "3 send SLEEP"
wait_for "3 bash activity" 'req GET "/sessions/$S/status" | grep -q "\"running\":true,\"activity\":\"bash"'

# 4. send while busy → 409
[[ "$(req POST "/sessions/$S/send" '{"text":"x"}' | cut -c1-3)" == 409 ]] || fail "4 busy 409"

# 5. stop while busy → turn ends in ≤3 s
T0=$(date +%s)
req POST "/sessions/$S/stop" | grep -q '^200' || fail "5 stop 200"
wait_for "5 idle after stop" 'req GET "/sessions/$S/status" | grep -q "\"running\":false"' 6
(( $(date +%s) - T0 <= 3 )) || fail "5 stop took more than 3 s"

# 6. PI_MOBILE_RPC=1 → no registration
start_pi rpc PI_MOBILE_RPC=1; sleep 5
[[ "$(req GET /bridge/list | grep -o '"pid"' | wc -l | tr -d ' ')" == 1 ]] || fail "6 PI_MOBILE_RPC pi registered"
kill $LAST_PI 2>/dev/null || true

# 8. terminal pi exits → bridge gone → status falls back (Review Focus 5)
kill $PI_MAIN 2>/dev/null || true; kill_test_pis
wait_for "8 bridge gone" '[[ "$(req GET /bridge/list)" == "200 []" ]]' 20
req GET "/sessions/$S/status" | grep -q '"running":false' || fail "8 fallback status"

echo "PASS"
