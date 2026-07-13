#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

echo "=== ANAS Stunt Node — Deploy ANAS ==="
echo

# Build on host
echo "Building ANAS on host..."
cd "$PROJECT_ROOT"
npm run build
echo "✓ Build complete"
echo

# rsync to VM
echo "Syncing to VM..."
rsync -az --delete \
  --exclude '.git' \
  --exclude '.nuxt' \
  --exclude 'test' \
  --exclude 'tests' \
  --exclude 'test-results' \
  --exclude 'playwright-report' \
  -e "ssh ${SSH_OPTS}" \
  "${PROJECT_ROOT}/" \
  "${VM_USER}@${VM_IP}:/opt/anas/"
echo "✓ Files synced"
echo

# Install systemd units
echo "Installing systemd units..."
$SSH_CMD "cat > /etc/systemd/system/anasd.service" <<'EOF'
[Unit]
Description=ANAS Daemon
After=network.target pve-cluster.service

[Service]
Type=simple
ExecStartPre=/bin/mkdir -p /run/anas
ExecStart=/usr/bin/node /opt/anas/packages/daemon/dist/index.js
Environment=ANASD_SOCKET=/run/anas/anasd.sock
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

$SSH_CMD "cat > /etc/systemd/system/anas.service" <<'EOF'
[Unit]
Description=ANAS API Gateway
After=anasd.service
Requires=anasd.service

[Service]
Type=simple
# The gateway reads the host's PVE certificates itself (story 13.8): it
# auto-detects /etc/pve/local/pveproxy-ssl.* (custom) or pve-ssl.* (node) and
# serves HTTPS. PVE marks PVEAuthCookie as Secure, so this HTTPS is required
# for auth to work at all (story 10.4).
ExecStart=/usr/bin/node /opt/anas/packages/gateway/dist/index.js
Environment=ANASD_SOCKET=/run/anas/anasd.sock
Environment=ANAS_AUTH_PROVIDER=pve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

$SSH_CMD "systemctl daemon-reload"
$SSH_CMD "systemctl enable anasd anas"
echo "✓ Systemd units installed"
echo

# Start services
echo "Starting services..."
$SSH_CMD "systemctl restart anasd anas"
sleep 3
echo

# Verify
echo "Verifying..."
if $SSH_CMD "systemctl is-active --quiet anasd"; then
  echo "  ✓ anasd running"
else
  echo "  ✗ anasd not running"
  $SSH_CMD "journalctl -u anasd -n 20 --no-pager"
  exit 1
fi

if $SSH_CMD "systemctl is-active --quiet anas"; then
  echo "  ✓ anas running"
else
  echo "  ✗ anas not running"
  $SSH_CMD "journalctl -u anas -n 20 --no-pager"
  exit 1
fi

echo

# Install PVE UI integration
# The rsync above already placed packages/pve-integration/ under /opt/anas/, so
# install.sh runs from its final location (the apt hook references that path).
# Idempotent: re-running on every deploy is safe.
echo "Installing PVE UI integration..."
$SSH_CMD "chmod +x /opt/anas/packages/pve-integration/install.sh /opt/anas/packages/pve-integration/uninstall.sh && /opt/anas/packages/pve-integration/install.sh"
echo "✓ PVE UI integration installed"
echo

echo "=== Deploy complete ==="
echo "ANAS available at https://${VM_IP}:3000"
