# Shared helpers for the server scripts. Not run on its own.
QW_ROOT=/opt/qorewatch
QW_DATA=/var/lib/qorewatch
QW_ETC=/etc/qorewatch
QW_USER=qorewatch
QW_PORT=8787
NODE_MIN="22.13.0"

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
need_root() { [[ $EUID -eq 0 ]] || die "run this as root (sudo bash $0 …)"; }
ver_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]; }
node_ok() { command -v node >/dev/null && ver_ge "$(node -p 'process.versions.node')" "$NODE_MIN"; }
as_qw() { runuser -u "$QW_USER" -- env HOME="$QW_DATA" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PATH="$PATH" "$@"; }
