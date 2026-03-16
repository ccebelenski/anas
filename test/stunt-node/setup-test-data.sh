#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

echo "=== ANAS Stunt Node — Setup Test Data ==="
echo

# Attach two hot disks for the test pool
echo "Attaching disks for test pool..."
"${SCRIPT_DIR}/add-disk.sh" 1
"${SCRIPT_DIR}/add-disk.sh" 2
sleep 2
echo

# Find disk paths by serial
echo "Locating disks by serial..."
DISK1=$($SSH_CMD "readlink -f /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1")
DISK2=$($SSH_CMD "readlink -f /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT2")
echo "  hot1: ${DISK1}"
echo "  hot2: ${DISK2}"
echo

# Create mirror pool
echo "Creating testpool (mirror: hot1 + hot2)..."
$SSH_CMD "zpool create testpool mirror ${DISK1} ${DISK2}"
echo "✓ testpool created"
echo

# Create dataset
echo "Creating testpool/share1..."
$SSH_CMD "zfs create testpool/share1"
$SSH_CMD "chmod 777 /testpool/share1"
echo "✓ testpool/share1 created"
echo

# Create SMB share
echo "Configuring SMB share..."
$SSH_CMD "cat >> /etc/samba/smb.conf" <<'EOF'

[share1]
    path = /testpool/share1
    browseable = yes
    read only = no
    guest ok = yes
EOF
$SSH_CMD "systemctl restart smbd"
echo "✓ SMB share configured"
echo

# Create NFS export
echo "Configuring NFS export..."
$SSH_CMD "echo '/testpool/share1 192.168.200.0/24(rw,sync,no_subtree_check,no_root_squash)' >> /etc/exports"
$SSH_CMD "exportfs -ra"
echo "✓ NFS export configured"
echo

echo "=== Test data setup complete ==="
echo
echo "Verify:"
echo "  zpool status:   ./ssh.sh zpool status testpool"
echo "  SMB:            smbclient -N -L //${VM_IP}/"
echo "  NFS:            showmount -e ${VM_IP}"
