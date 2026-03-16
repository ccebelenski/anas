#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

echo "=== ANAS Stunt Node — Provision PVE 9 ==="
echo

# Wait for SSH
echo "Waiting for SSH..."
for i in $(seq 1 60); do
  if $SSH_CMD true &>/dev/null; then
    echo "✓ SSH available"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "ERROR: SSH not available after 60 attempts"
    exit 1
  fi
  sleep 5
done
echo

# --- Network handoff: cloud-init/netplan → ifupdown2 ---
# The cloud image uses netplan + systemd-networkd. PVE uses ifupdown2.
# We must install ifupdown2 and write /etc/network/interfaces BEFORE
# removing cloud-init, because purging netplan cascades and removes
# iproute2, which bricks the network.
echo "Installing ifupdown2 (PVE network manager)..."
$SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get install -y ifupdown2"
echo "✓ ifupdown2 installed"
echo

echo "Writing static network config..."
$SSH_CMD "cat > /etc/network/interfaces" <<'EOF'
auto lo
iface lo inet loopback

auto enp1s0
iface enp1s0 inet static
    address 192.168.200.50/24
    gateway 192.168.200.1
EOF
echo "✓ Network config written"
echo

echo "Configuring DNS..."
$SSH_CMD "mkdir -p /etc/systemd/resolved.conf.d"
$SSH_CMD "cat > /etc/systemd/resolved.conf.d/dns.conf" <<'EOF'
[Resolve]
DNS=192.168.200.1
EOF
$SSH_CMD "systemctl restart systemd-resolved"
echo "✓ DNS configured"
echo

# Now safe to remove cloud-init and netplan
echo "Removing cloud-init and netplan..."
$SSH_CMD "rm -f /etc/netplan/*.yaml"
$SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get remove -y --purge cloud-init cloud-initramfs-growroot netplan.io python3-netplan netplan-generator 2>/dev/null; apt-get autoremove -y" >/dev/null 2>&1
$SSH_CMD "systemctl disable --now systemd-networkd 2>/dev/null || true"
echo "✓ cloud-init and netplan removed"
echo

# Set hostname + /etc/hosts (PVE requires hostname to resolve to non-loopback IP)
echo "Setting hostname..."
$SSH_CMD "hostnamectl set-hostname anas-pve"
$SSH_CMD "sed -i '/127.0.1.1/d' /etc/hosts"
$SSH_CMD "grep -q '${VM_IP}' /etc/hosts || echo '${VM_IP} anas-pve.local anas-pve' >> /etc/hosts"
echo "✓ Hostname set"
echo

# Add Proxmox VE 9 repository (deb822 format)
echo "Adding Proxmox repository..."
$SSH_CMD "wget -qO /usr/share/keyrings/proxmox-archive-keyring.gpg https://enterprise.proxmox.com/debian/proxmox-archive-keyring-trixie.gpg"
$SSH_CMD "cat > /etc/apt/sources.list.d/pve-install-repo.sources" <<'EOF'
Types: deb
URIs: http://download.proxmox.com/debian/pve
Suites: trixie
Components: pve-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
EOF
$SSH_CMD "apt-get update"
echo "✓ Proxmox repo added"
echo

# Full upgrade before PVE install
echo "Running full upgrade..."
$SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get -y full-upgrade"
echo "✓ System upgraded"
echo

# Pre-configure grub-pc install device (cloud images don't set this,
# so grub-pc's postinst can't find its target and fails)
echo "Configuring grub install device..."
$SSH_CMD "echo 'grub-pc grub-pc/install_devices string /dev/sda' | debconf-set-selections"

# Install PVE kernel first (PVE 9 requires reboot into PVE kernel before proxmox-ve)
echo "Installing Proxmox kernel..."
$SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get install -y proxmox-default-kernel"
echo "✓ PVE kernel installed"
echo

# Configure serial console for grub before reboot
echo "Configuring serial console..."
$SSH_CMD "sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT=\"quiet console=ttyS0,115200n8\"/' /etc/default/grub"
$SSH_CMD "grep -q '^GRUB_TERMINAL=' /etc/default/grub && sed -i 's/^GRUB_TERMINAL=.*/GRUB_TERMINAL=\"serial console\"/' /etc/default/grub || echo 'GRUB_TERMINAL=\"serial console\"' >> /etc/default/grub"
$SSH_CMD "grep -q '^GRUB_SERIAL_COMMAND=' /etc/default/grub || echo 'GRUB_SERIAL_COMMAND=\"serial --speed=115200 --unit=0 --word=8 --parity=no --stop=1\"' >> /etc/default/grub"
$SSH_CMD "update-grub"
echo "✓ Serial console configured"
echo

# Reboot into PVE kernel
echo "Rebooting into PVE kernel..."
$SSH_CMD "reboot" || true
echo "Waiting for reboot..."
sleep 30

for i in $(seq 1 90); do
  if $SSH_CMD true &>/dev/null; then
    echo "✓ VM back online (PVE kernel)"
    break
  fi
  if [ "$i" -eq 90 ]; then
    echo "ERROR: VM did not come back after reboot (waited 7.5 min)"
    echo "Check console: sudo virsh console ${VM_NAME}"
    exit 1
  fi
  sleep 5
done
echo

# Install proxmox-ve meta-package
echo "Installing proxmox-ve (this takes a while)..."
$SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get install -y proxmox-ve postfix open-iscsi chrony"
echo "✓ Proxmox VE installed"
echo

# Disable the enterprise repo (PVE creates it; it 401s without a subscription
# and causes nodesource and other apt operations to error out)
echo "Disabling enterprise repository..."
$SSH_CMD "cat > /etc/apt/sources.list.d/pve-enterprise.sources" <<'EOF'
# Disabled — using pve-no-subscription instead
# Types: deb
# URIs: https://enterprise.proxmox.com/debian/pve
# Suites: trixie
# Components: pve-enterprise
# Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
EOF
echo "✓ Enterprise repo disabled"
echo

# Remove stock Debian kernel (cloud images use linux-image-cloud-amd64)
echo "Removing stock Debian kernel..."
$SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get remove -y linux-image-amd64 linux-image-cloud-amd64 || true"
$SSH_CMD "dpkg -l 'linux-image-6.12*' 2>/dev/null | grep '^ii' | awk '{print \$2}' | xargs -r apt-get remove -y || true"
$SSH_CMD "update-grub"
echo "✓ Stock kernel removed"
echo

# Remove os-prober (PVE recommendation)
$SSH_CMD "apt-get remove -y os-prober || true" >/dev/null 2>&1

# Install additional packages
echo "Installing additional packages..."
$SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get install -y samba nfs-kernel-server smartmontools"
echo "✓ Additional packages installed"
echo

# Install Node.js 22 via nodesource
echo "Installing Node.js 22..."
$SSH_CMD "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -"
$SSH_CMD "apt-get install -y nodejs"
NODE_VER=$($SSH_CMD "node --version")
echo "✓ Node.js ${NODE_VER} installed"
echo

# Reconfigure network with vmbr0 bridge (PVE needs this for VM networking)
echo "Configuring vmbr0 bridge..."
$SSH_CMD "cat > /etc/network/interfaces" <<'EOF'
auto lo
iface lo inet loopback

auto enp1s0
iface enp1s0 inet manual

auto vmbr0
iface vmbr0 inet static
    address 192.168.200.50/24
    gateway 192.168.200.1
    bridge-ports enp1s0
    bridge-stp off
    bridge-fd 0
EOF
echo "✓ Bridge configured"
echo

# Final reboot to pick up bridge config
echo "Final reboot..."
$SSH_CMD "reboot" || true
echo "Waiting for reboot..."
sleep 30

for i in $(seq 1 90); do
  if $SSH_CMD true &>/dev/null; then
    echo "✓ VM back online"
    break
  fi
  if [ "$i" -eq 90 ]; then
    echo "ERROR: VM did not come back after final reboot (waited 7.5 min)"
    echo "Check console: sudo virsh console ${VM_NAME}"
    exit 1
  fi
  sleep 5
done
echo

# Detach cloud-init ISO (no longer needed)
sudo virsh change-media "$VM_NAME" sda --eject 2>/dev/null || true

# Verify
echo "Verifying installation..."
echo -n "  PVE version: "
$SSH_CMD "pveversion"
echo -n "  ZFS: "
$SSH_CMD "zfs version 2>/dev/null || echo 'not available'"
echo -n "  Node.js: "
$SSH_CMD "node --version"
echo -n "  Auth key: "
$SSH_CMD "test -f /etc/pve/authkey.pub && echo 'present' || echo 'MISSING'"
echo -n "  Web UI: "
$SSH_CMD "curl -sk -o /dev/null -w '%{http_code}' https://localhost:8006/ || echo 'unreachable'"
echo
echo -n "  DNS: "
$SSH_CMD "host -t A deb.debian.org >/dev/null 2>&1 && echo 'working' || echo 'BROKEN'"
echo -n "  Bridge: "
$SSH_CMD "ip -br addr show vmbr0"
echo

# Stop VM for bare snapshot
echo "Stopping VM for bare snapshot..."
"${SCRIPT_DIR}/stop.sh"
echo

# Take bare snapshot
echo "Taking 'bare' snapshot..."
sudo virsh snapshot-create-as "$VM_NAME" bare "Debian 13 + PVE 9 + deps, no ANAS"
echo "✓ 'bare' snapshot created"
echo

echo "=== Provisioning complete ==="
echo
echo "Next steps:"
echo "  1. Start the VM: ./start.sh"
echo "  2. Deploy ANAS: ./deploy-anas.sh"
