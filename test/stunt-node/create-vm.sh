#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

CLOUD_IMAGE_URL="https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2"
CLOUD_IMAGE_CACHE="${STORAGE_PATH}/debian-13-genericcloud-amd64.qcow2"
SYSTEM_DISK="${STORAGE_PATH}/${VM_NAME}-system.qcow2"
CLOUD_INIT_ISO="${STORAGE_PATH}/${VM_NAME}-cloud-init.iso"

echo "=== ANAS Stunt Node — Create VM ==="
echo

# Prerequisites
for cmd in virsh qemu-img virt-install genisoimage; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd not found. Run ./setup-host.sh first."
    exit 1
  fi
done

NET_ACTIVE=$(sudo virsh net-info "$VM_NETWORK" 2>/dev/null | grep "Active:" | awk '{print $2}') || true
if [ "$NET_ACTIVE" != "yes" ]; then
  if sudo virsh net-info "$VM_NETWORK" &>/dev/null; then
    echo "Starting $VM_NETWORK network..."
    sudo virsh net-start "$VM_NETWORK"
  else
    echo "ERROR: $VM_NETWORK network not found. Run ./setup-host.sh first."
    exit 1
  fi
fi

# Check if VM already exists
if sudo virsh dominfo "$VM_NAME" &>/dev/null; then
  echo "ERROR: VM '$VM_NAME' already exists. Run ./destroy-vm.sh first."
  exit 1
fi

# Download cloud image (cached)
if [ -f "$CLOUD_IMAGE_CACHE" ]; then
  echo "✓ Cloud image cached: ${CLOUD_IMAGE_CACHE}"
else
  echo "Downloading Debian 13 cloud image..."
  curl -fL -o "$CLOUD_IMAGE_CACHE" "$CLOUD_IMAGE_URL"
  echo "✓ Cloud image downloaded"
fi
echo

# Create system disk from cloud image
echo "Creating system disk (32G)..."
cp "$CLOUD_IMAGE_CACHE" "$SYSTEM_DISK"
qemu-img resize "$SYSTEM_DISK" 32G
echo "✓ System disk created"
echo

# Build cloud-init ISO
echo "Building cloud-init configuration..."
CLOUD_INIT_DIR=$(mktemp -d)
trap "rm -rf $CLOUD_INIT_DIR" EXIT

SSH_PUB_KEY="$(cat ~/.ssh/id_*.pub | head -1)"

cat > "${CLOUD_INIT_DIR}/meta-data" <<EOF
instance-id: ${VM_NAME}
local-hostname: ${VM_NAME}
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

cat > "${CLOUD_INIT_DIR}/network-config" <<'EOF'
network:
  version: 2
  ethernets:
    enp1s0:
      addresses:
        - 192.168.200.50/24
      routes:
        - to: default
          via: 192.168.200.1
      nameservers:
        addresses:
          - 192.168.200.1
EOF

genisoimage -output "$CLOUD_INIT_ISO" \
  -volid cidata -joliet -rock \
  "${CLOUD_INIT_DIR}/meta-data" \
  "${CLOUD_INIT_DIR}/user-data" \
  "${CLOUD_INIT_DIR}/network-config" \
  2>/dev/null
echo "✓ Cloud-init ISO created"
echo

# Create VM with cloud image (import, no installer)
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
  --disk "path=${CLOUD_INIT_ISO},device=cdrom" \
  --controller type=scsi,model=virtio-scsi \
  --channel unix,target_type=virtio,name=org.qemu.guest_agent.0 \
  --noautoconsole \
  --wait 0

echo "✓ VM created and booting"
echo
echo "Waiting for cloud-init to complete..."

# Wait for SSH
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
echo

# Wait a bit more for cloud-init to finish
$SSH_CMD "cloud-init status --wait" 2>/dev/null || true
echo "✓ Cloud-init complete"
echo

echo "=== VM created successfully ==="
echo "  SSH: ssh root@${VM_IP}"
echo
echo "Next step: Run ./provision.sh to install Proxmox VE"
