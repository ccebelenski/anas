#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

STORE_DEV="/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_${STORE_SERIAL}"
LOCAL_FILE="${SCRIPT_DIR}/config.local"

echo "=== ANAS PBS Node — Provision Proxmox Backup Server 4 ==="
echo

for cmd in python3; do
  command -v "$cmd" >/dev/null || { echo "ERROR: $cmd not found on the host."; exit 1; }
done

echo "Waiting for SSH..."
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

# --- Proxmox Backup Server repository ---------------------------------------
echo "Adding Proxmox Backup Server repository (no-subscription, trixie)..."
$SSH_CMD "wget -qO /usr/share/keyrings/proxmox-archive-keyring.gpg https://enterprise.proxmox.com/debian/proxmox-archive-keyring-trixie.gpg"
$SSH_CMD "cat > /etc/apt/sources.list.d/pbs-install-repo.sources" <<'EOF'
Types: deb
URIs: http://download.proxmox.com/debian/pbs
Suites: trixie
Components: pbs-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
EOF
# Pre-empt the enterprise stanza (it 401s without a subscription). Writing it
# commented out here also makes a re-run safe: the file is never left half-edited.
$SSH_CMD "cat > /etc/apt/sources.list.d/pbs-enterprise.sources" <<'EOF'
# Disabled — using pbs-no-subscription instead
# Types: deb
# URIs: https://enterprise.proxmox.com/debian/pbs
# Suites: trixie
# Components: pbs-enterprise
# Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
EOF
$SSH_CMD "apt-get update"
echo "✓ PBS repo added"
echo

# Cloud images don't set grub-pc's install device, so its postinst fails during
# an upgrade unless it is preseeded (same trap as the stunt node).
echo "Configuring grub install device..."
$SSH_CMD "echo 'grub-pc grub-pc/install_devices string /dev/sda' | debconf-set-selections"
echo

echo "Running full upgrade..."
$SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get -y full-upgrade"
echo "✓ System upgraded"
echo

echo "Installing proxmox-backup-server (this takes a while)..."
$SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get install -y proxmox-backup-server"
echo "✓ proxmox-backup-server installed"
echo

# The enterprise repo PBS drops in 401s without a subscription and breaks apt.
# Comment the WHOLE stanza out — commenting only `Types:` leaves the rest of the
# stanza behind and apt refuses the file ("Malformed stanza 1 … (type)").
echo "Disabling enterprise repository..."
$SSH_CMD "cat > /etc/apt/sources.list.d/pbs-enterprise.sources" <<'EOF'
# Disabled — using pbs-no-subscription instead
# Types: deb
# URIs: https://enterprise.proxmox.com/debian/pbs
# Suites: trixie
# Components: pbs-enterprise
# Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
EOF
$SSH_CMD "apt-get update -qq"
echo "✓ Enterprise repo disabled"
echo

echo "Enabling services..."
$SSH_CMD "systemctl enable --now proxmox-backup proxmox-backup-proxy"
$SSH_CMD "systemctl is-active proxmox-backup-proxy"
echo "✓ proxmox-backup-proxy running"
echo

# --- Datastore disk ----------------------------------------------------------
# ext4, not ZFS: this VM exists to be a backup TARGET, and nothing in the test
# harness reads the datastore's own filesystem. ext4 needs no extra packages,
# no pool import ordering, and no ARC tuning in a 4 GB VM — the simpler choice.
echo "Preparing datastore disk (${STORE_DEV} → ${PBS_DATASTORE_PATH}, ext4)..."
$SSH_CMD "test -b ${STORE_DEV}" || { echo "ERROR: datastore disk ${STORE_DEV} not present"; exit 1; }
if $SSH_CMD "blkid -o value -s LABEL ${STORE_DEV} 2>/dev/null | grep -qx 'pbs-${PBS_DATASTORE}'"; then
  echo "✓ Disk already formatted (label pbs-${PBS_DATASTORE})"
else
  $SSH_CMD "wipefs -a ${STORE_DEV}"
  $SSH_CMD "mkfs.ext4 -q -L pbs-${PBS_DATASTORE} ${STORE_DEV}"
  echo "✓ Disk formatted ext4"
fi
$SSH_CMD "mkdir -p ${PBS_DATASTORE_PATH}"
$SSH_CMD "grep -q ' ${PBS_DATASTORE_PATH} ' /etc/fstab || echo \"UUID=\$(blkid -o value -s UUID ${STORE_DEV}) ${PBS_DATASTORE_PATH} ext4 defaults 0 2\" >> /etc/fstab"
$SSH_CMD "mountpoint -q ${PBS_DATASTORE_PATH} || mount ${PBS_DATASTORE_PATH}"
$SSH_CMD "df -h ${PBS_DATASTORE_PATH} | tail -1"
echo "✓ Datastore disk mounted"
echo

# --- Datastore ---------------------------------------------------------------
if $SSH_CMD "proxmox-backup-manager datastore list --output-format json" | grep -q "\"${PBS_DATASTORE}\""; then
  echo "✓ Datastore '${PBS_DATASTORE}' already exists"
else
  echo "Creating datastore '${PBS_DATASTORE}'..."
  $SSH_CMD "proxmox-backup-manager datastore create ${PBS_DATASTORE} ${PBS_DATASTORE_PATH}"
  echo "✓ Datastore created"
fi
echo

# --- API token ---------------------------------------------------------------
# The secret is shown ONCE, at generation. A pre-existing token is deleted and
# regenerated so this script always ends with a secret we can write down.
TOKEN_USER="${PBS_TOKEN_ID%%!*}"
TOKEN_NAME="${PBS_TOKEN_ID##*!}"
if $SSH_CMD "proxmox-backup-manager user list-tokens ${TOKEN_USER} --output-format json" | grep -q "\"${PBS_TOKEN_ID}\""; then
  echo "Token ${PBS_TOKEN_ID} exists — deleting it (the secret cannot be read back)..."
  $SSH_CMD "proxmox-backup-manager user delete-token ${TOKEN_USER} ${TOKEN_NAME}"
fi

# `generate-token` rejects --output-format ("schema does not allow additional
# properties"); it prints `Result: { "tokenid": …, "value": … }` on stdout, and
# the secret is shown here and nowhere else, ever.
echo "Generating API token ${PBS_TOKEN_ID}..."
TOKEN_OUT=$($SSH_CMD "proxmox-backup-manager user generate-token ${TOKEN_USER} ${TOKEN_NAME}")
TOKEN_SECRET=$(printf '%s' "$TOKEN_OUT" | python3 -c 'import json,sys; t=sys.stdin.read(); print(json.loads(t[t.index("{"):])["value"])')
if [ -z "$TOKEN_SECRET" ]; then
  echo "ERROR: could not read the token secret from: $TOKEN_OUT"
  exit 1
fi
echo "✓ Token generated (secret captured, not printed)"

echo "Granting DatastoreAdmin on /datastore/${PBS_DATASTORE}..."
$SSH_CMD "proxmox-backup-manager acl update /datastore/${PBS_DATASTORE} DatastoreAdmin --auth-id '${PBS_TOKEN_ID}'"
$SSH_CMD "proxmox-backup-manager acl list"
echo

# --- Certificate fingerprint --------------------------------------------------
echo "Reading certificate fingerprint..."
# `cert info` prints `Fingerprint (sha256): 61:88:…:c3` — strip up to the FIRST
# colon-space only; the fingerprint itself is colon-separated.
FINGERPRINT=$($SSH_CMD "proxmox-backup-manager cert info" | grep -i 'fingerprint' | head -1 | sed 's/^[^:]*: *//')
if [ -z "$FINGERPRINT" ]; then
  echo "ERROR: could not read the certificate fingerprint"
  exit 1
fi
echo "✓ Fingerprint: ${FINGERPRINT}"
echo

# --- Write the local (gitignored) credentials file ----------------------------
if [ ! -f "$LOCAL_FILE" ]; then
  cat > "$LOCAL_FILE" <<'EOF'
# Developer-local settings for the PBS test VM — generated by provision-pbs.sh.
# GITIGNORED. Contains a test credential; never commit it.
EOF
fi
sed -i '/^PBS_TOKEN_SECRET=/d;/^PBS_FINGERPRINT=/d' "$LOCAL_FILE"
{
  echo "PBS_TOKEN_SECRET=\"${TOKEN_SECRET}\""
  echo "PBS_FINGERPRINT=\"${FINGERPRINT}\""
} >> "$LOCAL_FILE"
chmod 600 "$LOCAL_FILE"
echo "✓ Token secret + fingerprint written to ${LOCAL_FILE} (0600, gitignored)"
echo

# --- Verify -------------------------------------------------------------------
echo "Verifying..."
echo -n "  PBS version: "
$SSH_CMD "proxmox-backup-manager version"
echo -n "  Datastore:   "
$SSH_CMD "proxmox-backup-manager datastore list"
echo -n "  API (local): "
$SSH_CMD "curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:${PBS_PORT}/api2/json/version"
echo -n "  API (host):  "
curl -sk -o /dev/null -w '%{http_code}\n' "https://${VM_IP}:${PBS_PORT}/api2/json/version" || echo unreachable
echo

echo "=== Provisioning complete ==="
echo
echo "  Repository string: ${PBS_TOKEN_ID}@${VM_IP}:${PBS_DATASTORE}"
echo "  Fingerprint:       ${FINGERPRINT}"
echo "  Secret:            in ${LOCAL_FILE} (PBS_TOKEN_SECRET)"
echo
echo "Next step: ./snapshot.sh baseline"
