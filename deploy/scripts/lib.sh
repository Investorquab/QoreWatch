# shellcheck shell=bash disable=SC2034
# Shared helpers for the server scripts. Not run on its own.
QW_ROOT=/opt/qorewatch
QW_DATA=/var/lib/qorewatch
QW_ETC=/etc/qorewatch
QW_USER=qorewatch
QW_PORT=8787
# The node QoreWatch runs: a link to the system node, or to a private Node 22 under $QW_ROOT/node.
QW_BIN="$QW_ROOT/bin"
NODE_MIN="22.13.0"
# server-setup.sh records the chosen port in runtime.env; later scripts read it from there.
if [[ -r "$QW_ETC/runtime.env" ]]; then
  _p="$(sed -n 's/^HTTP_PORT=\([0-9]\{2,5\}\)$/\1/p' "$QW_ETC/runtime.env" | head -n1)"
  [[ -n "$_p" ]] && QW_PORT="$_p"
fi

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
need_root() { [[ $EUID -eq 0 ]] || die "run this as root (sudo bash $0 …)"; }
ver_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]; }
# True when the given node binary is new enough.
node_bin_ok() { [[ -x "$1" ]] && ver_ge "$("$1" -p 'process.versions.node' 2>/dev/null || echo 0)" "$NODE_MIN"; }
node_ok() { node_bin_ok "$QW_BIN/node"; }
as_qw() { runuser -u "$QW_USER" -- env HOME="$QW_DATA" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PATH="$QW_BIN:/usr/local/bin:/usr/bin:/bin" "$@"; }
# Who listens on a TCP port on this machine (empty when free).
port_holder() { ss -ltnpH "( sport = :$1 )" 2>/dev/null; }
