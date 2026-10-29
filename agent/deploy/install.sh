#!/usr/bin/env bash
# Installs the system-monitor-agent binary and systemd unit on an Ubuntu production VM.
# Usage: sudo ./install.sh ./system-monitor-agent-linux-x64
# Idempotent; never overwrites an existing agent.env or agent.token.
set -euo pipefail

BIN_SRC="${1:?usage: sudo $0 <path-to-system-monitor-agent-binary>}"
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"

id system-monitor-agent >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent \
  --shell /usr/sbin/nologin system-monitor-agent

install -o root -g root -m 0755 "$BIN_SRC" /usr/local/bin/system-monitor-agent
install -d -o root -g system-monitor-agent -m 0750 /etc/system-monitor-agent

if [[ ! -f /etc/system-monitor-agent/agent.env ]]; then
  install -o root -g system-monitor-agent -m 0640 "$HERE/agent.env.example" /etc/system-monitor-agent/agent.env
  echo "created /etc/system-monitor-agent/agent.env – edit it before starting the agent"
fi
if [[ ! -f /etc/system-monitor-agent/agent.token ]]; then
  install -o root -g root -m 0600 /dev/null /etc/system-monitor-agent/agent.token
  echo "created empty /etc/system-monitor-agent/agent.token – paste the token from host registration"
fi

install -o root -g root -m 0644 "$HERE/system-monitor-agent.service" /etc/systemd/system/system-monitor-agent.service
systemctl daemon-reload
echo "Next: edit agent.env and agent.token, then: systemctl enable --now system-monitor-agent"
