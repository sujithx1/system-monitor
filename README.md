# System Monitor

Self-hosted infrastructure monitoring for Ubuntu production VMs and PostgreSQL, with incident
management and WhatsApp alerting. Runs on its **own VM**, so it keeps alerting when a production
VM, its application or its database goes down.

```
 Production VM(s)                         Monitoring VM (docker compose)
 ┌──────────────────────────┐   HTTPS    ┌───────────────────────────────────────────────┐
 │ system-monitor-agent (systemd)    │──push────▶ │ Nginx :443 (host) ─▶ api (Hono, 127.0.0.1:3000)│
 │  /proc, statfs, SQL,     │  every 30s │                         │                      │
 │  HTTP checks             │            │ worker ─ rule evaluation every 15 s            │
 │  (no listening ports)    │            │        ─ notification outbox ─────────────────┼──▶ WhatsApp Cloud API
 └──────────────────────────┘            │        ─ retention, dead-man ping ────────────┼──▶ external heartbeat
                                          │ PostgreSQL 17 (internal network only)         │
                                          └───────────────────────────────────────────────┘
```

| Component | Path                                 | Responsibility                                                                                                                                                                                                                                                                                                  |
| --------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent     | `apps/agent`                         | CPU (`/proc/stat` deltas), RAM (`MemAvailable`), disk + inodes per mount, load, uptime, PostgreSQL (authenticated `SELECT 1`, latency, DB size, WAL size, connection utilization, archiver, replication lag), HTTP health checks, optional Docker and backup freshness. Push-only; compiles to a single binary. |
| API       | `apps/api`                           | Hono API: agent ingestion, dashboard/auth endpoints, WhatsApp delivery webhook, OpenAPI at `/api/v1/openapi.json`.                                                                                                                                                                                              |
| Worker    | `apps/worker`                        | Separate process: sustained-window rule evaluation, incident lifecycle, durable notification queue with retries, reminders, escalation, recovery, retention.                                                                                                                                                    |
| Dashboard | `apps/dashboard`                     | React + TypeScript SPA served as static files by the host's Nginx.                                                                                                                                                                                                                                              |
| Database  | `packages/database`                  | Drizzle schema, SQL migrations, default rules.                                                                                                                                                                                                                                                                  |
| Shared    | `packages/shared`, `packages/config` | Metric catalog, Zod payload/rule schemas, API types, JSON logger, type-safe env config.                                                                                                                                                                                                                         |

## Quick start (local development)

Requirements: Bun 1.3.14+, Docker.

```bash
bun install
cp .env.example .env            # then edit; for local dev set COOKIE_SECURE=false, TRUST_PROXY=false, PUBLIC_ORIGIN unset
docker compose up -d db         # monitoring PostgreSQL
docker compose run --rm migrate # schema + default alert rules
```

For a dev loop outside Docker, expose a local Postgres and point `DATABASE_URL` at it, then:

```bash
bun run db:migrate
printf '%s' 'a-long-dev-password' | DATABASE_URL=... bun run user:create --email you@example.com --role admin
DATABASE_URL=... bun run host:register --name dev-host     # prints an agent token once
bun run dev:api                 # http://127.0.0.1:3000
bun run dev:worker
bun run dev:dashboard           # http://127.0.0.1:5173 (proxies /api to :3000)
```

The agent reads Linux `/proc`, so run it on Linux (or in a Linux container):

```bash
MONITOR_URL=http://127.0.0.1:3000 AGENT_ALLOW_INSECURE_HTTP=true AGENT_TOKEN=ima_... bun run dev:agent
```

## Production

1. **Monitoring VM** – [docs/deployment-monitoring-vm.md](docs/deployment-monitoring-vm.md): Docker, firewall, `.env`, migrations, first admin, HTTPS through the server's existing Nginx.
2. **Production VMs** – [docs/agent-installation.md](docs/agent-installation.md): read-only PostgreSQL role, agent binary, hardened systemd unit.
3. **WhatsApp** – [docs/whatsapp-setup.md](docs/whatsapp-setup.md): template specification, credentials, webhook.
4. **Watching the watcher** – the monitoring VM cannot reliably report its own total outage. Configure `DEADMAN_PING_URL` and an external uptime check (see the deployment guide).

More: [configuration reference](docs/configuration.md) · [architecture & design decisions](docs/architecture.md) · [backup & restore](docs/backup-restore.md) · [testing & failure simulation](docs/testing.md) · [troubleshooting](docs/troubleshooting.md).

## Commands

| Command                 | What it does                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `bun run typecheck`     | `tsc --noEmit` (strict) for backend, agent, tests and dashboard                     |
| `bun run lint`          | Biome lint + format check                                                           |
| `bun run test`          | Unit tests; integration tests run when `TEST_DATABASE_URL` is set                   |
| `bun run build`         | Dashboard bundle + agent binaries (`dist/system-monitor-agent-linux-{x64,arm64}`)   |
| `bun run db:generate`   | Generate a new SQL migration after changing `packages/database/src/schema.ts`       |
| `bun run db:migrate`    | Apply migrations (as the schema owner) and seed default rules                       |
| `bun run user:create`   | Create/reset a dashboard user (password from stdin)                                 |
| `bun run host:register` | Register a host and print its agent token once                                      |
| `bun run simulate`      | Send synthetic metrics for a **test** host (high CPU, low disk, PostgreSQL down, …) |

Integration tests need a disposable database whose name contains `test`:

```bash
docker run -d --name im-testdb -e POSTGRES_USER=monitor_owner -e POSTGRES_PASSWORD=testpass \
  -e POSTGRES_DB=system_monitor_test -p 127.0.0.1:55439:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://monitor_owner:testpass@127.0.0.1:55439/system_monitor_test bun test
```

## Default alert rules

Seeded on first migration and editable in the dashboard (`PATCH /api/v1/alerts/rules/:id`).

| Rule                              | Warning                            | Critical                    |
| --------------------------------- | ---------------------------------- | --------------------------- |
| CPU usage                         | > 85 % for 5 min                   | > 95 % for 3 min            |
| Memory usage                      | > 85 % for 5 min                   | > 95 % for 3 min            |
| Disk usage (per mount)            | > 85 %                             | > 95 %                      |
| Inode usage (per mount)           | > 85 %                             | > 95 %                      |
| PostgreSQL health                 | 2 failed checks within the last 10 | 2 consecutive failed checks |
| API availability                  | 2 failed checks within the last 10 | 3 consecutive failed checks |
| Agent heartbeat                   | missing > 90 s                     | missing > 180 s             |
| PostgreSQL connection utilization | > 80 % for 1 min                   | > 95 % for 1 min            |

Critical incidents send a reminder every 30 min (15 min for PostgreSQL/API/heartbeat) until
acknowledged or resolved; a 5-minute cooldown suppresses re-paging for flapping conditions.

## Security summary

- Agents and users have separate credential types: per-agent bearer tokens (SHA-256 hashed at rest, revocable) vs. Argon2id passwords with HttpOnly, `SameSite=Strict`, `__Host-` session cookies and viewer/operator/admin roles.
- All input is Zod-validated; payloads are size-limited, freshness-checked (stale/replayed snapshots rejected) and idempotent per snapshot id; the host identity comes from the credential, never the payload.
- Rate limits on login, ingestion, webhooks and test messages; consistent JSON errors without stack traces; secrets redacted from logs.
- Monitoring PostgreSQL is on an internal Docker network; the runtime role has DML only and cannot alter the append-only `audit_logs`.
- The agent opens no ports, runs as an unprivileged systemd user with an empty capability set, uses a read-only `pg_monitor` role, and performs no remediation.
