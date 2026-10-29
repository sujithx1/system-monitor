# Configuration reference

All configuration is via environment variables, parsed and validated at start-up
(`packages/config/src/index.ts`). Invalid configuration exits with code 78 and names the variable,
never its value.

## Monitoring VM (`.env`, used by docker compose)

| Variable                                                | Default                                | Used by              | Description                                                                                  |
| ------------------------------------------------------- | -------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`   | `monitor_owner` / – / `system_monitor` | db, migrate          | Schema owner (migrations only). Use hex secrets (`openssl rand -hex 32`).                    |
| `APP_DB_PASSWORD`                                       | –                                      | db init, api, worker | Password of the DML-only runtime role `monitor_app`.                                         |
| `DATABASE_URL`                                          | set by compose                         | api, worker          | Runtime connection string.                                                                   |
| `DATABASE_POOL_MAX`                                     | `10`                                   | api, worker          | Connection pool size.                                                                        |
| `LOG_LEVEL`                                             | `info`                                 | all                  | `debug`, `info`, `warn`, `error`. JSON logs on stdout.                                       |
| `API_HOST` / `API_PORT`                                 | `127.0.0.1` / `3000`                   | api                  | Compose sets `0.0.0.0` inside the container and publishes on `127.0.0.1` only.               |
| `PUBLIC_ORIGIN`                                         | –                                      | api                  | `https://monitor.example.com`; enables the Origin check on state-changing requests.          |
| `TRUST_PROXY`                                           | `false`                                | api                  | `true` behind Nginx (client IP from the right-most `X-Forwarded-For`).                       |
| `COOKIE_SECURE`                                         | `true`                                 | api                  | `false` only for plain-HTTP local development.                                               |
| `SESSION_TTL_HOURS`                                     | `12`                                   | api                  | Absolute session lifetime.                                                                   |
| `MAX_BODY_BYTES`                                        | `262144`                               | api                  | Request body limit.                                                                          |
| `MAX_SNAPSHOT_AGE_SECONDS`                              | `900`                                  | api                  | Older agent payloads are rejected (replay protection; bounds agent buffering).               |
| `MAX_CLOCK_SKEW_SECONDS`                                | `60`                                   | api                  | Future-dated payloads beyond this are rejected.                                              |
| `HEARTBEAT_OFFLINE_SECONDS`                             | `180`                                  | api                  | When a host is shown as offline in the dashboard.                                            |
| `WORKER_STALE_SECONDS`                                  | `90`                                   | api                  | When the worker is reported unhealthy.                                                       |
| `EVALUATION_INTERVAL_SECONDS`                           | `15`                                   | worker               | Rule evaluation cadence.                                                                     |
| `DISPATCH_INTERVAL_MS`                                  | `2000`                                 | worker               | Outbox polling cadence.                                                                      |
| `STALE_AFTER_SECONDS`                                   | `120`                                  | worker               | Newest sample older than this = no data (state unchanged).                                   |
| `AGENT_INTERVAL_SECONDS`                                | `30`                                   | worker               | Expected agent interval (gap tolerance, check windows).                                      |
| `METRICS_RETENTION_DAYS`                                | `30`                                   | worker               | Raw metric retention.                                                                        |
| `INCIDENT_RETENTION_DAYS`                               | `365`                                  | worker               | Resolved incidents older than this are purged.                                               |
| `NOTIFICATION_RETENTION_DAYS`                           | `90`                                   | worker               | Finished notifications older than this are purged.                                           |
| `ALERT_TIMEZONE`                                        | `UTC`                                  | worker               | IANA zone for timestamps in messages.                                                        |
| `DEADMAN_PING_URL`                                      | –                                      | worker               | External heartbeat URL, pinged ≤ once a minute after successful cycles.                      |
| `WHATSAPP_ACCESS_TOKEN`                                 | –                                      | worker               | System-user token with `whatsapp_business_messaging`. Without it, notifications stay queued. |
| `WHATSAPP_PHONE_NUMBER_ID`                              | –                                      | worker               | Sender phone number ID (not the phone number).                                               |
| `WHATSAPP_RECIPIENT`                                    | –                                      | worker, api          | Comma-separated E.164 numbers. Default recipients and the allow-list for test messages.      |
| `WHATSAPP_API_VERSION`                                  | `v23.0`                                | worker               | Graph API version; keep current per Meta's changelog.                                        |
| `WHATSAPP_TEMPLATE_NAME` / `WHATSAPP_TEMPLATE_LANGUAGE` | `system_alert` / `en`                  | worker               | Approved template (see whatsapp-setup.md).                                                   |
| `WHATSAPP_TIMEOUT_MS`                                   | `10000`                                | worker               | Per-request timeout.                                                                         |
| `WHATSAPP_MAX_ATTEMPTS`                                 | `10`                                   | worker               | Attempts before a notification is marked failed (~50 min with backoff).                      |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN`                         | –                                      | api                  | Verify token entered in the Meta webhook configuration.                                      |
| `WHATSAPP_APP_SECRET`                                   | –                                      | api                  | Meta app secret; webhook POSTs without a valid `X-Hub-Signature-256` are rejected.           |
| `API_PUBLISH_PORT`                                      | `3000`                                 | compose              | Host port the API is published on, on `127.0.0.1` only. Must match `proxy_pass` in Nginx.    |

## Agent (`/etc/system-monitor-agent/agent.env`)

| Variable                                             | Default     | Description                                                                                                                                  |
| ---------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONITOR_URL`                                        | –           | `https://monitor.example.com`.`http://` is refused unless `AGENT_ALLOW_INSECURE_HTTP=true` (local dev only).                                 |
| `AGENT_TOKEN_FILE` / `AGENT_TOKEN`                   | –           | Prefer the file (systemd `LoadCredential`).                                                                                                  |
| `AGENT_CA_FILE`                                      | –           | PEM CA bundle if the server certificate is privately issued.                                                                                 |
| `AGENT_INTERVAL_SECONDS` / `AGENT_HEARTBEAT_SECONDS` | `30` / `30` | Snapshot and heartbeat cadence.                                                                                                              |
| `AGENT_REQUEST_TIMEOUT_MS`                           | `10000`     | Timeout for pushes to the monitoring server.                                                                                                 |
| `AGENT_MAX_BUFFER`                                   | `20`        | Snapshots kept while the server is unreachable (oldest dropped first).                                                                       |
| `AGENT_MOUNTS`                                       | `/`         | Comma-separated mount points, or `auto` (one entry per real filesystem; bind mounts collapsed). Include PostgreSQL data and WAL filesystems. |
| `AGENT_PROC_ROOT`                                    | `/proc`     | Override for containers (e.g. `/host/proc`).                                                                                                 |
| `AGENT_PG_URL`                                       | –           | Single PostgreSQL target named `main`.                                                                                                       |
| `AGENT_PG_TARGETS`                                   | `[]`        | JSON array `[{"name","url"}]` for more databases/clusters.                                                                                   |
| `AGENT_PG_TIMEOUT_MS`                                | `5000`      | Connect + per-query timeout.                                                                                                                 |
| `AGENT_PG_REPLICATION`                               | `false`     | Report replication lag (replica: replay delay; primary: max `replay_lag`).                                                                   |
| `AGENT_HTTP_CHECKS`                                  | `[]`        | JSON array `[{"name","url","timeoutMs"?,"expectedStatus"?:[200]}]`. Redirects are not followed.                                              |
| `AGENT_DOCKER_SOCKET`                                | –           | Read-only Docker socket proxy path for container status.                                                                                     |
| `AGENT_BACKUP_MARKERS`                               | `[]`        | JSON array `[{"name","path"}]`; reports the age of each marker file.                                                                         |

To alert on backup freshness or replication lag, add rules, e.g.:

```json
{ "name": "Backup freshness", "kind": "threshold", "metric": "backup.age_seconds",
  "warningThreshold": 93600, "criticalThreshold": 180000 }
{ "name": "Replication lag", "kind": "threshold", "metric": "pg.replication_lag_seconds",
  "warningThreshold": 60, "warningForSeconds": 120, "criticalThreshold": 300, "criticalForSeconds": 120 }
{ "name": "WAL archiving", "kind": "threshold", "metric": "pg.archiver_last_archived_age_seconds",
  "warningThreshold": 900, "criticalThreshold": 3600 }
```
