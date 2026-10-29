#!/usr/bin/env bash
# Logical backup of the monitoring database (custom format, compressed).
# Cron example (daily 02:15, keep 14 days):
#   15 2 * * * cd /opt/system-monitor && ./backend/deploy/scripts/backup.sh /var/backups/system-monitor 14
set -euo pipefail
DEST="${1:-/var/backups/system-monitor}"
KEEP_DAYS="${2:-14}"
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
mkdir -p "$DEST"
chmod 700 "$DEST"
FILE="$DEST/system_monitor-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T db pg_dump -U "${POSTGRES_USER:-monitor_owner}" -d "${POSTGRES_DB:-system_monitor}" \
  --format=custom --compress=6 --no-owner > "$FILE.partial"
# Verify the archive is readable before declaring success.
docker compose exec -T db pg_restore --list < "$FILE.partial" > /dev/null
mv "$FILE.partial" "$FILE"
chmod 600 "$FILE"
find "$DEST" -name 'system_monitor-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "backup written: $FILE"
