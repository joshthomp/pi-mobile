#!/bin/bash
# Check: the server reports a terminal `pi` turn as running.
# Runs server.ts with a temp HOME on port 18940, fake sessions, and a fake `pi` process.
# Usage: ./server/test-terminal-turn.sh
set -euo pipefail
cd "$(dirname "$0")"
T="$(mktemp -d)"; PORT=18940
cleanup() { kill ${SRV:-} ${FAKEPI:-} 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$T"; }
trap cleanup EXIT

PROJ="$T/proj"; mkdir -p "$PROJ" "$T/.pi-companion"
DIR="$T/.pi/agent/sessions/--proj--"; mkdir -p "$DIR"
echo "[{\"path\":\"$PROJ\",\"added\":1}]" > "$T/.pi-companion/projects.json"
F="$DIR/2026-01-01T00-00-00-000Z_s1.jsonl"
hdr="{\"type\":\"session\",\"version\":3,\"id\":\"s1\",\"cwd\":\"$PROJ\"}"
user='{"type":"message","id":"a","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}'
tool='{"type":"message","id":"b","parentId":"a","message":{"role":"assistant","stopReason":"toolUse","content":[]}}'
done_='{"type":"message","id":"c","parentId":"b","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"ok"}]}}'

HOME="$T" PORT=$PORT PI_PATH=/usr/bin/true bun run server.ts >"$T/log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do grep -q "Auth token:" "$T/log" 2>/dev/null && break; sleep 0.25; done
TOKEN="$(cat "$T/.pi-companion/token")"
running() { sleep 2.1; curl -s -H "Authorization: Bearer $TOKEN" "localhost:$PORT/sessions/s1/status" | grep -q '"running":true'; }
status() { curl -s -H "Authorization: Bearer $TOKEN" "localhost:$PORT/workspaces/-${PROJ//\//-}--" | grep -o '"status":"[^"]*"'; }
fail() { echo "FAIL: $1"; cat "$T/log"; exit 1; }

printf '%s\n%s\n%s\n' "$hdr" "$user" "$tool" > "$F"
running && fail "open turn, no pi process → should be stopped"

# Real pi is a node script that sets process.title = "pi" (ps comm = pi).
(cd "$PROJ" && exec node -e 'process.title = "pi"; setTimeout(() => {}, 60000)') & FAKEPI=$!
for _ in $(seq 1 40); do [[ "$(ps -o comm= -p $FAKEPI)" == pi ]] && break; sleep 0.1; done
running || fail "open turn + pi in cwd → should be running"
[[ "$(status)" == '"status":"in-progress"' ]] || fail "workspace badge should be in-progress, got $(status)"

echo "$done_" >> "$F"
running && fail "final assistant reply → should be stopped"

printf '%s\n' "$user" >> "$F"
running || fail "new user message → should be running"

kill "$FAKEPI"; wait "$FAKEPI" 2>/dev/null || true; FAKEPI=
running && fail "pi exited → should be stopped"
echo "PASS"
