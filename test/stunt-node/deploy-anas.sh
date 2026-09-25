#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

echo "=== ANAS Stunt Node — Deploy ANAS ==="
echo

# Workspace links pre-flight
#
# npm workspaces link packages/<name> into node_modules/@anas/<name> as
# RELATIVE symlinks. Tooling that rewrites paths (an agent worktree, a tree
# move) can leave an ABSOLUTE link behind; rsync copies the link verbatim and
# the node's anasd then dies with ERR_MODULE_NOT_FOUND for @anas/shared —
# while the old three-second `is-active` verify below still reported success,
# because a crash-looping unit reads `active` between crashes. Catch the bad
# link on the host, before the build, where the repair is one `ln -sfn`.
echo "Checking workspace links..."
if [ ! -d "$PROJECT_ROOT/node_modules/@anas" ]; then
  echo "✗ $PROJECT_ROOT/node_modules/@anas not found — run npm install"
  exit 1
fi
for link in "$PROJECT_ROOT"/node_modules/@anas/*; do
  [ -L "$link" ] || continue
  name="$(basename "$link")"
  target="$(readlink "$link")"
  resolved="$(readlink -f "$link" 2>/dev/null || true)"
  if [ -z "$resolved" ] || [ ! -d "$resolved" ]; then
    echo "✗ node_modules/@anas/$name -> ${target:-(dangling)} — target does not resolve to a directory"
    exit 1
  fi
  case "$resolved" in
    "$PROJECT_ROOT"/packages/*) ;;
    *)
      echo "✗ node_modules/@anas/$name -> $target — does not resolve into $PROJECT_ROOT/packages"
      exit 1
      ;;
  esac
  case "$target" in
    /*)
      ln -sfn "../../packages/$name" "$link"
      echo "  ✓ $name -> ../../packages/$name (was absolute: $target — relinked relative)"
      ;;
    *)
      echo "  ✓ $name -> $target"
      ;;
  esac
done
echo "✓ Workspace links ok"
echo

# Build on host
echo "Building ANAS on host..."
cd "$PROJECT_ROOT"
npm run build
echo "✓ Build complete"
echo

# rsync to VM
#
# --delete-excluded makes /opt/anas a true mirror: without it, a directory the
# host stopped shipping (`.claude` — agent worktrees that once weighed 2.9G,
# `unsloth_compiled_cache`) stayed on the node forever and helped fill the
# root filesystem to 100%.
echo "Syncing to VM..."
rsync -az --delete --delete-excluded \
  --exclude '.git' \
  --exclude '.nuxt' \
  --exclude '.claude' \
  --exclude 'unsloth_compiled_cache' \
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
#
# INSTALLED FROM packaging/systemd/, never re-typed here. The two units used to
# be inline heredocs in this script, and that copy went stale: e49ce7f gave the
# gateway `PartOf=anasd.service` so a daemon restart brings it back, the
# packaging copy got it, and this one did not — every dev node kept the old
# `Requires=`-only unit, where `systemctl restart anasd` leaves the UI at 502
# with nothing to restart the gateway. The rsync above already puts the whole
# repo (packaging included) at /opt/anas, so the node installs the SAME files
# the tarball installer does — the same idiom as the iSCSI drop-in below.
echo "Installing systemd units..."
$SSH_CMD "install -m 0644 /opt/anas/packaging/systemd/anasd.service /etc/systemd/system/anasd.service"
$SSH_CMD "install -m 0644 /opt/anas/packaging/systemd/anas.service /etc/systemd/system/anas.service"
echo "  ✓ anasd.service + anas.service installed from packaging/systemd/"

# The iSCSI boot-ordering drop-in (stories iscsi.5 / iscsi.8, live-proof F14).
#
# MIRRORED from packaging/install.sh's install_iscsi_dropin, deliberately and
# not extracted: install.sh is a self-contained transactional installer with its
# own rollback, PREFIX handling and preflight, and this script is an rsync + a
# handful of ssh calls. There is no shared shell library between them and
# introducing one to share four lines would be the bigger change. The drop-in
# FILE itself is the single source — both copy the same
# packaging/systemd/rtslib-fb-targetctl.service.d/anas-ordering.conf, which is
# pinned by a unit test — so the two paths cannot drift in content, only in
# whether they run. Until F14, only this one did not, which meant every dev node
# silently lost the boot AND shutdown ordering a live proof depends on.
#
# Installed unconditionally: a drop-in for a unit that is not installed yet is
# inert, not an error. The daemon-reload below covers it.
$SSH_CMD "install -d -m 0755 /etc/systemd/system/rtslib-fb-targetctl.service.d && install -m 0644 /opt/anas/packaging/systemd/rtslib-fb-targetctl.service.d/anas-ordering.conf /etc/systemd/system/rtslib-fb-targetctl.service.d/anas-ordering.conf"
echo "  ✓ iSCSI ordering drop-in installed"

$SSH_CMD "systemctl daemon-reload"
$SSH_CMD "systemctl enable anasd anas"
echo "✓ Systemd units installed"
echo

# Start services
#
# reset-failed first: `systemctl restart` does NOT clear the unit's restart
# counter, so NRestarts left over from a previous bad deploy would make the
# crash-loop check below read 0 no matter what happens after this restart.
echo "Starting services..."
$SSH_CMD "systemctl reset-failed anasd anas 2>/dev/null || true"
$SSH_CMD "systemctl restart anasd anas"
echo

# Verify
#
# `is-active` three seconds after a restart proves nothing: with Restart=
# on-failure and RestartSec=5 a unit that dies on startup (the ERR_MODULE_NOT_FOUND
# case the workspace-links pre-flight above guards the other half of) reads
# `active` between crashes, so the old check passed while anasd was crash-looping.
# Wait out the crash loop instead: for a full window after the restart, both
# units must stay active with NRestarts still at 0, the daemon's /v1/health must
# answer over its socket with the version built from this tree, and the
# gateway must answer the same version on its loopback port. The gateway probe
# is /installed, not /api/health: /api/health sits behind the ticket check
# when hit directly (only /installed is auth-exempt — the panels' pre-login
# probe), and TLS termination belongs to pveproxy, so the loopback listener is
# plain HTTP (gateway config.ts).
echo "Verifying..."
expected_version="$(node -p "require('$PROJECT_ROOT/packages/daemon/package.json').version")"
if $SSH_CMD "bash -s -- '$expected_version'" <<'REMOTE'
deadline=$((SECONDS + 30))
while [ "$SECONDS" -lt "$deadline" ]; do
  restarts="$(systemctl show -p NRestarts --value anasd)"
  if [ "$restarts" != "0" ]; then
    echo "  ✗ anasd crash-looping (NRestarts=$restarts)"
    exit 1
  fi
  if systemctl is-active --quiet anasd && systemctl is-active --quiet anas; then
    daemon_health="$(curl -sf --max-time 2 --unix-socket /run/anas/anasd.sock http://localhost/v1/health 2>/dev/null || true)"
    . /etc/default/anas 2>/dev/null || true
    # Loopback is plain HTTP by design (gateway config.ts — TLS belongs to
    # pveproxy); /installed is the one auth-exempt GET and carries the version.
    gw_health="$(curl -sf --max-time 2 "http://127.0.0.1:${ANAS_PORT:-3000}/installed" 2>/dev/null || true)"
    if printf '%s' "$daemon_health" | grep -q "\"version\":\"$1\"" \
      && printf '%s' "$gw_health" | grep -q "\"version\":\"$1\""; then
      exit 0
    fi
  fi
  sleep 2
done
echo "  ✗ timed out waiting for anasd/anas health endpoints"
exit 1
REMOTE
then
  echo "  ✓ anasd active, 0 restarts, /v1/health answers version $expected_version"
  echo "  ✓ anas active, /installed answers the same version"
else
  $SSH_CMD "journalctl -u anasd -n 40 --no-pager"
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
$SSH_CMD "install -m 0755 /opt/anas/packaging/anas-md-event.sh /usr/local/bin/anas-md-event && install -d /usr/share/pve-manager/templates/default && install -m 0644 /opt/anas/packaging/templates/anas-*.hbs /usr/share/pve-manager/templates/default/"
echo "  ✓ anas-md-event hook installed (/usr/local/bin/anas-md-event)"
# AHR read-cache event hook + its udev rule (story ahrcache.1 slice 2,
# AHR-DESIGN §13). MIRRORED from packaging/install.sh's step 2b2 for the same
# reason the iSCSI drop-in above is — the FILES are the single source, only
# whether they get installed differs between the two paths. Without this a dev
# node has no `<pool>-cacheN` removal rung at all, so a pulled cache disk is
# recovered only at the next daemon start (the boot rung) and the live
# auto-uncache the story turns on could never be proven here.
$SSH_CMD "install -m 0755 /opt/anas/packaging/anas-cache-event.sh /usr/local/bin/anas-cache-event && install -d /etc/udev/rules.d && install -m 0644 /opt/anas/packaging/anas-cache.rules /etc/udev/rules.d/99-anas-cache.rules && udevadm control --reload-rules"
echo "  ✓ anas-cache-event hook + udev rule installed (/usr/local/bin/anas-cache-event, /etc/udev/rules.d/99-anas-cache.rules)"
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
