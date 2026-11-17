#!/usr/bin/env bash
# One-time setup for an Oracle Cloud Ubuntu 24.04 (ARM64 or x86) instance.
# Run on the server:  sudo bash bootstrap-ubuntu.sh
# Safe to re-run: every step checks whether it is already done.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "run with sudo"; exit 1; fi
APP_USER="${SUDO_USER:-ubuntu}"

echo "== 1. firewall: allow 80/443 (Oracle image rejects everything except SSH) =="
RULES=/etc/iptables/rules.v4
for port in 80 443; do
  # live rule
  iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 1 -p tcp -m state --state NEW --dport "$port" -j ACCEPT
  # persistent rule: insert before Oracle's final REJECT line (edit the file instead of
  # `netfilter-persistent save`, so Docker's chains are never written into it)
  if [[ -f $RULES ]] && ! grep -q -- "--dport $port -j ACCEPT" "$RULES"; then
    sed -i "/-A INPUT -j REJECT/i -A INPUT -p tcp -m state --state NEW -m tcp --dport $port -j ACCEPT" "$RULES"
  fi
done

echo "== 2. Docker Engine + compose plugin (official repo) =="
if ! command -v docker >/dev/null; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
usermod -aG docker "$APP_USER"
systemctl enable --now docker

echo "== 3. Caddy (official repo) =="
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "== 4. 4 GB swap =="
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== 5. automatic security updates =="
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== 6. app folders =="
mkdir -p /srv/apps /srv/backups
chown "$APP_USER":"$APP_USER" /srv/apps /srv/backups

echo
echo "Done. Log out and back in so the docker group applies, then check:"
echo "  docker run --rm hello-world"
echo "  curl -I http://<public-ip>     (Caddy default page once the VCN security list allows port 80)"
