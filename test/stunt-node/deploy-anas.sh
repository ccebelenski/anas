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

# Preflight: daemon runtime dependencies
# The daemon shells out to host tools that PVE does not install by default.
# Production packaging (a future .deb) should declare `Depends: acl` so this is
# not deploy-script-only; until then we provision/check them here.
echo "Checking daemon dependencies..."
# acl (getfacl/setfacl) is REQUIRED for named-principal POSIX ACL grants — the
# "Add user or group" permission editor fails at job time without it. It is a
# tiny standard package, so ensure it is present (idempotent).
if $SSH_CMD "command -v setfacl >/dev/null 2>&1"; then
  echo "  ✓ acl (setfacl) present"
else
  echo "  acl not found — installing..."
  $SSH_CMD "apt-get install -y acl"
  echo "  ✓ acl installed"
fi
# mdadm + btrfs-progs are REQUIRED for AHR (hybrid RAID) pools — PVE 9 ships
# neither (AHR ground truth GT-1). Standard Debian packages; auto-install
# (noninteractive: mdadm's postinst debconf-prompts about boot arrays).
if $SSH_CMD "command -v mdadm >/dev/null 2>&1"; then
  echo "  ✓ mdadm present"
else
  echo "  mdadm not found — installing..."
  $SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get install -y mdadm"
  echo "  ✓ mdadm installed"
fi
if $SSH_CMD "command -v mkfs.btrfs >/dev/null 2>&1"; then
  echo "  ✓ btrfs-progs (mkfs.btrfs) present"
else
  echo "  btrfs-progs not found — installing..."
  $SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get install -y btrfs-progs"
  echo "  ✓ btrfs-progs installed"
fi
# AHR md-event hook: the mdadm --monitor PROGRAM target. The rsync above
# already placed packaging/ under /opt/anas/, so install from its synced copy
# (same pattern as the pve-integration scripts). Idempotent on every deploy.
$SSH_CMD "install -m 0755 /opt/anas/packaging/anas-md-event.sh /usr/local/bin/anas-md-event && install -d /usr/share/pve-manager/templates/default && install -m 0644 /opt/anas/packaging/templates/anas-ahr-*.hbs /usr/share/pve-manager/templates/default/"
echo "  ✓ anas-md-event hook installed (/usr/local/bin/anas-md-event)"
# smbd (samba) and exportfs (nfs-kernel-server) are per-protocol and the
# operator chooses which to run, so warn but never auto-install or fail.
if $SSH_CMD "command -v smbd >/dev/null 2>&1"; then
  echo "  ✓ smbd (samba) present"
else
  echo "  ⚠ smbd not found — SMB shares will not work until samba is installed."
fi
if $SSH_CMD "command -v exportfs >/dev/null 2>&1"; then
  echo "  ✓ exportfs (nfs-kernel-server) present"
else
  echo "  ⚠ exportfs not found — NFS shares will not work until nfs-kernel-server is installed."
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
