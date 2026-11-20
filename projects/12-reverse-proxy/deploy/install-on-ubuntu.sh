#!/usr/bin/env bash
# Installs the reverse proxy as a systemd service from an unpacked, BUILT project folder.
# Nothing is started or enabled: you decide that afterwards.
#
#   sudo bash deploy/install-on-ubuntu.sh /home/ubuntu/h11/projects/12-reverse-proxy
#
# Needs Node.js at /opt/node (see deployment/07-reverse-proxy-on-a2.md). Safe to run again: it replaces the
# program files and units but never overwrites an existing /etc/reverse-proxy.env.
set -euo pipefail

SRC="${1:?give the path of the project folder (the one that contains dist/ and deploy/)}"
[ -f "$SRC/dist/index.js" ] || { echo "dist/ is missing: run 'npx tsc -p tsconfig.build.json' in $SRC first"; exit 1; }
[ -x /opt/node/bin/node ] || { echo "/opt/node/bin/node is missing: install Node.js first"; exit 1; }

# a system user that cannot log in and owns nothing
id reverse-proxy >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin reverse-proxy

# the program: root-owned, read-only for the service user
install -d -m 755 /opt/reverse-proxy
rm -rf /opt/reverse-proxy/dist
cp -r "$SRC/dist" /opt/reverse-proxy/dist
chown -R root:root /opt/reverse-proxy

# settings (kept if it already exists, so your edits survive an upgrade)
[ -f /etc/reverse-proxy.env ] || install -m 644 "$SRC/deploy/reverse-proxy.env.example" /etc/reverse-proxy.env
install -m 644 "$SRC/deploy/reverse-proxy.service" /etc/systemd/system/reverse-proxy.service

# a tiny test server, only so the service can be tried out before a real application is behind it
install -d -m 755 /opt/reverse-proxy-demo
install -m 644 "$SRC/bench/upstream.mjs" /opt/reverse-proxy-demo/upstream.mjs
install -m 644 "$SRC/deploy/demo-upstream.service" /etc/systemd/system/demo-upstream.service

systemctl daemon-reload
echo "installed. Try it:  sudo systemctl start demo-upstream reverse-proxy"
echo "remove it again:    sudo systemctl disable --now reverse-proxy demo-upstream; sudo rm -rf /opt/reverse-proxy /opt/reverse-proxy-demo /etc/reverse-proxy.env /etc/systemd/system/reverse-proxy.service /etc/systemd/system/demo-upstream.service; sudo userdel reverse-proxy; sudo systemctl daemon-reload"
