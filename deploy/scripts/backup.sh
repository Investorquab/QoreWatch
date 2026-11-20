#!/usr/bin/env bash
# A consistent copy of the SQLite database (VACUUM INTO works while the bot runs).
# Runs daily from qorewatch-backup.timer as the qorewatch user, and before every release.
#   backup.sh [label]      keeps the 14 newest backups
set -euo pipefail
DATA="${DATA_DIR:-/var/lib/qorewatch}"
DB="$DATA/qorewatch.sqlite"
OUT_DIR="$DATA/backups"
[[ -f "$DB" ]] || { echo "no database at $DB yet; nothing to back up"; exit 0; }
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/qorewatch-$(date -u +%Y%m%dT%H%M%SZ)${1:+-$1}.sqlite"
NODE=/opt/qorewatch/bin/node
[[ -x "$NODE" ]] || NODE="$(command -v node)"
"$NODE" --disable-warning=ExperimentalWarning -e '
  const { DatabaseSync } = require("node:sqlite");
  const [db, out] = process.argv.slice(1);
  const d = new DatabaseSync(db, { readOnly: true });
  d.exec(`VACUUM INTO ${JSON.stringify(out).replace(/^"|"$/g, "\x27")}`);
  const c = new DatabaseSync(out, { readOnly: true });
  const ok = c.prepare("PRAGMA integrity_check").get();
  if (Object.values(ok)[0] !== "ok") { console.error("backup failed its integrity check"); process.exit(1); }
' "$DB" "$OUT"
chmod 600 "$OUT"
echo "backup: $OUT ($(du -h "$OUT" | cut -f1))"
ls -1t "$OUT_DIR"/qorewatch-*.sqlite | tail -n +15 | xargs -r rm -f
