# Troubleshooting

All services log one JSON object per line. Useful filters:

```bash
docker compose logs --since 30m worker | jq -c 'select(.level != "debug")'
journalctl -u system-monitor-agent -o cat --since -1h | jq -c 'select(.level == "warn" or .level == "error")'
```

## Agent

| Symptom                                                                        | Cause / fix                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service exits immediately with status 78                                       | Invalid configuration; `journalctl -u system-monitor-agent` names the variable. Common: `MONITOR_URL` uses `http://`, malformed JSON in `AGENT_HTTP_CHECKS`, empty token file.                            |
| `monitoring server rejected agent credentials` (401)                           | Wrong/rotated/revoked token. Check `/etc/system-monitor-agent/agent.token` (no trailing spaces), issue a new token.                                                                                       |
| `metrics push failed` with `unable to verify certificate`                      | Server certificate not trusted: fix the proxy certificate or set `AGENT_CA_FILE`.                                                                                                                         |
| `monitoring server rejected snapshot` 422 `clock_skew` / `stale_payload`       | Host clock is off (`timedatectl`, enable NTP) or the agent buffered data longer than `MAX_SNAPSHOT_AGE_SECONDS`.                                                                                          |
| `pg.up = 0`, error `password authentication failed` / `no pg_hba.conf entry`   | Role or `pg_hba.conf` (see agent-installation.md). This _is_ an outage of the check; the incident is correct.                                                                                             |
| `pg.wal_size_bytes` unavailable: `permission denied for function pg_ls_waldir` | `GRANT pg_monitor TO system_monitor;`                                                                                                                                                                     |
| Disk metrics unavailable for a mount                                           | The path does not exist or the agent cannot traverse it; configure the mount point (e.g. `/var/lib/postgresql`), not the 0700 data directory. With `ProtectHome=read-only`, `/home` is visible read-only. |
| CPU shows "no baseline sample yet"                                             | Only on the very first cycle if `/proc/stat` was unreadable at start-up.                                                                                                                                  |

## Monitoring server

| Symptom                                           | Cause / fix                                                                                                                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose ps` shows api unhealthy           | `/ready` failing → database unreachable. `docker compose logs db api`.                                                                                                                                               |
| Worker unhealthy / dashboard says worker stale    | `docker compose logs worker`; the health file is touched after each evaluation cycle. Database errors or a crash loop are the usual causes.                                                                          |
| Host shows **unknown**                            | Registered but no heartbeat ever received – agent not running or can't reach the server.                                                                                                                             |
| Host **offline** but agent running                | Network/firewall between VMs, proxy down, or token revoked. Check agent logs.                                                                                                                                        |
| Incidents never resolve after fixing              | "No data" never resolves incidents. Ensure the agent reports that metric/resource again; if a mount or check was removed permanently, acknowledge and disable the rule for that host, or disable/re-enable the host. |
| Login returns 403 `Cross-origin request rejected` | `PUBLIC_ORIGIN` must exactly match the browser origin (scheme + host + port).                                                                                                                                        |
| Login works but every request is 401              | Cookie not stored: `COOKIE_SECURE=true` requires HTTPS; use `false` for local http only.                                                                                                                             |
| 429 responses                                     | Rate limits: login 10/min/IP and 5/15 min/e-mail; ingestion 120/min/agent; test messages 5/h/admin. Behind a proxy set `TRUST_PROXY=true` so limits are per client, not per proxy.                                   |

## WhatsApp

| Symptom                                          | Cause / fix                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Notifications stay `queued`                      | `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID` not set (worker logs a warning at start).                                         |
| No notifications created at all                  | `WHATSAPP_RECIPIENT` empty, rule has `notifyWarning=false` for a warning, or cooldown suppressed it (`metadata.cooldownSuppressed`). |
| `failed` with `132001`                           | Template name/language doesn't exist or isn't approved – check `WHATSAPP_TEMPLATE_NAME`/`_LANGUAGE`.                                 |
| `failed` with `132000`                           | Parameter count mismatch: the approved template must have exactly 7 body parameters.                                                 |
| `retrying` with `190`                            | Access token expired/invalid – generate a new system-user token; queued messages go out after the next retry.                        |
| `failed` with `131026` / `131047` (from webhook) | Recipient can't receive (not on WhatsApp, hasn't accepted terms, or re-engagement required).                                         |
| Status stuck at `accepted`                       | Webhook not configured, wrong verify token, or `WHATSAPP_APP_SECRET` mismatch (API logs 401s for `/api/v1/webhooks/whatsapp`).       |

## Database

```bash
docker compose exec db psql -U monitor_owner -d system_monitor
-- open incidents
SELECT status, severity, count(*) FROM incidents WHERE status <> 'resolved' GROUP BY 1, 2;
-- outbox health
SELECT status, count(*), min(next_attempt_at) FROM notifications GROUP BY 1;
-- largest tables
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_statio_user_tables ORDER BY 2 DESC;
```
