#!/bin/bash
# Check: server bridge routes and routing. curl plays the terminal bridge.
# Runs server.ts with a temp HOME on port 18940. No pi, no model calls.
# Usage: ./server/test-bridge-server.sh
set -euo pipefail
cd "$(dirname "$0")"
T="$(mktemp -d)"; PORT=18940; B="http://127.0.0.1:$PORT"
cleanup() { kill ${SRV:-} $(jobs -p) 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$T"; }
trap cleanup EXIT
mkdir -p "$T/.pi-companion"; echo "[]" > "$T/.pi-companion/projects.json"
# Fake pi: an rpc turn (has --session) runs 30 s; model/skill/version lookups exit at once.
printf '#!/bin/bash\n[[ " $* " == *" --session "* ]] && exec sleep 30\nexit 0\n' > "$T/fakepi"; chmod +x "$T/fakepi"
mkdir -p "$T/proj3" "$T/.pi/agent/sessions/--p3--"
echo "{\"type\":\"session\",\"version\":3,\"id\":\"s3\",\"cwd\":\"$T/proj3\"}" > "$T/.pi/agent/sessions/--p3--/2026-01-01T00-00-00-000Z_s3.jsonl"

HOME="$T" PORT=$PORT PI_PATH="$T/fakepi" BRIDGE_HOLD_MS=2000 BRIDGE_TTL_MS=4000 BRIDGE_SEND_GRACE_MS=1000 \
  bun run server.ts >"$T/log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do grep -q "Auth token:" "$T/log" 2>/dev/null && break; sleep 0.25; done
TOKEN="$(cat "$T/.pi-companion/token")"; AUTH="Authorization: Bearer $TOKEN"

fail() { echo "FAIL: $1"; tail -20 "$T/log"; exit 1; }
# req METHOD PATH [BODY] → prints "<code> <body>"
req() {
  local f; f="$(mktemp "$T/body.XXXXXX")" # one file per call: background calls run at the same time
  local a=(-s -o "$f" -w '%{http_code}' -X "$1" -H "$AUTH" -H 'content-type: application/json')
  [[ $# -ge 3 ]] && a+=(-d "$3")
  curl "${a[@]}" "$B$2"; echo " $(cat "$f")"
}
poll() { curl -s -X POST -H "$AUTH" -H 'content-type: application/json' -d "$1" "$B/bridge/poll"; }
id_of() { grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4; }
REG='{"pid":4242,"session_id":"s1","session_file":"/x.jsonl","cwd":"/tmp/p","idle":true}'

# A. auth and bad body
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/bridge/poll" -d "$REG")" == 401 ]] || fail "A1 no token → 401"
[[ "$(req POST /bridge/poll '{"pid":"x"}' | cut -c1-3)" == 400 ]] || fail "A2 bad body → 400"
[[ "$(req POST /bridge/event '{"pid":999}' | cut -c1-3)" == 404 ]] || fail "A3 unknown bridge → 404"

# B. register; hold returns [] after BRIDGE_HOLD_MS
[[ "$(poll "$REG")" == '{"commands":[]}' ]] || fail "B1 empty hold"
req GET /sessions/s1/status | grep -q '"running":false' || fail "B2 idle bridge status"
req GET /bridge/list | grep -q '"pid":4242' || fail "B3 list shows bridge"

# C. send while idle → command delivered → ack → 200 → status running (Review Focus 1)
poll "$REG" > "$T/p1" & P=$!; sleep 0.3
req POST /sessions/s1/send '{"text":"hi","model":"x/y"}' > "$T/send" & S=$!
wait $P; grep -q '"type":"send","text":"hi"' "$T/p1" || fail "C1 send command, got $(cat "$T/p1")"
CID="$(id_of < "$T/p1")"
req POST /bridge/event "{\"pid\":4242,\"result\":{\"id\":\"$CID\",\"ok\":true}}" >/dev/null
wait $S; grep -q '^200 {"ok":true}' "$T/send" || fail "C2 send 200, got $(cat "$T/send")"
req GET /sessions/s1/status | grep -q '"running":true' || fail "C3 running right after ack"

# D. events drive state
req POST /bridge/event '{"pid":4242,"state":"idle"}' >/dev/null
req GET /sessions/s1/status | grep -q '"running":false' || fail "D1 idle event"
req POST /bridge/event '{"pid":4242,"state":"running"}' >/dev/null
req POST /bridge/event '{"pid":4242,"activity":"bash sleep 5"}' >/dev/null
req GET /sessions/s1/status | grep -q '"running":true,"activity":"bash sleep 5"' || fail "D2 running + activity"

# E. send while running → 409
[[ "$(req POST /sessions/s1/send '{"text":"x"}')" == '409 {"error":"agent is already working"}' ]] || fail "E1 busy 409"

# F. stop → stop command delivered
poll "$REG" > "$T/p2" & P=$!; sleep 0.3
[[ "$(req POST /sessions/s1/stop | cut -c1-3)" == 200 ]] || fail "F1 stop 200"
wait $P; grep -q '"type":"stop"' "$T/p2" || fail "F1 stop command, got $(cat "$T/p2")"
# F2. a second poll from the same pid releases the first with [] (Review Focus 2)
poll "$REG" > "$T/p3" & P=$!; sleep 0.3
poll "$REG" > "$T/p4" & P2=$!
wait $P; [[ "$(cat "$T/p3")" == '{"commands":[]}' ]] || fail "F2 replaced poll released"
wait $P2
req POST /bridge/event '{"pid":4242,"state":"idle"}' >/dev/null

# G. no poll waiting → 504 after 5 s → command dropped (Review Focus 3)
[[ "$(req POST /sessions/s1/send '{"text":"lost"}')" == '504 {"error":"terminal pi did not answer"}' ]] || fail "G1 504"
[[ "$(poll "$REG")" == '{"commands":[]}' ]] || fail "G2 timed-out command not delivered later"

# H. bridge reports busy → 409
poll "$REG" > "$T/p5" & P=$!; sleep 0.3
req POST /sessions/s1/send '{"text":"b"}' > "$T/send" & S=$!
wait $P; CID="$(id_of < "$T/p5")"
req POST /bridge/event "{\"pid\":4242,\"result\":{\"id\":\"$CID\",\"ok\":false,\"error\":\"busy\"}}" >/dev/null
wait $S; grep -q '^409' "$T/send" || fail "H1 busy → 409, got $(cat "$T/send")"

# I. gone → bridge removed → send falls back to the rpc path (no session file → 404)
req POST /bridge/event '{"pid":4242,"gone":true}' >/dev/null
req GET /bridge/list | grep -q 4242 && fail "I1 gone removes bridge"
[[ "$(req POST /sessions/s1/send '{"text":"x"}' | cut -c1-3)" == 404 ]] || fail "I2 fallback path"

# J. TTL expiry
poll '{"pid":5555,"session_id":"s2","cwd":"/tmp/p","idle":true}' >/dev/null
sleep 4.5
[[ "$(req POST /sessions/s2/send '{"text":"x"}' | cut -c1-3)" == 404 ]] || fail "J1 expired bridge ignored"

# L. ack with no agent_start (prompt failed in the terminal) → next idle poll after the grace clears running
poll '{"pid":6666,"session_id":"s4","cwd":"/tmp/p","idle":true}' > "$T/p6" & P=$!; sleep 0.3
req POST /sessions/s4/send '{"text":"x"}' > "$T/send" & S=$!
wait $P; CID="$(id_of < "$T/p6")"
req POST /bridge/event "{\"pid\":6666,\"result\":{\"id\":\"$CID\",\"ok\":true}}" >/dev/null; wait $S
req GET /sessions/s4/status | grep -q '"running":true' || fail "L1 running after ack"
sleep 1.2
poll '{"pid":6666,"session_id":"s4","cwd":"/tmp/p","idle":true}' >/dev/null & P=$!; sleep 0.3
req GET /sessions/s4/status | grep -q '"running":false' || fail "L2 idle poll after grace clears a stuck running"
wait $P

# M. a running phone (rpc) turn wins over a bridge that registers later
[[ "$(req POST /sessions/s3/send '{"text":"rpc"}' | cut -c1-3)" == 200 ]] || fail "M1 rpc turn starts"
poll "{\"pid\":7777,\"session_id\":\"s3\",\"cwd\":\"$T/proj3\",\"idle\":true}" >/dev/null & P=$!; sleep 0.3
req GET /sessions/s3/status | grep -q '"running":true' || fail "M2 status shows the rpc turn, not the idle bridge"
[[ "$(req POST /sessions/s3/send '{"text":"x"}')" == '409 {"error":"agent is already working"}' ]] || fail "M3 send while rpc turn runs → 409"
wait $P
poll "{\"pid\":7777,\"session_id\":\"s3\",\"cwd\":\"$T/proj3\",\"idle\":true}" > "$T/p7" & P=$!; sleep 0.3
req POST /sessions/s3/stop >/dev/null
wait $P; [[ "$(cat "$T/p7")" == '{"commands":[]}' ]] || fail "M4 stop goes to the rpc turn, not the bridge"
for _ in $(seq 1 10); do req GET /sessions/s3/status | grep -q '"running":false' && break; sleep 0.3; done
req GET /sessions/s3/status | grep -q '"running":false' || fail "M5 rpc turn stopped"

# K. non-loopback source → 403
LAN="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
if [[ -n "$LAN" ]]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$AUTH" -d "$REG" "http://$LAN:$PORT/bridge/poll")"
  [[ "$code" == 403 ]] || fail "K1 LAN → 403, got $code"
else echo "SKIP K (no LAN IP)"; fi

echo "PASS"
