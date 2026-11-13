#!/usr/bin/env bash
# Build the ZFS-root stunt node (`STUNT_NODE=zfs`): Proxmox VE installed from
# the official ISO by its automated installer onto a ZFS root pool, so the
# node has the installer's own layout — rpool/ROOT/pve-1 at `/`, rpool/data,
# rpool/var-lib-vz — which the cloud-image node (ext4 root) cannot show.
#
# Steps: fetch + verify the ISO, embed an answer file with
# proxmox-auto-install-assistant (run in a Debian container; the tool is not
# packaged for the host), install unattended, then add what provision.sh adds
# on the other node (no-subscription repo, samba/nfs/smartmontools, Node.js 22)
# and take the `bare` snapshot.
set -euo pipefail

export STUNT_NODE=zfs
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

PVE_ISO_NAME="proxmox-ve_9.2-1.iso"
PVE_ISO_URL="https://enterprise.proxmox.com/iso/${PVE_ISO_NAME}"
PVE_ISO_SHA256="4e88fe416df9b527624a175f24c9aa07c714d3332afb1ee3dbf3879573ef2c6c"
PVE_ISO="${STORAGE_PATH}/${PVE_ISO_NAME}"
AUTO_ISO="${STORAGE_PATH}/${VM_NAME}-auto-install.iso"
SYSTEM_DISK="${STORAGE_PATH}/${VM_NAME}-system.qcow2"

echo "=== ANAS Stunt Node — Create ZFS-root VM (${VM_NAME}, ${VM_IP}) ==="
echo

for cmd in virsh qemu-img virt-install podman sha256sum; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd not found."
    exit 1
  fi
done

# `--post` re-runs only the post-install half on an already installed VM.
POST_ONLY=0
[ "${1:-}" = "--post" ] && POST_ONLY=1

if [ "$POST_ONLY" -eq 0 ] && sudo virsh dominfo "$VM_NAME" &>/dev/null; then
  echo "ERROR: VM '$VM_NAME' already exists. Run STUNT_NODE=zfs ./destroy-vm.sh first (or --post)."
  exit 1
fi

if [ "$POST_ONLY" -eq 0 ]; then

NET_ACTIVE=$(sudo virsh net-info "$VM_NETWORK" 2>/dev/null | grep "Active:" | awk '{print $2}') || true
if [ "$NET_ACTIVE" != "yes" ]; then
  sudo virsh net-start "$VM_NETWORK"
fi

# --- ISO ---------------------------------------------------------------------
if [ ! -f "$PVE_ISO" ]; then
  echo "Downloading ${PVE_ISO_NAME}..."
  curl -fL -o "${PVE_ISO}.part" "$PVE_ISO_URL"
  mv "${PVE_ISO}.part" "$PVE_ISO"
fi
echo "${PVE_ISO_SHA256}  ${PVE_ISO}" | sha256sum -c -
echo

# --- Answer file -------------------------------------------------------------
WORK_DIR="$(mktemp -d "${STORAGE_PATH}/${VM_NAME}-prepare.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
SSH_PUB_KEY="$(cat ~/.ssh/id_*.pub | head -1)"
MAC_COMPACT="${VM_MAC//:/}"

cat > "${WORK_DIR}/answer.toml" <<TOML
[global]
keyboard = "en-us"
country = "us"
fqdn = "${VM_NAME}.local"
mailto = "root@localhost"
timezone = "UTC"
root-password = "${VM_PASS}"
root-ssh-keys = [
    "${SSH_PUB_KEY}"
]
reboot-mode = "power-off"

[network]
source = "from-answer"
cidr = "${VM_IP}/24"
dns = "${VM_GATEWAY}"
gateway = "${VM_GATEWAY}"
filter.ID_NET_NAME_MAC = "*${MAC_COMPACT}"

[disk-setup]
filesystem = "zfs"
zfs.raid = "raid0"
disk-list = ["sda"]
TOML

# --- Prepare the ISO (Debian container: the assistant is a PVE-repo package) --
echo "Embedding the answer file (podman, debian:trixie)..."
podman run --rm --security-opt label=disable \
  -v "${STORAGE_PATH}:/images" -v "${WORK_DIR}:/work" \
  docker.io/library/debian:trixie bash -euc '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq wget ca-certificates xorriso >/dev/null
    wget -qO /usr/share/keyrings/proxmox-archive-keyring.gpg \
      https://enterprise.proxmox.com/debian/proxmox-archive-keyring-trixie.gpg
    printf "Types: deb\nURIs: http://download.proxmox.com/debian/pve\nSuites: trixie\nComponents: pve-no-subscription\nSigned-By: /usr/share/keyrings/proxmox-archive-keyring.gpg\n" \
      > /etc/apt/sources.list.d/pve.sources
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends proxmox-auto-install-assistant >/dev/null
    proxmox-auto-install-assistant validate-answer /work/answer.toml
    proxmox-auto-install-assistant prepare-iso "/images/'"${PVE_ISO_NAME}"'" \
      --fetch-from iso --answer-file /work/answer.toml --output /work/auto.iso
  '
mv "${WORK_DIR}/auto.iso" "$AUTO_ISO"
echo "✓ ${AUTO_ISO}"
echo

# --- Install -----------------------------------------------------------------
echo "Creating system disk (32G) and installing (unattended; the VM powers off when done)..."
qemu-img create -f qcow2 "$SYSTEM_DISK" 32G >/dev/null
sudo virt-install \
  --name "$VM_NAME" \
  --vcpus "$VM_VCPUS" \
  --memory "$VM_RAM" \
  --machine q35 \
  --os-variant debian12 \
  --network "network=${VM_NETWORK},mac=${VM_MAC}" \
  --graphics vnc,listen=127.0.0.1 \
  --disk "path=${SYSTEM_DISK},format=qcow2,bus=scsi" \
  --controller type=scsi,model=virtio-scsi \
  --cdrom "$AUTO_ISO" \
  --channel unix,target_type=virtio,name=org.qemu.guest_agent.0 \
  --noautoconsole \
  --noreboot \
  --wait 45
echo "✓ Installer finished"

# Eject the installer ISO; the cdrom's target is whatever virt-install gave it.
CDROM_TARGET="$(sudo virsh domblklist "$VM_NAME" --details | awk '$2 == "cdrom" { print $3 }' | head -1)"
if [ -n "$CDROM_TARGET" ]; then
  sudo virsh change-media "$VM_NAME" "$CDROM_TARGET" --eject --config 2>/dev/null || true
fi
fi # POST_ONLY
"${SCRIPT_DIR}/start.sh"
echo

# --- What provision.sh adds on the cloud-image node ---------------------------
echo "Switching to the no-subscription repository..."
$SSH_CMD "for f in /etc/apt/sources.list.d/pve-enterprise.sources /etc/apt/sources.list.d/ceph.sources; do [ -f \$f ] && mv \$f \$f.disabled; done; true"
$SSH_CMD "cat > /etc/apt/sources.list.d/pve-install-repo.sources" <<'SRC'
Types: deb
URIs: http://download.proxmox.com/debian/pve
Suites: trixie
Components: pve-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
SRC
# A freshly installed node runs its own apt-get update at first boot; wait for it.
$SSH_CMD "for i in \$(seq 1 60); do apt-get update && exit 0; sleep 5; done; exit 1"
echo "Installing additional packages..."
$SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get install -y samba nfs-kernel-server smartmontools curl"
echo "Installing Node.js 22..."
$SSH_CMD "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -"
$SSH_CMD "apt-get install -y nodejs"
echo

echo "Verifying installation..."
echo -n "  PVE version: "; $SSH_CMD "pveversion"
echo -n "  Root filesystem: "; $SSH_CMD "findmnt -n -o SOURCE,FSTYPE /"
echo -n "  Node.js: "; $SSH_CMD "node --version"
echo -n "  Web UI: "; $SSH_CMD "curl -sk -o /dev/null -w '%{http_code}' https://localhost:8006/ || echo unreachable"; echo
echo -n "  root@pam e-mail: "; $SSH_CMD "pveum user list --output-format json | grep -o '\"email\":\"[^\"]*\"' | head -1"
echo

"${SCRIPT_DIR}/stop.sh"
sudo virsh snapshot-create-as "$VM_NAME" bare "PVE 9.2 ISO install on a ZFS root + deps, no ANAS"
echo "✓ 'bare' snapshot created"
echo
echo "=== ZFS-root node ready ==="
echo "  STUNT_NODE=zfs ./start.sh && STUNT_NODE=zfs ./deploy-anas.sh"
