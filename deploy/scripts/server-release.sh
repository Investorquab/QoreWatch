#!/usr/bin/env bash
# Run on the server, as root, for every new version. Builds the release as the unprivileged
# qorewatch user, switches to it, restarts the bot and rolls back if it does not come up.
#
#   bash server-release.sh /tmp/qorewatch-<commit>.tar.gz [--env /tmp/qorewatch-bot.env]
#
# --env installs the uploaded .env as /etc/qorewatch/bot.env (root only, mode 600) and
# deletes the upload. Without it the existing bot.env is kept.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib.sh"
need_root

TARBALL="${1:-}"; shift || true
ENV_UPLOAD=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_UPLOAD="${2:?}"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
[[ -f "$TARBALL" ]] || die "usage: server-release.sh /tmp/qorewatch-<commit>.tar.gz [--env file]"
NAME="$(basename "$TARBALL" .tar.gz)"
[[ "$NAME" =~ ^qorewatch-[0-9a-f]{7,40}$ ]] || die "unexpected archive name $NAME (make it with ship.sh)"
id "$QW_USER" >/dev/null 2>&1 && [[ -d "$QW_ROOT/releases" ]] || die "run server-setup.sh first"
node_ok || die "Node.js $NODE_MIN or newer is required"

if [[ -n "$ENV_UPLOAD" ]]; then
  [[ -f "$ENV_UPLOAD" ]] || die "no such file: $ENV_UPLOAD"
  say "installing the bot settings as $QW_ETC/bot.env (root only)"
  install -m 600 -o root -g root "$ENV_UPLOAD" "$QW_ETC/bot.env"
  shred -u "$ENV_UPLOAD" 2>/dev/null || rm -f "$ENV_UPLOAD"
fi
[[ -f "$QW_ETC/bot.env" ]] || die "$QW_ETC/bot.env is missing: upload it with ship.sh --env and pass --env here"
chown root:root "$QW_ETC/bot.env"; chmod 600 "$QW_ETC/bot.env"
for k in TELEGRAM_BOT_TOKEN PUBLIC_URL; do
  grep -q "^$k=.\+" "$QW_ETC/bot.env" || die "$QW_ETC/bot.env has no value for $k"
done
# Settings server-side overrides make pointless are only a warning (runtime.env wins).

DEST="$QW_ROOT/releases/$NAME"
PREV="$(readlink -f "$QW_ROOT/current" 2>/dev/null || true)"
if [[ "$PREV" == "$DEST" ]]; then
  say "$NAME is already the running release; rebuilding it in place is not supported. Nothing to do."
  exit 0
fi

say "unpacking $NAME"
rm -rf "$DEST" "$DEST.tmp"; install -d -m 755 "$DEST.tmp"
tar -xzf "$TARBALL" -C "$DEST.tmp" --strip-components=1 --no-same-owner
if [[ -d "$DEST.tmp/private" ]] || find "$DEST.tmp" \( -name '.env' -o -name '*.sqlite' \) -print | grep -q .; then
  rm -rf "$DEST.tmp"; die "the archive contains private files; refusing"
fi
chown -R "$QW_USER:$QW_USER" "$DEST.tmp"

say "installing dependencies and building (as $QW_USER)"
cd "$DEST.tmp"
as_qw corepack pnpm install --frozen-lockfile --reporter=append-only >/dev/null
as_qw corepack pnpm --filter @qorewatch/web --filter @qorewatch/bot build >/dev/null
[[ -f apps/bot/dist/main.js && -f apps/web/dist/index.html && -f apps/web/dist/link.html ]] || die "the build did not produce apps/bot/dist and apps/web/dist"
cd /
chown -R root:root "$DEST.tmp"
mv "$DEST.tmp" "$DEST"

# Units can change between versions.
if ! cmp -s "$DEST/deploy/systemd/qorewatch.service" /etc/systemd/system/qorewatch.service \
  || ! cmp -s "$DEST/deploy/systemd/qorewatch-backup.service" /etc/systemd/system/qorewatch-backup.service \
  || ! cmp -s "$DEST/deploy/systemd/qorewatch-backup.timer" /etc/systemd/system/qorewatch-backup.timer; then
  say "updating the systemd units"
  install -m 644 "$DEST/deploy/systemd/"qorewatch*.{service,timer} /etc/systemd/system/
  systemctl daemon-reload
fi

if [[ -f "$QW_DATA/qorewatch.sqlite" ]]; then
  say "backing up the database before the switch"
  as_qw "$DEST/deploy/scripts/backup.sh" pre-release
fi

switch_to() { ln -sfn "$1" "$QW_ROOT/current.new" && mv -T "$QW_ROOT/current.new" "$QW_ROOT/current"; }
started() {
  for _ in $(seq 1 45); do
    sleep 2
    systemctl is-active --quiet qorewatch || continue
    curl -fsS -o /dev/null -m 3 "http://127.0.0.1:$QW_PORT/healthz" 2>/dev/null && return 0
    # 503 means the bot runs but the chain is not reachable yet: still a running release.
    [[ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$QW_PORT/healthz")" == 503 ]] && return 0
  done
  return 1
}

say "switching to $NAME and restarting"
switch_to "$DEST"
systemctl restart qorewatch
if ! started; then
  warn "the new release did not come up. Last log lines:"
  journalctl -u qorewatch -n 25 --no-pager >&2 || true
  if [[ -n "$PREV" && -d "$PREV" ]]; then
    warn "rolling back to $(basename "$PREV")"
    switch_to "$PREV"; systemctl restart qorewatch
    started && warn "rolled back; the previous release is running" || warn "the previous release did not come up either"
  fi
  exit 1
fi

say "running: $(curl -s -m 3 "http://127.0.0.1:$QW_PORT/healthz")"
# Keep the three newest releases.
ls -1dt "$QW_ROOT"/releases/qorewatch-* 2>/dev/null | tail -n +4 | while read -r old; do
  [[ "$old" == "$(readlink -f "$QW_ROOT/current")" ]] || rm -rf "$old"
done
rm -f "$TARBALL"
say "done. Check everything with: bash $QW_ROOT/current/deploy/scripts/verify.sh"
