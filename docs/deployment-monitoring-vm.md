# Monitoring VM deployment (Ubuntu 24.04 LTS)

Use a VM that shares **no failure domain** with production where possible: different host,
ideally a different provider region or account. 2 vCPU / 4 GB RAM / 40 GB SSD is plenty for dozens
of hosts.

## 1. Base system

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install ca-certificates curl git ufw unattended-upgrades chrony
sudo timedatectl set-ntp true            # payload freshness checks rely on correct clocks

# Docker Engine + compose plugin (official repository)
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update && sudo apt -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

## 2. Firewall – only SSH and HTTPS

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH            # better: sudo ufw allow from <admin-ip> to any port 22
sudo ufw allow 'Nginx Full'       # 80 (certbot + redirect) and 443; already open if Nginx serves other sites
sudo ufw enable
```

PostgreSQL is never published (internal Docker network) and the API is published on `127.0.0.1`
only. Note that Docker-published ports bypass ufw – this stack publishes nothing except
`127.0.0.1:3000`; ports 80/443 belong to the host's Nginx.

## 3. Configure

```bash
sudo mkdir -p /opt/system-monitor && sudo chown "$USER" /opt/system-monitor
git clone <your-repo> /opt/system-monitor && cd /opt/system-monitor/backend
cp .env.example .env && chmod 600 .env
sed -i "s/CHANGE_ME_owner_password_hex/$(openssl rand -hex 32)/; s/CHANGE_ME_app_password_hex/$(openssl rand -hex 32)/; s/CHANGE_ME_random_string/$(openssl rand -hex 24)/" .env
$EDITOR .env    # PUBLIC_ORIGIN, WhatsApp settings, ALERT_TIMEZONE, DEADMAN_PING_URL
```

## 4. Build, migrate, start

All `docker compose` commands in this guide run in `/opt/system-monitor/backend`.

```bash
docker compose build
docker compose up -d db
docker compose run --rm migrate                 # controlled step; safe to re-run
docker compose up -d api worker
docker compose ps                               # all services "healthy"
curl -fsS http://127.0.0.1:3000/ready           # then set up Nginx (section 6)
```

Upgrades: `git pull && docker compose build && docker compose run --rm migrate && docker compose up -d`,
then re-export the dashboard files (section 6, step 2).
Migrations run as the schema owner; API and worker use the DML-only `monitor_app` role.

## 5. First admin user and hosts

```bash
read -rsp 'Admin password (12+ chars): ' PW; echo
printf '%s' "$PW" | docker compose run --rm -T api bun scripts/create-user.ts --email ops@example.com --role admin --name "Ops"
unset PW

docker compose run --rm api bun scripts/register-host.ts --name db-prod-1 --display-name "DB primary" --environment production
```

`register-host` prints the agent token **once**. Hosts can also be added from the dashboard
(admin → Add host). Then install the agent: [agent-installation.md](agent-installation.md).

Roles: `viewer` (read-only), `operator` (+ acknowledge incidents), `admin` (+ rules, hosts, agent
tokens, test messages).

## 6. HTTPS through the existing Nginx

The stack ships no web server of its own: the Nginx already on this VM terminates HTTPS, serves the
dashboard files and proxies `/api/*`, `/health` and `/ready` to the API on `127.0.0.1:3000`. The site
config only matches its own `server_name`, so other sites on the same Nginx are unaffected.

```bash
DOMAIN=monitor.example.com

# 1. Site config with your domain
sudo sed "s/monitor\.example\.com/$DOMAIN/g" deploy/nginx/system-monitor.conf \
  | sudo tee /etc/nginx/sites-available/system-monitor.conf >/dev/null

# 2. Dashboard static files (built inside Docker; no Bun or Node needed on the host)
sudo docker build --output type=local,dest=/var/www/system-monitor ../frontend

# 3. Certificate (skip if you already have one for $DOMAIN; then fix the ssl_certificate paths)
sudo certbot certonly --nginx -d "$DOMAIN" --deploy-hook "systemctl reload nginx"

# 4. Enable
sudo ln -s ../sites-available/system-monitor.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
curl -fsS "https://$DOMAIN/ready"
```

In `.env` set `TRUST_PROXY=true` and `PUBLIC_ORIGIN=https://$DOMAIN`, then
`docker compose up -d api`. If port 3000 is taken on this VM, set `API_PUBLISH_PORT` and change
`proxy_pass` to match.

**Private network / internal CA:** point `ssl_certificate` at a certificate from your internal CA and
set `AGENT_CA_FILE` on the agents. Never disable TLS verification.

## 7. Monitoring the monitor

The monitoring VM cannot reliably alert about its own total outage. Configure both:

1. **Dead man's switch** – create a check at healthchecks.io (or Better Stack / Cronitor), period
   1 min, grace 5 min, and set `DEADMAN_PING_URL`. The worker pings only after successful evaluation
   cycles, so a stuck worker, dead database or dead VM all stop the pings.
2. **External uptime check** of `https://monitor.example.com/health` (and `/ready`) from a
   third-party service, alerting via a channel independent of this system (e-mail/SMS/its own app).

Also consider a second, minimal agent heartbeat rule on another monitoring stack if you run one.

## 8. Logs and operations

```bash
docker compose logs -f --since 10m api worker     # structured JSON
docker compose logs worker | jq 'select(.level=="error")'
docker compose restart worker
```

Container logs are rotated (20 MB × 5). Backups: [backup-restore.md](backup-restore.md).
