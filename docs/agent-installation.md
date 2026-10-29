# Agent installation (production Ubuntu VMs)

The agent is a single self-contained binary (Bun `--compile`), runs as the unprivileged
`system-monitor-agent` system user under a hardened systemd unit, **opens no listening sockets**, executes no
commands, and only:

- reads `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`, `/proc/uptime` (and `/proc/mounts` with `AGENT_MOUNTS=auto`),
- calls `statfs()` on configured mount points,
- runs read-only SQL as a `pg_monitor` role,
- makes HTTP GET requests to configured health endpoints,
- pushes JSON over HTTPS to the monitoring server.

It cannot delete WAL, change PostgreSQL configuration, restart services or remediate anything.

## 1. Build the binary (on any machine with Docker or Bun)

```bash
docker build --target agent-binaries --output type=local,dest=dist .
# or: bun run build:agent
ls dist/   # system-monitor-agent-linux-x64, system-monitor-agent-linux-arm64
```

## 2. Register the host (monitoring VM or dashboard)

```bash
docker compose run --rm api bun scripts/register-host.ts --name db-prod-1 --environment production
```

Copy the printed `ima_…` token; it is not stored in plaintext anywhere and cannot be shown again
(issue a new one with `POST /api/v1/hosts/:id/agents` and revoke the old one with
`POST /api/v1/agents/:id/revoke` to rotate).

## 3. Read-only PostgreSQL role (production database server)

```bash
sudo -u postgres psql -d appdb -f deploy/agent/postgres-monitoring-role.sql
# pg_hba.conf:  host  appdb  system_monitor  127.0.0.1/32  scram-sha-256
sudo systemctl reload postgresql
```

`pg_monitor` is needed for WAL size (`pg_ls_waldir()`) and full `pg_stat_activity`/replication
visibility. Without it those metrics are reported as _unavailable_, not as zero.

## 4. Install

```bash
scp dist/system-monitor-agent-linux-x64 deploy/agent/* prod-vm:/tmp/system-monitor-agent/
ssh prod-vm
cd /tmp/system-monitor-agent && sudo ./install.sh ./system-monitor-agent-linux-x64
sudoedit /etc/system-monitor-agent/agent.env       # MONITOR_URL, AGENT_MOUNTS, AGENT_PG_URL, AGENT_HTTP_CHECKS
sudo sh -c 'printf "%s" "ima_..." > /etc/system-monitor-agent/agent.token'   # 0600 root:root
sudo systemctl enable --now system-monitor-agent
journalctl -u system-monitor-agent -f              # JSON logs; "agent starting" then quiet unless problems
```

Within ~30 s the host shows as healthy in the dashboard with its agent version and last heartbeat.

### What to monitor

- `AGENT_MOUNTS`: `/` plus every filesystem holding PostgreSQL data (`SHOW data_directory`) and WAL
  (`pg_wal`, often a separate volume), backups and application data. Disk usage (filesystem) is
  reported separately from `pg.database_size_bytes` and `pg.wal_size_bytes` – they answer different
  questions.
- `AGENT_HTTP_CHECKS`: the application's real health endpoint, ideally one that checks its own
  dependencies.
- Backups: make your backup job `touch` a marker file only after a verified successful backup and
  set `AGENT_BACKUP_MARKERS`; add a `backup.age_seconds` rule (see configuration.md).

### Docker container status (optional)

The Docker socket is root-equivalent, so do not give it to the agent. Run a read-only socket proxy
that allows only `GET /containers/json`, e.g. `tecnativa/docker-socket-proxy` with `CONTAINERS=1`
and everything else disabled, exposed as a unix socket readable by `system-monitor-agent`, and set
`AGENT_DOCKER_SOCKET` to that path.

## Network requirements

Outbound TCP 443 from the production VM to the monitoring VM only. No inbound rules are needed for
the agent.

## Upgrading / removing

```bash
sudo install -m 0755 system-monitor-agent-linux-x64 /usr/local/bin/system-monitor-agent && sudo systemctl restart system-monitor-agent
sudo systemctl disable --now system-monitor-agent && sudo rm -rf /etc/system-monitor-agent /usr/local/bin/system-monitor-agent /etc/systemd/system/system-monitor-agent.service
```
