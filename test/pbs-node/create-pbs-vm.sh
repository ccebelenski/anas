#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

CLOUD_IMAGE_URL="https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2"
CLOUD_IMAGE_CACHE="${STORAGE_PATH}/debian-13-genericcloud-amd64.qcow2"
SYSTEM_DISK="${STORAGE_PATH}/${VM_NAME}-system.qcow2"
STORE_DISK="${STORAGE_PATH}/${VM_NAME}-store.qcow2"
CLOUD_INIT_ISO="${STORAGE_PATH}/${VM_NAME}-cloud-init.iso"

echo "=== ANAS PBS Node — Create VM ==="
echo

# Prerequisites
for cmd in virsh qemu-img virt-install genisoimage; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd not found. Run ../stunt-node/setup-host.sh first."
    exit 1
  fi
done

NET_ACTIVE=$(sudo virsh net-info "$VM_NETWORK" 2>/dev/null | grep "Active:" | awk '{print $2}') || true
if [ "$NET_ACTIVE" != "yes" ]; then
  if sudo virsh net-info "$VM_NETWORK" &>/dev/null; then
    echo "Starting $VM_NETWORK network..."
    sudo virsh net-start "$VM_NETWORK"
  else
    echo "ERROR: $VM_NETWORK network not found. Run ../stunt-node/setup-host.sh first."
    exit 1
  fi
fi

if sudo virsh dominfo "$VM_NAME" &>/dev/null; then
  echo "ERROR: VM '$VM_NAME' already exists. Run ./destroy-vm.sh first."
  exit 1
fi

# Download cloud image (cached — shared with the stunt node)
if [ -f "$CLOUD_IMAGE_CACHE" ]; then
  echo "✓ Cloud image cached: ${CLOUD_IMAGE_CACHE}"
else
  echo "Downloading Debian 13 cloud image..."
  curl -fL -o "$CLOUD_IMAGE_CACHE" "$CLOUD_IMAGE_URL"
  echo "✓ Cloud image downloaded"
fi
echo

# System disk from the cloud image
echo "Creating system disk (${SYSTEM_DISK_SIZE})..."
cp "$CLOUD_IMAGE_CACHE" "$SYSTEM_DISK"
qemu-img resize "$SYSTEM_DISK" "$SYSTEM_DISK_SIZE"
echo "✓ System disk created"

# Datastore disk — blank; provision-pbs.sh formats it and puts the datastore on it
echo "Creating datastore disk (${STORE_DISK_SIZE}, serial ${STORE_SERIAL})..."
qemu-img create -f qcow2 "$STORE_DISK" "$STORE_DISK_SIZE" >/dev/null
chmod 666 "$STORE_DISK"
echo "✓ Datastore disk created"
echo

# Build cloud-init ISO
echo "Building cloud-init configuration..."
CLOUD_INIT_DIR=$(mktemp -d)
trap 'rm -rf "$CLOUD_INIT_DIR"' EXIT

SSH_PUB_KEY="$(cat ~/.ssh/id_*.pub | head -1)"

cat > "${CLOUD_INIT_DIR}/meta-data" <<EOF
instance-id: ${VM_NAME}
local-hostname: ${VM_HOSTNAME}
EOF

cat > "${CLOUD_INIT_DIR}/user-data" <<EOF
#cloud-config
ssh_pwauth: true
disable_root: false
chpasswd:
  list: |
    root:${VM_PASS}
  expire: false
ssh_authorized_keys:
  - ${SSH_PUB_KEY}
packages:
  - qemu-guest-agent
runcmd:
  - systemctl enable --now qemu-guest-agent
EOF

cat > "${CLOUD_INIT_DIR}/network-config" <<EOF
network:
  version: 2
  ethernets:
    enp1s0:
      addresses:
        - ${VM_IP}/24
      routes:
        - to: default
          via: ${VM_GATEWAY}
      nameservers:
        addresses:
          - ${VM_GATEWAY}
EOF

genisoimage -output "$CLOUD_INIT_ISO" \
  -volid cidata -joliet -rock \
  "${CLOUD_INIT_DIR}/meta-data" \
  "${CLOUD_INIT_DIR}/user-data" \
  "${CLOUD_INIT_DIR}/network-config" \
  2>/dev/null
echo "✓ Cloud-init ISO created"
echo

echo "Creating VM..."
sudo virt-install \
  --name "$VM_NAME" \
  --vcpus "$VM_VCPUS" \
  --memory "$VM_RAM" \
  --machine q35 \
  --os-variant debian12 \
  --network "network=${VM_NETWORK},mac=${VM_MAC}" \
  --graphics none \
  --console pty,target_type=serial \
  --import \
  --disk "path=${SYSTEM_DISK},format=qcow2,bus=scsi" \
  --disk "path=${STORE_DISK},format=qcow2,bus=scsi,serial=${STORE_SERIAL}" \
  --disk "path=${CLOUD_INIT_ISO},device=cdrom" \
  --controller type=scsi,model=virtio-scsi \
  --channel unix,target_type=virtio,name=org.qemu.guest_agent.0 \
  --noautoconsole \
  --wait 0

echo "✓ VM created and booting"
echo
echo "Waiting for cloud-init to complete..."

for i in $(seq 1 60); do
  if $SSH_CMD true &>/dev/null; then
    echo "✓ SSH available"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "ERROR: SSH not available after 5 minutes"
    exit 1
  fi
  sleep 5
done

$SSH_CMD "cloud-init status --wait" 2>/dev/null || true
echo "✓ Cloud-init complete"
echo

# --- Network handoff: cloud-init/netplan → ifupdown2 -------------------------
# Same ordering the stunt node learned the hard way (test/stunt-node/provision.sh):
# install ifupdown2 and write /etc/network/interfaces BEFORE removing cloud-init,
# because purging netplan cascades and removes iproute2, which bricks the network.
# PBS itself does not require ifupdown2, but the two test VMs are kept identical:
# one network model, one failure mode to debug.
echo "Installing ifupdown2..."
$SSH_CMD "apt-get update -qq"
$SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get install -y ifupdown2"
echo "✓ ifupdown2 installed"
echo

echo "Writing static network config..."
$SSH_CMD "cat > /etc/network/interfaces" <<EOF
auto lo
iface lo inet loopback

auto enp1s0
iface enp1s0 inet static
    address ${VM_IP}/24
    gateway ${VM_GATEWAY}
EOF
echo "✓ Network config written"
echo

echo "Configuring DNS..."
$SSH_CMD "mkdir -p /etc/systemd/resolved.conf.d"
$SSH_CMD "cat > /etc/systemd/resolved.conf.d/dns.conf" <<EOF
[Resolve]
DNS=${VM_GATEWAY}
EOF
$SSH_CMD "systemctl restart systemd-resolved"
echo "✓ DNS configured"
echo

# Now — and only now — safe to remove cloud-init and netplan
echo "Removing cloud-init and netplan..."
$SSH_CMD "rm -f /etc/netplan/*.yaml"
$SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get remove -y --purge cloud-init cloud-initramfs-growroot netplan.io python3-netplan netplan-generator 2>/dev/null; apt-get autoremove -y" >/dev/null 2>&1
$SSH_CMD "systemctl disable --now systemd-networkd 2>/dev/null || true"
echo "✓ cloud-init and netplan removed"
echo

# Hostname must resolve to the non-loopback IP (PBS certificates + the UI use it)
echo "Setting hostname..."
$SSH_CMD "hostnamectl set-hostname ${VM_HOSTNAME}"
$SSH_CMD "sed -i '/127.0.1.1/d' /etc/hosts"
$SSH_CMD "grep -q '${VM_IP}' /etc/hosts || echo '${VM_IP} ${VM_HOSTNAME}.local ${VM_HOSTNAME}' >> /etc/hosts"
echo "✓ Hostname set"
echo

# Reboot once on the ifupdown2 config, so a broken handoff fails HERE and not
# halfway through provisioning.
echo "Rebooting onto ifupdown2..."
$SSH_CMD "reboot" || true
sleep 20
for i in $(seq 1 60); do
  if $SSH_CMD true &>/dev/null; then
    echo "✓ VM back online"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "ERROR: VM did not come back after reboot (waited 5 min)"
    echo "Check console: sudo virsh console ${VM_NAME}"
    exit 1
  fi
  sleep 5
done
echo

# Eject the cloud-init ISO (find the cdrom device by its source file)
CDROM_DEV=$(sudo virsh domblklist "$VM_NAME" | awk -v iso="$CLOUD_INIT_ISO" '$2 == iso {print $1}')
if [ -n "$CDROM_DEV" ]; then
  sudo virsh change-media "$VM_NAME" "$CDROM_DEV" --eject --config 2>/dev/null || true
fi

echo -n "  Network: "
$SSH_CMD "ip -br addr show enp1s0"
echo -n "  DNS: "
$SSH_CMD "getent hosts deb.debian.org >/dev/null 2>&1 && echo 'working' || echo 'BROKEN'"
echo -n "  Datastore disk: "
$SSH_CMD "lsblk -dno NAME,SIZE /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_${STORE_SERIAL}"
echo

echo "=== VM created successfully ==="
echo "  SSH: ssh root@${VM_IP}"
echo
echo "Next step: Run ./provision-pbs.sh to install Proxmox Backup Server"
