# Backup and restore (monitoring database)

The monitoring database holds hosts, agent credential hashes, rules, incidents, notification
history, audit logs and metric history. Losing it loses history and configuration, not production
data. Agents keep working after a restore as long as their `agents` rows are restored.

## Backups

`backend/deploy/scripts/backup.sh` runs `pg_dump --format=custom` inside the `db` container, verifies the
archive with `pg_restore --list`, writes it with mode 0600 and prunes old files.

```bash
cd /opt/system-monitor
sudo ./backend/deploy/scripts/backup.sh /var/backups/system-monitor 14
# daily at 02:15 UTC
echo '15 2 * * * root cd /opt/system-monitor && ./backend/deploy/scripts/backup.sh /var/backups/system-monitor 14 >> /var/log/system-monitor-backup.log 2>&1' \
  | sudo tee /etc/cron.d/system-monitor-backup
```

Copy backups **off the VM** (e.g. `restic`/`rclone` to object storage with encryption). A backup that
lives only on the monitoring VM does not survive the loss of that VM.

You can monitor this backup with the system itself: register the monitoring VM as a host, run the
agent there with `AGENT_BACKUP_MARKERS=[{"name":"monitor-db","path":"/var/backups/system-monitor/.ok"}]`
and add `&& touch /var/backups/system-monitor/.ok` to the cron line.

## Restore

```bash
cd /opt/system-monitor
./backend/deploy/scripts/restore.sh /var/backups/system-monitor/system_monitor-20261028T021500Z.dump
```

The script asks for confirmation, stops `api` and `worker`, restores in a single transaction with
`--clean --if-exists`, re-runs migrations (re-applying grants for the runtime role and bringing the
schema forward if the dump is older), and starts the services again.

## Disaster recovery (new VM)

1. Provision the VM and follow the deployment guide up to "Configure"; reuse the old `.env`
   (passwords must match the role created on first init, or reset them – see below).
2. `docker compose up -d db && docker compose run --rm migrate`
3. Restore the latest dump with `restore.sh`.
4. Point DNS at the new VM; agents reconnect automatically (they buffer up to `AGENT_MAX_BUFFER`
   snapshots, and data older than 15 minutes is intentionally rejected).

If the runtime role password differs from the restored cluster's (restoring into a fresh volume
creates the role from the current `.env`, so this only happens when you change `.env`):

```bash
docker compose exec db psql -U monitor_owner -d system_monitor -c "ALTER ROLE monitor_app PASSWORD '<APP_DB_PASSWORD>'"
```

## Volume-level backups

Snapshots of the `pgdata` volume are only consistent if taken with the database stopped
(`docker compose stop db`) or via a filesystem that supports atomic snapshots. Prefer `pg_dump` for
this size of database.
