#!/usr/bin/env bash
# Run on YOUR computer, from the repository. Uploads one committed version of QoreWatch to the
# server, and optionally the bot's .env. It never runs anything on the server except writing
# these two files to /tmp; deploy with server-release.sh afterwards.
#
#   deploy/scripts/ship.sh user@server [--env apps/bot/.env] [--ref HEAD] [--port 22]
#
# Only what git tracks is shipped (git archive), so private/, .env files, data/ and anything
# uncommitted can never reach the server through this script.
set -euo pipefail

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[[ $# -ge 1 ]] || usage
TARGET="$1"; shift
ENV_FILE=""; REF="HEAD"; PORT="22"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_FILE="${2:?}"; shift 2 ;;
    --ref) REF="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    *) usage ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
SHA="$(git rev-parse --short=12 "$REF^{commit}")"
NAME="qorewatch-$SHA"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "note: you have uncommitted changes; they are NOT shipped (only $REF = $SHA is)." >&2
fi

# Refuse to ship a commit that tracks anything secret-looking.
BAD="$(git ls-tree -r --name-only "$SHA" | grep -E '(^|/)(\.env(\..*)?|.*\.sqlite|.*\.pem|.*\.key|keys\.json)$|^private/' | grep -v '\.env\.example$' || true)"
if [[ -n "$BAD" ]]; then
  echo "refusing to ship: commit $SHA tracks files that look private:" >&2
  echo "$BAD" >&2
  exit 1
fi

SSH=(ssh -p "$PORT" -o BatchMode=yes "$TARGET")
echo "uploading $NAME.tar.gz to $TARGET:/tmp/"
git archive --format=tar.gz --prefix="$NAME/" "$SHA" | "${SSH[@]}" "umask 077; cat > /tmp/$NAME.tar.gz"

if [[ -n "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || { echo "no such file: $ENV_FILE" >&2; exit 1; }
  grep -q '^TELEGRAM_BOT_TOKEN=.\+' "$ENV_FILE" || { echo "$ENV_FILE has no TELEGRAM_BOT_TOKEN value" >&2; exit 1; }
  grep -q '^PUBLIC_URL=https://' "$ENV_FILE" || { echo "$ENV_FILE needs PUBLIC_URL=https://your-domain" >&2; exit 1; }
  echo "uploading the bot settings to $TARGET:/tmp/qorewatch-bot.env (mode 600; server-release.sh moves it)"
  "${SSH[@]}" "umask 077; cat > /tmp/qorewatch-bot.env" < "$ENV_FILE"
fi

cat <<NEXT

Uploaded. On the server, as root (or with sudo):

  tar -xzf /tmp/$NAME.tar.gz -C /tmp
  bash /tmp/$NAME/deploy/scripts/server-setup.sh --domain YOUR.DOMAIN     # first time only
  bash /tmp/$NAME/deploy/scripts/server-release.sh /tmp/$NAME.tar.gz${ENV_FILE:+ --env /tmp/qorewatch-bot.env}
  bash /opt/qorewatch/current/deploy/scripts/verify.sh
NEXT
