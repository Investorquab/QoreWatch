#!/usr/bin/env bash
# Run ONCE on the server, as root, from an unpacked QoreWatch release. Safe to run again.
#
#   bash deploy/scripts/server-setup.sh --domain qorewatch.example.com [--tls internal]
#
# It installs Node.js 22 (NodeSource) and Caddy (official repository) if they are missing,
# creates the unprivileged "qorewatch" user and its folders, installs the systemd units, and
# adds a Caddy site that serves the domain over HTTPS and proxies to 127.0.0.1:8787.
# It does not touch the firewall, SSH or any other site, and stops if another web server
# already holds ports 80/443. --tls internal is for test machines only (a self-signed certificate).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; KIT="$(dirname "$HERE")"
source "$HERE/lib.sh"
need_root

DOMAIN=""; TLS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:?}"; shift 2 ;;
    --tls) [[ "${2:-}" == internal ]] || die "--tls takes only: internal"; TLS="tls internal"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "give the site's domain: --domain qorewatch.example.com"
command -v apt-get >/dev/null || die "this script supports Debian and Ubuntu (apt)"

say "checking ports 80 and 443"
HOLDERS="$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v '"caddy"' || true)"
[[ -z "$HOLDERS" ]] || die "another program already listens on 80/443; QoreWatch's Caddy site would clash with it:
$HOLDERS
Stop and ask the owner how to proceed (for example, add QoreWatch to the existing web server instead)."

export DEBIAN_FRONTEND=noninteractive
say "installing base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

if node_ok; then
  say "Node.js $(node -v) is new enough"
else
  say "installing Node.js 22 from NodeSource"
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq && apt-get install -y -qq nodejs >/dev/null
  node_ok || die "Node.js $NODE_MIN or newer is required, got $(node -v 2>/dev/null || echo none)"
fi
corepack enable >/dev/null 2>&1 || npm install -g corepack >/dev/null

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
install -d -m 755 -o root -g root "$QW_ROOT" "$QW_ROOT/releases"
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
sed -e "s/__DOMAIN__/$DOMAIN/" -e "s/__TLS__/$TLS/" "$KIT/caddy/qorewatch.caddy.template" > /etc/caddy/conf.d/qorewatch.caddy
if [[ ! -s /etc/caddy/Caddyfile ]] || grep -q '/usr/share/caddy' /etc/caddy/Caddyfile; then
  # The package's placeholder site (":80 … /usr/share/caddy") is replaced; nothing else is served.
  printf '# Sites live in conf.d/.\nimport conf.d/*.caddy\n' > /etc/caddy/Caddyfile
elif ! grep -q '^import conf.d/\*\.caddy' /etc/caddy/Caddyfile; then
  cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%Y%m%d%H%M%S)"
  printf '\n# QoreWatch\nimport conf.d/*.caddy\n' >> /etc/caddy/Caddyfile
fi
install -d -m 755 -o caddy -g caddy /var/log/caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || { caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; die "the Caddy configuration is not valid"; }
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "done. Next: server-release.sh with the release archive (and --env the first time)."
[[ -f "$QW_ETC/bot.env" ]] || warn "$QW_ETC/bot.env does not exist yet: pass --env to server-release.sh"
