#!/usr/bin/env bash
# Run ONCE on the server, as root, from an unpacked QoreWatch release. Safe to run again.
#
#   bash deploy/scripts/server-setup.sh --domain qorewatch.example.com [--port 8787] [--tls internal]
#
# Works on a fresh server and on a shared one that already runs other sites and apps:
# - Node: uses the system node if it is 22.13 or newer; otherwise installs a private Node 22
#   (official build, checksum-verified) under /opt/qorewatch/node. The system node, npm and pnpm
#   are never changed.
# - Caddy: installed from its official repository only if missing. An existing Caddyfile is never
#   replaced (only the package's untouched placeholder is): it is backed up and gets one line,
#   "import conf.d/*.caddy", and QoreWatch's site goes to /etc/caddy/conf.d/qorewatch.caddy.
#   The change is applied with Caddy's graceful reload; if Caddy rejects it, the backup is restored.
# - Port: the bot listens on 127.0.0.1:<port> (default 8787); setup stops if another program holds it.
# It does not touch the firewall, SSH or any other site or app. --tls internal is for test machines only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; KIT="$(dirname "$HERE")"
source "$HERE/lib.sh"
need_root

DOMAIN=""; TLS=""; PORT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --tls) [[ "${2:-}" == internal ]] || die "--tls takes only: internal"; TLS="tls internal"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "give the site's domain: --domain qorewatch.example.com"
command -v apt-get >/dev/null || die "this script supports Debian and Ubuntu (apt)"
if [[ -n "$PORT" ]]; then
  [[ "$PORT" =~ ^[0-9]{2,5}$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || die "--port takes a number from 1024 to 65535"
  QW_PORT="$PORT"
fi

say "checking port $QW_PORT is free for QoreWatch"
HOLDER="$(port_holder "$QW_PORT")"
# A rerun is fine: the port may be held by QoreWatch's own running process.
QW_PID="$(systemctl show -p MainPID --value qorewatch 2>/dev/null || echo 0)"
if [[ -n "$HOLDER" && "${QW_PID:-0}" != 0 ]] && grep -q "pid=$QW_PID," <<<"$HOLDER"; then HOLDER=""; fi
[[ -z "$HOLDER" ]] || die "port $QW_PORT is already used by another program:
$HOLDER
Pick a free one with --port (and nothing else changes)."

if [[ -f /etc/caddy/Caddyfile ]] && grep -qE "(^|[[:space:],])${DOMAIN//./\\.}([[:space:],{]|$)" /etc/caddy/Caddyfile; then
  die "$DOMAIN is already a site in /etc/caddy/Caddyfile; pick another domain"
fi

say "checking ports 80 and 443"
HOLDERS="$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v '"caddy"' || true)"
[[ -z "$HOLDERS" ]] || die "another program already listens on 80/443; QoreWatch's Caddy site would clash with it:
$HOLDERS
Stop and ask the owner how to proceed (for example, add QoreWatch to the existing web server instead)."

export DEBIAN_FRONTEND=noninteractive
say "installing base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

install -d -m 755 -o root -g root "$QW_ROOT" "$QW_BIN"
SYS_NODE="$(command -v node || true)"
if [[ -n "$SYS_NODE" && "$SYS_NODE" =~ ^/usr/(local/)?bin/ ]] && node_bin_ok "$SYS_NODE"; then
  say "using the system Node.js $("$SYS_NODE" -v) ($SYS_NODE)"
  ln -sfn "$SYS_NODE" "$QW_BIN/node"
  ln -sfn "$(dirname "$(readlink -f "$SYS_NODE")")/corepack" "$QW_BIN/corepack"
elif node_bin_ok "$QW_ROOT/node/bin/node"; then
  say "using QoreWatch's private Node.js $("$QW_ROOT/node/bin/node" -v)"
  ln -sfn "$QW_ROOT/node/bin/node" "$QW_BIN/node"; ln -sfn "$QW_ROOT/node/bin/corepack" "$QW_BIN/corepack"
else
  [[ -n "$SYS_NODE" ]] && say "the system Node.js ($("$SYS_NODE" -v 2>/dev/null || echo unknown), $SYS_NODE) stays as it is; QoreWatch gets its own"
  case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  BASE=https://nodejs.org/dist/latest-v22.x
  SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt")" || die "could not reach nodejs.org"
  LINE="$(grep -E " node-v22\.[0-9]+\.[0-9]+-linux-$ARCH\.tar\.xz$" <<<"$SUMS" | head -n1)"
  [[ -n "$LINE" ]] || die "no Node 22 build for linux-$ARCH on nodejs.org"
  FILE="${LINE##* }"; SUM="${LINE%% *}"
  say "installing a private ${FILE%.tar.xz} for QoreWatch only (checksum-verified)"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  curl -fsSL -o "$TMP/$FILE" "$BASE/$FILE"
  echo "$SUM  $TMP/$FILE" | sha256sum -c --quiet - || die "Node download failed its checksum"
  command -v xz >/dev/null || apt-get install -y -qq xz-utils >/dev/null
  rm -rf "$QW_ROOT/node.new"; install -d -m 755 "$QW_ROOT/node.new"
  tar -xJf "$TMP/$FILE" -C "$QW_ROOT/node.new" --strip-components=1 --no-same-owner
  rm -rf "$QW_ROOT/node"; mv "$QW_ROOT/node.new" "$QW_ROOT/node"
  ln -sfn "$QW_ROOT/node/bin/node" "$QW_BIN/node"; ln -sfn "$QW_ROOT/node/bin/corepack" "$QW_BIN/corepack"
fi
node_ok || die "Node.js $NODE_MIN or newer is required for QoreWatch"
[[ -x "$QW_BIN/corepack" ]] || die "corepack is missing next to $(readlink -f "$QW_BIN/node")"

if command -v caddy >/dev/null; then
  say "Caddy $(caddy version | awk '{print $1}') is installed"
else
  say "installing Caddy from its official repository"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

say "creating the qorewatch user and folders"
id "$QW_USER" >/dev/null 2>&1 || useradd --system --home-dir "$QW_DATA" --shell /usr/sbin/nologin "$QW_USER"
install -d -m 755 -o root -g root "$QW_ROOT/releases"
install -d -m 700 -o "$QW_USER" -g "$QW_USER" "$QW_DATA" "$QW_DATA/backups"
install -d -m 700 -o root -g root "$QW_ETC"
cat > "$QW_ETC/runtime.env" <<RUNTIME
# Written by server-setup.sh. Fixed for this server layout; wins over bot.env.
DATA_DIR=$QW_DATA
HTTP_HOST=127.0.0.1
HTTP_PORT=$QW_PORT
WEB_DIR=$QW_ROOT/current/apps/web/dist
RUNTIME
chmod 600 "$QW_ETC/runtime.env"

say "installing the systemd units"
install -m 644 "$KIT/systemd/qorewatch.service" "$KIT/systemd/qorewatch-backup.service" "$KIT/systemd/qorewatch-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable qorewatch.service qorewatch-backup.timer >/dev/null 2>&1

say "adding the Caddy site for $DOMAIN"
install -d -m 755 /etc/caddy/conf.d
CF=/etc/caddy/Caddyfile
BAK=""
SITE_NEW="$(sed -e "s/__DOMAIN__/$DOMAIN/" -e "s/__TLS__/$TLS/" -e "s/__PORT__/$QW_PORT/" "$KIT/caddy/qorewatch.caddy.template")"
SITE_OLD="$(cat /etc/caddy/conf.d/qorewatch.caddy 2>/dev/null || true)"
# The package's untouched placeholder: ":80 { root * /usr/share/caddy / file_server }" and comments only.
stock() { [[ "$(sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$CF" | grep -v '^$' | tr '\n' '|')" == ':80 {|root * /usr/share/caddy|file_server|}|' ]]; }
if [[ -f "$CF" ]]; then BAK="$CF.bak-$(date +%Y%m%d%H%M%S)"; cp -a "$CF" "$BAK"; fi
printf '%s\n' "$SITE_NEW" > /etc/caddy/conf.d/qorewatch.caddy
if [[ ! -s "$CF" ]] || stock; then
  printf '# Sites live in conf.d/.\nimport conf.d/*.caddy\n' > "$CF"
elif ! grep -q '^import conf.d/\*\.caddy' "$CF"; then
  printf '\n# QoreWatch (added by server-setup.sh; the site is in conf.d/qorewatch.caddy)\nimport conf.d/*.caddy\n' >> "$CF"
fi
restore() {
  if [[ -n "$BAK" ]]; then cp -a "$BAK" "$CF"; else rm -f "$CF"; fi
  if [[ -n "$SITE_OLD" ]]; then printf '%s\n' "$SITE_OLD" > /etc/caddy/conf.d/qorewatch.caddy; else rm -f /etc/caddy/conf.d/qorewatch.caddy; fi
}
# Syntax first (adapt touches nothing), then Caddy's own reload, which keeps the running config if the new one fails.
if ! caddy adapt --config "$CF" --adapter caddyfile >/dev/null 2>"$QW_ETC/caddy-adapt.log"; then
  cat "$QW_ETC/caddy-adapt.log" >&2; restore; die "Caddy rejected the configuration; the previous Caddyfile is restored and nothing was reloaded"
fi
systemctl enable caddy >/dev/null 2>&1
if systemctl is-active --quiet caddy; then
  if ! systemctl reload caddy; then
    journalctl -u caddy -n 20 --no-pager >&2
    restore; systemctl reload caddy || true
    die "Caddy did not accept the new site; the previous Caddyfile is restored (the other sites kept running)"
  fi
else
  systemctl restart caddy
fi
sleep 2
systemctl is-active --quiet caddy || { journalctl -u caddy -n 20 --no-pager >&2; die "Caddy is not running after the change (log above)"; }
[[ -n "$BAK" ]] && say "previous Caddyfile kept as $BAK"

say "done. Next: server-release.sh with the release archive (and --env the first time)."
[[ -f "$QW_ETC/bot.env" ]] || warn "$QW_ETC/bot.env does not exist yet: pass --env to server-release.sh"
