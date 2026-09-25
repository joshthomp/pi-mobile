#!/bin/bash
# Check: `pi-companion` (a symlink to ~/.pi-companion/install.sh) reinstalls from
# the installed files and never downloads from GitHub.
# Temp HOME + stub launchctl/lsof/curl/bun: no real service, port or network.
# Usage: ./server/test-install-symlink.sh
set -euo pipefail
cd "$(dirname "$0")"
T="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $1"; cat "$T/out" 2>/dev/null; exit 1; }

# Stubs
mkdir -p "$T/bin"
cat > "$T/bin/launchctl" <<'E'
#!/bin/bash
case "$1" in
  print) exit 1 ;;                                               # not running
  bootstrap) echo "Auth token: x" > "$HOME/.pi-companion/server.log" ;;
esac
exit 0
E
printf '#!/bin/bash\nexit 1\n' > "$T/bin/lsof"                     # port free
printf '#!/bin/bash\necho "$*" >> "$HOME/curl-called"\nexit 1\n' > "$T/bin/curl"
printf '#!/bin/bash\nexit 0\n' > "$T/bin/bun"
chmod +x "$T/bin/"*

# An installed copy, as a previous install leaves it
I="$T/.pi-companion"; mkdir -p "$I/pi-mobile-approval" "$T/.local/bin"
cp install.sh server.ts "$I/"
cp pi-mobile-approval/extension.ts pi-mobile-approval/package.json "$I/pi-mobile-approval/"
ln -s "$I/install.sh" "$T/.local/bin/pi-companion"

# Plain `pi-companion` (no argument) shows the status and usage. It must not install.
HOME="$T" PATH="$T/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$T/.local/bin/pi-companion" > "$T/out" 2>&1 \
  || fail "plain pi-companion exited non-zero"
grep -q "^stopped" "$T/out" || fail "plain pi-companion should print the status"
grep -q "pi-companion install" "$T/out" || fail "plain pi-companion should print the usage"
[[ -e "$T/Library/LaunchAgents/co.bungy.pi-companion.plist" || -e "$I/co.bungy.pi-companion.plist" ]] \
  && fail "plain pi-companion installed a plist"

HOME="$T" PATH="$T/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$T/.local/bin/pi-companion" --always-on > "$T/out" 2>&1 \
  || fail "install through the symlink exited non-zero"
[[ -e "$T/curl-called" ]] && fail "downloaded from GitHub: $(cat "$T/curl-called")"
[[ -f "$T/Library/LaunchAgents/co.bungy.pi-companion.plist" ]] || fail "no always-on plist written"
grep -q "$I/server.ts" "$T/Library/LaunchAgents/co.bungy.pi-companion.plist" || fail "plist does not run the installed server.ts"
echo "PASS"
