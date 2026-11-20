#!/usr/bin/env bash
# Checks a QoreWatch server end to end and prints PASS or FAIL for each point. Changes nothing.
# Never prints a secret. Run as root:  bash /opt/qorewatch/current/deploy/scripts/verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib.sh"
need_root
FAILS=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILS=$((FAILS+1)); }
chk() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; fi; }

PUBLIC_URL="$(grep -m1 '^PUBLIC_URL=' "$QW_ETC/bot.env" 2>/dev/null | cut -d= -f2- | tr -d '\r' | sed 's#/*$##')"
echo "QoreWatch server check"
echo " service"
chk "qorewatch.service is running" systemctl is-active qorewatch
chk "qorewatch.service starts at boot" systemctl is-enabled qorewatch
chk "the daily backup timer is on" systemctl is-enabled qorewatch-backup.timer
chk "Caddy is running" systemctl is-active caddy
chk "QoreWatch's node is $NODE_MIN or newer ($("$QW_BIN/node" -v 2>/dev/null))" node_ok
chk "runs as the unprivileged qorewatch user" bash -c '[[ "$(ps -o user= -p "$(systemctl show -p MainPID --value qorewatch)")" == qorewatch ]]'
echo " secrets"
chk "bot.env exists, root only, mode 600" bash -c "[[ \"\$(stat -c '%U:%G %a' $QW_ETC/bot.env)\" == 'root:root 600' ]]"
chk "bot.env has a Telegram token" grep -q '^TELEGRAM_BOT_TOKEN=[0-9]\{5,\}:' "$QW_ETC/bot.env"
chk "no .env file inside the release" bash -c "! find -L $QW_ROOT/current -path '*/node_modules' -prune -o -name '.env' -print | grep -q ."
chk "no private/ folder in the release" test ! -e "$QW_ROOT/current/private"
chk "the data folder is private to qorewatch" bash -c "[[ \"\$(stat -c '%U %a' $QW_DATA)\" == 'qorewatch 700' ]]"
echo " network"
chk "the bot listens on 127.0.0.1:$QW_PORT only" bash -c "ss -ltnH '( sport = :$QW_PORT )' | awk '{print \$4}' | grep -qx '127.0.0.1:$QW_PORT' && ! ss -ltnH '( sport = :$QW_PORT )' | awk '{print \$4}' | grep -vqx '127.0.0.1:$QW_PORT'"
HEALTH="$(curl -s -m 5 "http://127.0.0.1:$QW_PORT/healthz")"
if grep -q '"ok":true' <<<"$HEALTH"; then ok "healthy and following the chain: $HEALTH"; else bad "health: ${HEALTH:-no answer}"; fi
if [[ -n "$PUBLIC_URL" ]]; then
  CURL=(curl -s -m 10)
  [[ "${QW_VERIFY_INSECURE:-}" == 1 ]] && CURL+=(-k)
  for path in / /link /fix/window /check/qor1ukeppmkglj3d36ucej3rsntt0yx9lvhu83egha /share.jpg; do
    code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$PUBLIC_URL$path")"
    [[ "$code" == 200 ]] && ok "$PUBLIC_URL$path answers 200" || bad "$PUBLIC_URL$path answered $code"
  done
  H="$("${CURL[@]}" -D - -o /dev/null "$PUBLIC_URL/")"
  for h in strict-transport-security content-security-policy x-frame-options x-content-type-options; do
    grep -qi "^$h:" <<<"$H" && ok "header $h is set" || bad "header $h is missing"
  done
  code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "${PUBLIC_URL/https:/http:}/")"
  [[ "$code" =~ ^30[178]$ ]] && ok "plain http redirects to https ($code)" || bad "plain http answered $code (expected a redirect)"
else
  bad "PUBLIC_URL is not set in bot.env"
fi
echo " storage"
chk "the database exists" test -f "$QW_DATA/qorewatch.sqlite"
LAST="$(ls -1t "$QW_DATA"/backups/qorewatch-*.sqlite 2>/dev/null | head -n1)"
[[ -n "$LAST" ]] && ok "latest backup: $(basename "$LAST")" || bad "no backup yet (run: systemctl start qorewatch-backup)"
echo
if [[ $FAILS -eq 0 ]]; then echo "ALL PASS"; else echo "$FAILS FAIL"; fi
exit $(( FAILS > 0 ))
