#!/usr/bin/env bash
# Restores a backup produced by backup.sh into the monitoring database.
# Stops api/worker first so nothing writes during the restore. DESTRUCTIVE for current data.
# Usage: ./backend/deploy/scripts/restore.sh /var/backups/system-monitor/system_monitor-20261028T021500Z.dump
set -euo pipefail
FILE="${1:?usage: $0 <backup.dump>}"
[[ -f "$FILE" ]] || { echo "no such file: $FILE" >&2; exit 1; }
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
read -r -p "This replaces all monitoring data in ${POSTGRES_DB:-system_monitor}. Type 'restore' to continue: " ok
[[ "$ok" == "restore" ]] || { echo "aborted"; exit 1; }
docker compose stop api worker
docker compose exec -T db pg_restore -U "${POSTGRES_USER:-monitor_owner}" -d "${POSTGRES_DB:-system_monitor}" \
  --clean --if-exists --no-owner --single-transaction < "$FILE"
# Re-apply runtime-role grants (restored tables are owned by the owner role).
docker compose run --rm migrate
docker compose start api worker
echo "restore complete"
