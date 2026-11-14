#!/usr/bin/env bash
#
# ANAS production installer. Runs ON a Proxmox VE node, as root, from the
# untarred release root (the directory containing this script, app/ and
# systemd/).
#
# Design: a read-only PHASE 0 preflight that mutates nothing and aborts early
# with a clear summary, followed by a transactional PHASE 1 that records every
# completed step so an ERR trap can reverse them and leave the node unchanged.
#
# ANAS is a guest on the system (PRINCIPLES.md #12): surgical, reversible,
# idempotent. A re-run is a clean in-place upgrade (backup -> install -> drop
# backup on success), never a duplicate unit or a double <script> line.
#
# -E (errtrace, CORE-L4): the ERR trap phase1_install arms must also fire for a
# command that fails INSIDE a function it calls (install_units, write_env_file,
# health_check's callees); without it bash exits there under -e and the
# rollback never runs, leaving a half-installed node.
set -Eeuo pipefail

# --- Paths / config ---------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_SRC="${SCRIPT_DIR}/app"
UNIT_SRC="${SCRIPT_DIR}/systemd"

# Overridable (defaults are production). SYSTEMD_DIR is exposed mainly for tests;
# PVE_TPL/PVE_JS_DIR/APT_HOOK are passed through to the pve-integration scripts.
PREFIX="${PREFIX:-/opt/anas}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
NODE_BIN="${NODE_BIN:-node}"

# Gateway loopback port (issue #2). NODE-LOCAL, operator-configurable. The
# resolved value is written to ANAS_ENV_FILE (read by both anas.service via
# EnvironmentFile and AnasProxy.pm) and drives the post-install health check.
# ss/systemctl are indirected so the resolution logic is unit-testable.
ANAS_ENV_FILE="${ANAS_ENV_FILE:-/etc/default/anas}"
DEFAULT_PORT=3000
SS_BIN="${SS_BIN:-ss}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
PORT_FLAG=""            # set by --port; explicit operator intent
RESOLVED_PORT=""        # filled by resolve_port()
# HEALTH_PORT is derived from the resolved port (retires the old standalone
# HEALTH_PORT that was never plumbed into the service — issue #2). Still
# overridable for tests, but normally set by resolve_port().
HEALTH_PORT="${HEALTH_PORT:-}"

# Flags.
INSTALL_DEPS=0
ASSUME_YES=0
FORCE=0

MIN_NODE_MAJOR=20
MIN_ZFS="2.2"

# The PVE notification templates ANAS ships (one subject/body pair per event
# TYPE, so operators can match on the kind of event): anas-ahr = array/pool
# events (AHR §7.2), anas-backup = backup-run results (16.12), anas-snapshot =
# snapshot-schedule run failures and anas-replication = replication run
# failures (9.4), anas-cloud = cloud sync run results (rclone.2),
# anas-integration = a failed re-apply of the PVE UI integration by the apt
# hook (installer.1). Listed once — the preflight check and the install step
# both read this list, and uninstall.sh removes exactly the same names.
NOTIFY_TEMPLATES=(
  anas-ahr-subject.txt.hbs
  anas-ahr-body.txt.hbs
  anas-backup-subject.txt.hbs
  anas-backup-body.txt.hbs
  anas-snapshot-subject.txt.hbs
  anas-snapshot-body.txt.hbs
  anas-replication-subject.txt.hbs
  anas-replication-body.txt.hbs
  anas-cloud-subject.txt.hbs
  anas-cloud-body.txt.hbs
  anas-integration-subject.txt.hbs
  anas-integration-body.txt.hbs
)

# The iSCSI boot-ordering drop-in (story iscsi.5). rtslib-fb-targetctl.service
# belongs to python3-rtslib-fb; ANAS never edits it, it adds this drop-in beside
# it so an apt upgrade of the package cannot lose the ordering and uninstall.sh
# has exactly one file to remove. Listed once — the preflight completeness check,
# the install step and uninstall.sh all read these two names.
ISCSI_DROPIN_DIR="rtslib-fb-targetctl.service.d"
ISCSI_DROPIN_FILE="anas-ordering.conf"

# The recycle-bin purge timer + service (smbsvc.2). ONE static pair for ALL
# shares: the runner (app/packages/daemon/dist/recycle-purge.js) reads each
# stanza's purge age from its `# anas:recycle-purge-days` marker in smb.conf,
# so nothing is created or removed per share — the timer is enabled once here
# and disabled once by uninstall.sh. A share without the feature is invisible
# to it, and uninstall never touches any `#recycle` directory (a checkbox
# never deletes data).
RECYCLE_TIMER="anas-recycle.timer"
RECYCLE_SERVICE="anas-recycle.service"

log()  { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
err()  { printf 'ERROR: %s\n' "$*" >&2; }

usage() {
  cat <<EOF
ANAS installer

Usage: sudo ./install.sh [options]

Options:
  --install-deps   Auto-install Node.js (>= ${MIN_NODE_MAJOR}) via the NodeSource setup_22.x
                   repository if it is absent or too old. Everything else ANAS
                   requires (acl, mdadm, btrfs-progs, samba, nfs-kernel-server,
                   targetcli-fb, python3-rtslib-fb, rclone) is a HARD dependency
                   and is installed regardless of this flag.
  --yes            Non-interactive; assume "yes" to prompts.
  --prefix DIR     Install location (default: /opt/anas).
  --port N         Loopback port for the ANAS gateway (default: ${DEFAULT_PORT}).
                   Written to ${ANAS_ENV_FILE}. Use this when another service
                   already holds ${DEFAULT_PORT}. An existing configured port is
                   preserved across upgrades unless --port is given.
  --force          Skip the ZFS >= ${MIN_ZFS} version gate (ANAS needs 'zpool -j').
  -h, --help       Show this help.
EOF
}

# --- Arg parsing ------------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-deps) INSTALL_DEPS=1 ;;
    --yes|-y)       ASSUME_YES=1 ;;
    --force)        FORCE=1 ;;
    --prefix)       shift; [ "$#" -gt 0 ] || { err "--prefix needs an argument"; exit 2; }; PREFIX="$1" ;;
    --prefix=*)     PREFIX="${1#*=}" ;;
    --port)         shift; [ "$#" -gt 0 ] || { err "--port needs an argument"; exit 2; }; PORT_FLAG="$1" ;;
    --port=*)       PORT_FLAG="${1#*=}" ;;
    -h|--help)      usage; exit 0 ;;
    *) err "unknown option: $1"; usage >&2; exit 2 ;;
  esac
  shift
done

confirm() {
  # confirm "question" -> 0 if yes. Auto-yes with --yes / non-tty.
  [ "${ASSUME_YES}" -eq 1 ] && return 0
  if [ ! -t 0 ]; then return 0; fi
  local reply
  printf '%s [y/N] ' "$1"
  read -r reply || true
  case "${reply}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# version_ge A B  -> 0 if A >= B (dotted numeric compare).
version_ge() {
  [ "$1" = "$2" ] && return 0
  local lo
  lo="$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)"
  [ "${lo}" = "$2" ]
}

# =============================================================================
# Gateway port resolution (issue #2) — NODE-LOCAL, unit-testable.
# =============================================================================

# valid_port N -> 0 if N is an integer in 1..65535.
valid_port() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# read_env_port FILE -> echo the ANAS_PORT value from an existing env file (last
# valid assignment wins, shell semantics), or nothing. Tolerates 'export ',
# quotes, inline '#' comments and whitespace.
read_env_port() {
  local f="$1" line val
  [ -f "${f}" ] || return 0
  line="$(grep -E '^[[:space:]]*(export[[:space:]]+)?ANAS_PORT[[:space:]]*=' "${f}" 2>/dev/null | tail -n1)" || true
  [ -n "${line}" ] || return 0
  val="${line#*=}"
  val="${val%%#*}"                      # strip inline comment
  val="${val#\"}"; val="${val%\"}"      # strip surrounding double quotes
  val="${val#\'}"; val="${val%\'}"      # strip surrounding single quotes
  val="$(printf '%s' "${val}" | tr -d '[:space:]')"
  valid_port "${val}" || return 0
  printf '%s' "${val}"
}

# our_configured_port -> the port THIS node's ANAS currently uses: the env-file
# value, or the legacy default 3000 when no env file exists yet (upgrades from a
# pre-env-file install ran on 3000).
our_configured_port() {
  local p
  p="$(read_env_port "${ANAS_ENV_FILE}")"
  [ -n "${p}" ] && { printf '%s' "${p}"; return 0; }
  printf '%s' "${DEFAULT_PORT}"
}

# port_listening N -> 0 if something is LISTENing on N (via SS_BIN). If ss is
# unavailable we cannot tell -> treat as free (return 1), matching the prior
# best-effort behaviour.
port_listening() {
  local p="$1" out
  command -v "${SS_BIN}" >/dev/null 2>&1 || return 1
  # Capture the listing FIRST, then match against a here-string (issue #21).
  # Piping ss straight into `grep -q` lets grep exit on its first hit, killing ss
  # with SIGPIPE (exit 141), which `set -o pipefail` then reports as a pipeline
  # FAILURE — i.e. "port free" for a port that is demonstrably listening. On a
  # short listing ss usually finishes writing before grep exits, so the bug only
  # shows up when the listing is long: a genuinely intermittent wrong answer
  # about a port conflict, and an intermittent escape of the conflict guard. No
  # pipe, no race. `|| true` keeps a non-zero ss from tripping `set -e`.
  out="$("${SS_BIN}" -ltn 2>/dev/null || true)"
  grep -qE "[:.]${p}[[:space:]]" <<<"${out}"
}

# ours_on_port N -> 0 if a listener on N belongs to OUR gateway (the anas
# service is active AND N is our configured port). Used so an in-place upgrade's
# own listener is never mistaken for a foreign conflict.
ours_on_port() {
  local p="$1"
  "${SYSTEMCTL_BIN}" is-active --quiet anas 2>/dev/null || return 1
  [ "${p}" = "$(our_configured_port)" ]
}

# Resolve the gateway port into RESOLVED_PORT, with precedence (issue #2):
#   1. --port N wins; a FOREIGN listener on it is a hard error (respect intent).
#   2. else an existing ${ANAS_ENV_FILE} value is preserved (upgrades never re-pick).
#   3. else default ${DEFAULT_PORT}; on a fresh install, if it is FOREIGN-held,
#      auto-scan upward to the first free port and log the choice loudly.
resolve_port() {
  local existing
  existing="$(read_env_port "${ANAS_ENV_FILE}")"

  # 1. Explicit operator intent.
  if [ -n "${PORT_FLAG}" ]; then
    if ! valid_port "${PORT_FLAG}"; then
      err "--port '${PORT_FLAG}' is not a valid port (1-65535)"
      exit 2
    fi
    if port_listening "${PORT_FLAG}" && ! ours_on_port "${PORT_FLAG}"; then
      err "--port ${PORT_FLAG} is already in use by another listener on this node."
      err "Refusing to silently choose a different port. Free :${PORT_FLAG} or pass a different --port."
      exit 1
    fi
    RESOLVED_PORT="${PORT_FLAG}"
    info "gateway port: ${RESOLVED_PORT} (from --port)"
    return 0
  fi

  # 2. Preserve an already-configured port across upgrades.
  if [ -n "${existing}" ]; then
    RESOLVED_PORT="${existing}"
    info "gateway port: ${RESOLVED_PORT} (preserved from ${ANAS_ENV_FILE})"
    return 0
  fi

  # 3. Fresh install: default, auto-scanning past a foreign listener.
  local candidate="${DEFAULT_PORT}" scan
  if port_listening "${candidate}" && ! ours_on_port "${candidate}"; then
    for scan in $(seq $((DEFAULT_PORT + 1)) $((DEFAULT_PORT + 99))); do
      if ! port_listening "${scan}"; then candidate="${scan}"; break; fi
    done
    if port_listening "${candidate}"; then
      err "port ${DEFAULT_PORT} is in use and no free port was found in ${DEFAULT_PORT}-$((DEFAULT_PORT + 99))."
      err "Specify one explicitly with --port N."
      exit 1
    fi
    warn "port ${DEFAULT_PORT} is already in use by another process on this node."
    warn "ANAS gateway will use :${candidate} instead (written to ${ANAS_ENV_FILE})."
  fi
  RESOLVED_PORT="${candidate}"
  info "gateway port: ${RESOLVED_PORT} (default)"
}

# Write the ANAS-owned env file consumed by anas.service (EnvironmentFile) and
# AnasProxy.pm. Fresh each install from the resolved port (the file is ours).
write_env_file() {
  local port="$1"
  ensure_dir "$(dirname "${ANAS_ENV_FILE}")"
  cat > "${ANAS_ENV_FILE}" <<EOF
# ANAS gateway configuration — managed by install.sh (issue #2). KEY=VALUE.
# Loopback port the anas gateway binds and pveproxy forwards /anas requests to.
# NODE-LOCAL: each node has its own value; nothing here is cluster-wide.
ANAS_PORT=${port}
EOF
  chmod 0644 "${ANAS_ENV_FILE}"
  # Flushed: an EnvironmentFile cut short by a power loss is a dead gateway.
  sync -f -- "${ANAS_ENV_FILE}"
  info "wrote ${ANAS_ENV_FILE} (ANAS_PORT=${port})"
}

# =============================================================================
# Release completeness (GitHub #74) — read-only, unit-testable.
# =============================================================================

# What the release tarball unpacks to (make-release.sh), in one line. Printed in
# the refusal so an operator can compare it with what is actually there.
RELEASE_LAYOUT="install.sh uninstall.sh VERSION anas-md-event.sh anas-cache-event.sh anas-cache.rules app/ systemd/ templates/"

# Record a missing release path once (a directory carries its trailing slash).
release_missing() {
  local m
  for m in "${RELEASE_MISSING[@]}"; do [ "${m}" = "$1" ] && return 0; done
  RELEASE_MISSING+=("$1")
}

# release_need <path relative to SCRIPT_DIR> — a trailing slash means a
# directory, anything else a regular file. When the path's top-level directory
# is missing altogether, that directory is recorded once instead of every file
# under it (a missing app/ is one finding, not four).
release_need() {
  local rel="$1" top
  case "${rel}" in
    */*)
      top="${rel%%/*}"
      if [ ! -d "${SCRIPT_DIR}/${top}" ]; then
        release_missing "${top}/"
        return 0
      fi
      ;;
  esac
  case "${rel}" in
    */) [ -d "${SCRIPT_DIR}/${rel%/}" ] || release_missing "${rel}" ;;
    *)  [ -f "${SCRIPT_DIR}/${rel}" ]   || release_missing "${rel}" ;;
  esac
}

# The refusal's "release incomplete" entry: the directory checked, every missing
# path by name, the expected layout, and the fix. Continuation lines carry the
# six-space indent the other multi-line preflight entries use.
release_incomplete_message() {
  local ver="<version>" missing
  [ -n "${NEW_VERSION:-}" ] && [ "${NEW_VERSION}" != "unknown" ] && ver="${NEW_VERSION}"
  missing="$(printf '%s, ' "${RELEASE_MISSING[@]}")"
  missing="${missing%, }"
  printf 'release incomplete: the directory install.sh runs from is not a whole ANAS release.\n'
  printf '      checked:  %s\n' "${SCRIPT_DIR}"
  printf '      missing:  %s\n' "${missing}"
  printf '      expected: %s\n' "${RELEASE_LAYOUT}"
  printf '      fix:      re-extract the release asset into a fresh, empty directory and run ./install.sh from inside it:\n'
  printf '                mkdir anas-fresh && tar xzf anas-%s.tar.gz -C anas-fresh\n' "${ver}"
  printf '                cd anas-fresh/anas-%s && sudo ./install.sh' "${ver}"
}

# =============================================================================
# PHASE 0 — preflight (read-only; mutate nothing; abort early)
# =============================================================================
NEED_NODE_INSTALL=0
NEED_ACL_INSTALL=0
NEED_MDADM_INSTALL=0
NEED_BTRFS_INSTALL=0
NEED_SAMBA_INSTALL=0
NEED_NFS_INSTALL=0
NEED_TARGETCLI_INSTALL=0
NEED_RCLONE_INSTALL=0
FATAL=()
RELEASE_MISSING=()

phase0_preflight() {
  log "Preflight checks (no changes will be made)..."

  # Version transition (10.10): what's installed now vs what this release is.
  NEW_VERSION="unknown"
  [ -f "${SCRIPT_DIR}/VERSION" ] && NEW_VERSION="$(cat "${SCRIPT_DIR}/VERSION")"
  OLD_VERSION=""
  if [ -f "${PREFIX}/VERSION" ]; then
    OLD_VERSION="$(cat "${PREFIX}/VERSION")"
  elif [ -e "${PREFIX}" ]; then
    OLD_VERSION="unknown"   # pre-10.10 install: no VERSION on disk
  fi
  if [ -z "${OLD_VERSION}" ]; then
    info "fresh install: ANAS ${NEW_VERSION}"
  elif [ "${OLD_VERSION}" = "${NEW_VERSION}" ]; then
    info "reinstall: ANAS ${NEW_VERSION} (same version)"
  elif [ "${NEW_VERSION}" != "unknown" ] && [ "${OLD_VERSION}" != "unknown" ] \
       && ! version_ge "${NEW_VERSION}" "${OLD_VERSION}"; then
    warn "DOWNGRADE: installed ANAS is ${OLD_VERSION}, this release is ${NEW_VERSION}"
    confirm "Continue with downgrade to ${NEW_VERSION}?" \
      || { err "downgrade declined — the node was NOT modified"; exit 1; }
  else
    info "upgrade: ANAS ${OLD_VERSION} -> ${NEW_VERSION}"
  fi

  # Layout sanity — the release must be intact. Every path is relative to the
  # directory this install.sh runs from; a miss is collected by name and the
  # refusal names that directory, the files, the layout and the fix (GitHub #74:
  # the old one-line-per-file refusal named neither the directory nor the fix).
  RELEASE_MISSING=()
  release_need app/
  release_need VERSION
  release_need systemd/anasd.service
  release_need systemd/anas.service
  release_need anas-md-event.sh                                  # mdadm PROGRAM hook (AHR §7.2)
  release_need anas-cache-event.sh                               # AHR cache removal hook
  release_need anas-cache.rules
  release_need "systemd/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}"
  release_need "systemd/${RECYCLE_TIMER}"
  release_need "systemd/${RECYCLE_SERVICE}"
  release_need app/packages/daemon/dist/recycle-purge.js         # recycle purge runner
  release_need app/packages/daemon/dist/backup-task.js           # backup runner
  release_need app/packages/daemon/dist/cloud-task.js            # cloud sync runner
  for tpl in "${NOTIFY_TEMPLATES[@]}"; do
    release_need "templates/${tpl}"
  done
  if [ "${#RELEASE_MISSING[@]}" -gt 0 ]; then
    FATAL+=("$(release_incomplete_message)")
  fi

  # Root.
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    FATAL+=("must run as root (EUID 0) — try: sudo ./install.sh")
  fi

  # Proxmox VE node.
  if [ ! -f /usr/share/pve-manager/index.html.tpl ] || ! command -v pveversion >/dev/null 2>&1; then
    FATAL+=("this does not look like a Proxmox VE node (missing pveversion or /usr/share/pve-manager/index.html.tpl)")
  else
    info "PVE node detected: $(pveversion 2>/dev/null | head -n1)"
  fi

  # Node.js >= MIN_NODE_MAJOR.
  if command -v "${NODE_BIN}" >/dev/null 2>&1; then
    local nv major
    nv="$("${NODE_BIN}" --version 2>/dev/null || echo v0)"   # e.g. v22.11.0
    major="${nv#v}"; major="${major%%.*}"
    if [ "${major:-0}" -ge "${MIN_NODE_MAJOR}" ] 2>/dev/null; then
      info "Node.js ${nv} (>= ${MIN_NODE_MAJOR}) OK"
    else
      if [ "${INSTALL_DEPS}" -eq 1 ]; then
        NEED_NODE_INSTALL=1
        info "Node.js ${nv} too old (< ${MIN_NODE_MAJOR}) — will install via NodeSource (--install-deps)"
      else
        FATAL+=("Node.js ${nv} is too old (need >= ${MIN_NODE_MAJOR}). Re-run with --install-deps, or install it:
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs")
      fi
    fi
  else
    if [ "${INSTALL_DEPS}" -eq 1 ]; then
      NEED_NODE_INSTALL=1
      info "Node.js not found — will install via NodeSource (--install-deps)"
    else
      FATAL+=("Node.js not found (need >= ${MIN_NODE_MAJOR}). Re-run with --install-deps, or install it:
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs")
    fi
  fi

  # ZFS >= MIN_ZFS (ANAS depends on 'zpool -j' JSON, new in 2.2).
  local zver=""
  if command -v zpool >/dev/null 2>&1; then
    # `zpool version` prints e.g. "zfs-2.2.6\nzfs-kmod-2.2.6"
    zver="$(zpool version 2>/dev/null | head -n1 | grep -oE '[0-9]+(\.[0-9]+)+' | head -n1 || true)"
  fi
  if [ -z "${zver}" ] && [ -r /sys/module/zfs/version ]; then
    zver="$(grep -oE '[0-9]+(\.[0-9]+)+' /sys/module/zfs/version | head -n1 || true)"
  fi
  if [ -z "${zver}" ]; then
    if [ "${FORCE}" -eq 1 ]; then
      warn "could not determine ZFS version — proceeding due to --force"
    else
      FATAL+=("could not determine ZFS version (need >= ${MIN_ZFS} for 'zpool -j'). Use --force to override.")
    fi
  elif version_ge "${zver}" "${MIN_ZFS}"; then
    info "ZFS ${zver} (>= ${MIN_ZFS}) OK"
  else
    if [ "${FORCE}" -eq 1 ]; then
      warn "ZFS ${zver} is < ${MIN_ZFS} — proceeding due to --force (JSON output may be unavailable)"
    else
      FATAL+=("ZFS ${zver} is too old (need >= ${MIN_ZFS} for 'zpool -j'). Use --force to override.")
    fi
  fi

  # acl / setfacl — required for named-principal POSIX ACL grants. Tiny/standard;
  # mark for auto-install (performed after preflight passes, before Phase 1).
  if command -v setfacl >/dev/null 2>&1; then
    info "acl (setfacl) present"
  else
    NEED_ACL_INSTALL=1
    info "acl (setfacl) missing — will auto-install"
  fi

  # mdadm / btrfs-progs — required for AHR (hybrid RAID) pools. PVE 9 ships
  # neither (AHR ground truth GT-1); standard Debian packages, mark for
  # auto-install (performed after preflight passes, before Phase 1).
  if command -v mdadm >/dev/null 2>&1; then
    info "mdadm present"
  else
    NEED_MDADM_INSTALL=1
    info "mdadm missing — will auto-install"
  fi
  if command -v mkfs.btrfs >/dev/null 2>&1; then
    info "btrfs-progs (mkfs.btrfs) present"
  else
    NEED_BTRFS_INSTALL=1
    info "btrfs-progs (mkfs.btrfs) missing — will auto-install"
  fi

  # samba / nfs-kernel-server — required for SMB and NFS shares. PVE 9 ships
  # neither; both are standard Debian packages. ANAS does NOT gate the share
  # features on their presence — the Shares and Share Users screens are always
  # there — so the binaries they need are HARD dependencies, exactly like
  # mdadm/btrfs-progs (issue #6: a fresh node had no smbpasswd, and adding an
  # SMB share user failed with a raw `spawn /usr/bin/smbpasswd ENOENT`).
  # smbd comes from `samba`, smbpasswd from `samba-common-bin` (which `samba`
  # pulls in) — probing both catches a node with only half of the pair.
  if command -v smbd >/dev/null 2>&1 && command -v smbpasswd >/dev/null 2>&1; then
    info "samba (smbd, smbpasswd) present"
  else
    NEED_SAMBA_INSTALL=1
    info "samba (smbd/smbpasswd) missing — will auto-install"
  fi
  if command -v exportfs >/dev/null 2>&1; then
    info "nfs-kernel-server (exportfs) present"
  else
    NEED_NFS_INSTALL=1
    info "nfs-kernel-server (exportfs) missing — will auto-install"
  fi

  # targetcli-fb / python3-rtslib-fb — required to SERVE iSCSI block storage
  # (LIO, the kernel target). PVE 9 ships neither, though it does ship the
  # INITIATOR side (open-iscsi) for its own `iscsi:` storage type — ANAS never
  # touches that half. Same rule as samba/nfs: the iSCSI screen is always there,
  # not gated on the tooling, so the tooling is a HARD dependency.
  # `targetcli` comes from targetcli-fb; the python3 module import proves
  # python3-rtslib-fb, which is the half that owns the restore service and the
  # persisted /etc/rtslib-fb-target/saveconfig.json — probing both catches a node
  # with only one of the pair.
  if command -v targetcli >/dev/null 2>&1 \
     && python3 -c 'import rtslib_fb' >/dev/null 2>&1; then
    info "targetcli-fb + python3-rtslib-fb present"
  else
    NEED_TARGETCLI_INSTALL=1
    info "targetcli-fb/python3-rtslib-fb missing — will auto-install"
  fi

  # rclone — required for cloud sync remotes (rclone.1). A standard Debian
  # package a node may not have. Same rule as samba/nfs: the Cloud screen is
  # always there, not gated on the tooling, so the binary is a HARD dependency.
  # ANAS drives it with an explicit --config (its own /etc/anas/rclone.conf),
  # so only the binary itself is needed here.
  if command -v rclone >/dev/null 2>&1; then
    info "rclone present"
  else
    NEED_RCLONE_INSTALL=1
    info "rclone missing — will auto-install"
  fi

  # Resolve the gateway port (issue #2) before anything binds. This owns the
  # port-in-use logic: --port intent, preserving a configured port on upgrade,
  # and auto-scanning past a foreign listener on a fresh install. May exit here
  # (still read-only — nothing mutated) if --port collides with a foreign
  # listener. HEALTH_PORT is derived from the result and drives the health check.
  resolve_port
  HEALTH_PORT="${RESOLVED_PORT}"
  # On an in-place upgrade our own gateway may currently hold the port — that is
  # routine (Phase 1 stops it before the copy), not a warning.
  if port_listening "${HEALTH_PORT}" && ours_on_port "${HEALTH_PORT}"; then
    info "existing ANAS gateway is listening on :${HEALTH_PORT} — it will be stopped and upgraded"
  fi

  # Every path phase 1 writes outside the prefix is a file, a link to one, or
  # absent (cr3 review 2): a dangling link or a directory is refused here.
  preflight_owned_paths

  # Abort if any hard failure. Nothing has been mutated up to this point.
  if [ "${#FATAL[@]}" -gt 0 ]; then
    echo >&2
    err "preflight failed — the node was NOT modified:"
    local f
    for f in "${FATAL[@]}"; do printf '  - %s\n' "${f}" >&2; done
    exit 1
  fi
  log "Preflight OK."
}

# Install the dependencies preflight marked missing: Node.js via NodeSource
# (opted in with --install-deps), then the hard dependencies that are installed
# regardless — acl, mdadm + btrfs-progs, samba + nfs-kernel-server,
# targetcli-fb + python3-rtslib-fb, rclone. This mutates
# the system but only adds standard Debian packages; it is NOT rolled back on a
# later failure (leaving deps installed is harmless). It runs on every install
# AND every upgrade, so an existing node picks up a dependency added by a newer
# ANAS release the next time the installer is run.
phase0b_install_deps() {
  if [ "${NEED_NODE_INSTALL}" -eq 1 ]; then
    log "Installing Node.js 22 via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    command -v "${NODE_BIN}" >/dev/null 2>&1 || { err "Node.js install failed"; exit 1; }
    info "Node.js $("${NODE_BIN}" --version) installed"
  fi
  if [ "${NEED_ACL_INSTALL}" -eq 1 ]; then
    log "Installing acl..."
    apt-get install -y acl
    command -v setfacl >/dev/null 2>&1 || { err "acl install failed (setfacl still missing)"; exit 1; }
    info "acl installed"
  fi
  if [ "${NEED_MDADM_INSTALL}" -eq 1 ] || [ "${NEED_BTRFS_INSTALL}" -eq 1 ]; then
    log "Installing mdadm + btrfs-progs..."
    # noninteractive: mdadm's postinst debconf-prompts about boot arrays/MAILADDR.
    # These are a HARD dependency (AHR / Hybrid RAID) — matching the node/acl
    # pattern, they are installed at install time, never optional. Catch an apt
    # failure explicitly (set -e would otherwise abort silently) and say exactly
    # what is needed, that nothing has been changed yet, and how to preseed.
    # This runs BEFORE the rollback trap arms, so no ANAS step has touched the node.
    if ! DEBIAN_FRONTEND=noninteractive apt-get install -y mdadm btrfs-progs; then
      err "failed to install the required packages 'mdadm' and 'btrfs-progs'."
      err "ANAS requires them for AHR (Hybrid RAID) pools — they are a hard dependency, not optional."
      err "Nothing on this node was modified (this step runs before any install action)."
      err "On an air-gapped node, preseed them first (e.g. 'apt-get install -y --no-download mdadm btrfs-progs' from a local mirror, or pre-place the .deb files) and re-run this installer."
      exit 1
    fi
    command -v mdadm      >/dev/null 2>&1 || { err "mdadm install failed (mdadm still missing) — ANAS requires it for AHR/Hybrid RAID; nothing was modified"; exit 1; }
    command -v mkfs.btrfs >/dev/null 2>&1 || { err "btrfs-progs install failed (mkfs.btrfs still missing) — ANAS requires it for AHR/Hybrid RAID; nothing was modified"; exit 1; }
    info "mdadm + btrfs-progs installed"
  fi
  if [ "${NEED_SAMBA_INSTALL}" -eq 1 ] || [ "${NEED_NFS_INSTALL}" -eq 1 ]; then
    local share_pkgs=()
    [ "${NEED_SAMBA_INSTALL}" -eq 1 ] && share_pkgs+=("samba")
    [ "${NEED_NFS_INSTALL}" -eq 1 ] && share_pkgs+=("nfs-kernel-server")
    log "Installing ${share_pkgs[*]}..."
    # noninteractive: samba's postinst debconf-prompts about the workgroup/WINS
    # configuration. Same shape as mdadm/btrfs-progs above — the share features
    # are not gated on these tools being present, so they are installed at
    # install time, never optional (issue #6). Nothing here writes smb.conf or
    # /etc/exports: the packages lay down their own defaults and ANAS edits them
    # surgically from there (PRINCIPLES.md #12 — guest, not owner).
    # This runs BEFORE the rollback trap arms, so no ANAS step has touched the node.
    if ! DEBIAN_FRONTEND=noninteractive apt-get install -y "${share_pkgs[@]}"; then
      err "failed to install the required package(s) '${share_pkgs[*]}'."
      err "ANAS requires them for SMB/NFS shares and share users — the share screens are always available, so they are a hard dependency, not optional."
      err "Nothing on this node was modified (this step runs before any install action)."
      err "On an air-gapped node, preseed them first (e.g. 'apt-get install -y --no-download ${share_pkgs[*]}' from a local mirror, or pre-place the .deb files) and re-run this installer."
      exit 1
    fi
    if [ "${NEED_SAMBA_INSTALL}" -eq 1 ]; then
      command -v smbd      >/dev/null 2>&1 || { err "samba install failed (smbd still missing) — ANAS requires it for SMB shares; nothing was modified"; exit 1; }
      command -v smbpasswd >/dev/null 2>&1 || { err "samba install failed (smbpasswd still missing) — ANAS requires it for SMB share users; nothing was modified"; exit 1; }
    fi
    if [ "${NEED_NFS_INSTALL}" -eq 1 ]; then
      command -v exportfs >/dev/null 2>&1 || { err "nfs-kernel-server install failed (exportfs still missing) — ANAS requires it for NFS exports; nothing was modified"; exit 1; }
    fi
    info "${share_pkgs[*]} installed"
    info "note: these packages enable and start their own services (smbd / nfs-server)"
  fi
  if [ "${NEED_TARGETCLI_INSTALL}" -eq 1 ]; then
    log "Installing targetcli-fb + python3-rtslib-fb..."
    # Same shape as samba/nfs above: the iSCSI screen is always available, so
    # the tooling is a hard dependency, not optional. Nothing here writes any
    # LIO configuration — the packages lay down their own empty state and ANAS
    # edits it through targetcli from there (PRINCIPLES.md #12 — guest, not
    # owner). This runs BEFORE the rollback trap arms, so no ANAS step has
    # touched the node.
    if ! DEBIAN_FRONTEND=noninteractive apt-get install -y targetcli-fb python3-rtslib-fb; then
      err "failed to install the required packages 'targetcli-fb' and 'python3-rtslib-fb'."
      err "ANAS requires them to serve iSCSI block storage (LIO) — the iSCSI screen is always available, so they are a hard dependency, not optional."
      err "Nothing on this node was modified (this step runs before any install action)."
      err "On an air-gapped node, preseed them first (e.g. 'apt-get install -y --no-download targetcli-fb python3-rtslib-fb' from a local mirror, or pre-place the .deb files) and re-run this installer."
      exit 1
    fi
    command -v targetcli >/dev/null 2>&1 \
      || { err "targetcli-fb install failed (targetcli still missing) — ANAS requires it to serve iSCSI block storage; nothing was modified"; exit 1; }
    python3 -c 'import rtslib_fb' >/dev/null 2>&1 \
      || { err "python3-rtslib-fb install failed (the rtslib_fb module is still missing) — ANAS requires it for the LIO boot restore; nothing was modified"; exit 1; }
    info "targetcli-fb + python3-rtslib-fb installed"
    # Deliberately NOT enabled or started here: the python3-rtslib-fb postinst
    # already symlinks rtslib-fb-targetctl.service into
    # multi-user.target.wants/ and starts it (it exits immediately with "No
    # saved config file at /etc/rtslib-fb-target/saveconfig.json, ok, exiting").
    # ANAS's only job on that unit is the ordering drop-in, installed in Phase 1.
    info "note: python3-rtslib-fb enables and starts rtslib-fb-targetctl.service itself"
  fi
  if [ "${NEED_RCLONE_INSTALL}" -eq 1 ]; then
    log "Installing rclone..."
    # Same shape as samba/nfs above: the Cloud screen is always available, not
    # gated on the tooling, so rclone is a hard dependency, not optional. The
    # package lays down no configuration — ANAS's own /etc/anas/rclone.conf is
    # created by the daemon on the first remote write (PRINCIPLES.md #12 —
    # guest, not owner). This runs BEFORE the rollback trap arms, so no ANAS
    # step has touched the node.
    if ! DEBIAN_FRONTEND=noninteractive apt-get install -y rclone; then
      err "failed to install the required package 'rclone'."
      err "ANAS requires it for cloud sync remotes — the Cloud screen is always available, so it is a hard dependency, not optional."
      err "Nothing on this node was modified (this step runs before any install action)."
      err "On an air-gapped node, preseed it first (e.g. 'apt-get install -y --no-download rclone' from a local mirror, or pre-place the .deb file) and re-run this installer."
      exit 1
    fi
    command -v rclone >/dev/null 2>&1 \
      || { err "rclone install failed (rclone still missing) — ANAS requires it for cloud sync remotes; nothing was modified"; exit 1; }
    info "rclone installed"
  fi
}

# =============================================================================
# PHASE 1 — transactional install (ERR trap -> rollback)
# =============================================================================
# Step-completion flags consulted by rollback(). Each rollback action tolerates
# the step not having happened (idempotent).
SERVICES_STOPPED=0
BACKUP_PATH=""
PREFIX_INSTALLED=0      # set before the copy into a PREFIX this run made (removed on rollback)
CACHE_HOOK_INSTALLED=0  # the cache hook was absent: the rollback reloads udev's rules
CACHE_RULE_INSTALLED=0  # the cache udev rule was absent: the rollback reloads udev's rules
UNITS_INSTALLED=0
SERVICES_STARTED=0
UI_INSTALLED=0
INSTALL_DONE=0

# What this run is about to overwrite OUTSIDE ${PREFIX}, read before the first
# act so a failed upgrade's rollback puts back exactly what was there (CORE-M2):
# before it, the rollback disabled anasd/anas/the recycle timer and never
# enabled them again (the restored install ran until the next reboot, then
# never started), re-installed the unit files from the NEW release, and left
# an env file --port had overwritten. Contents are held in memory (small text
# files), so nothing is written to the node to remember them.
declare -A PRIOR_FILE_CONTENT=()
declare -A PRIOR_FILE_MODE=()
declare -A PRIOR_FILE_OWNER=()   # uid:gid of the file (through a symlink)
declare -A PRIOR_LINK=()         # the path was a symlink: its target, as written
declare -A PRIOR_LINK_REAL=()    # ... and the file it resolved to
declare -A PRIOR_FILE_ACL=()     # the file's extended POSIX ACL (getfacl), when it had one
declare -A PRIOR_FILE_MTIME=()   # the file's mtime (seconds.nanoseconds), put back with its bytes
declare -A PRIOR_ABSENT=()       # nothing was at the path when the save ran
CREATED_DIRS=()                  # directories THIS run created (removed on rollback, only if empty)
CREATED_PATHS=()                 # files THIS run created where nothing was (appended as each is installed)
RESTORE_FAILED=()                # paths the rollback could not put back
PRIOR_ENABLED=()        # units enabled before this run, enabled again on rollback
PRIOR_TIMER_ACTIVE=0    # the recycle timer was running before this run
UI_WAS_PRESENT=0        # the PVE UI integration was installed before this run
ROLLBACK_SHELL_PID=""   # the shell that armed the ERR trap: the only one that rolls back

# mdadm --monitor PROGRAM hook (AHR md events -> journald). Overridable for tests.
HOOK_DEST="${HOOK_DEST:-/usr/local/bin/anas-md-event}"
# AHR read-cache removal hook + its udev rule (ahrcache.1 slice 2, AHR §13).
# The rule is INERT until a pool actually has a cache: nothing on a node carries
# a `<pool>-cacheN` GPT partition name until POST /v1/ahr/<pool>/cache writes
# one. Both paths are overridable so the packaging tests can install to a temp
# tree instead of the node's own /etc/udev.
CACHE_HOOK_DEST="${CACHE_HOOK_DEST:-/usr/local/bin/anas-cache-event}"
UDEV_RULES_DIR="${UDEV_RULES_DIR:-/etc/udev/rules.d}"
CACHE_RULE_DEST="${CACHE_RULE_DEST:-${UDEV_RULES_DIR}/99-anas-cache.rules}"

# The ANAS-owned files outside PREFIX that phase 1 overwrites (CORE-M2): the
# units and the iSCSI drop-in, the env file, the two hooks and the udev rule,
# and the notification templates.
prior_state_files() {
  local tpl
  printf '%s\n' \
    "${SYSTEMD_DIR}/anasd.service" \
    "${SYSTEMD_DIR}/anas.service" \
    "${SYSTEMD_DIR}/${RECYCLE_TIMER}" \
    "${SYSTEMD_DIR}/${RECYCLE_SERVICE}" \
    "${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}" \
    "${ANAS_ENV_FILE}" \
    "${HOOK_DEST}" \
    "${CACHE_HOOK_DEST}" \
    "${CACHE_RULE_DEST}"
  for tpl in "${NOTIFY_TEMPLATES[@]}"; do
    printf '%s\n' "${PVE_TEMPLATE_DIR:-/usr/share/pve-manager/templates/default}/${tpl}"
  done
}

# Read, before phase 1's first act, what a rollback must restore (CORE-M2):
# each file's bytes, mode, owner and (when it has one) POSIX ACL, which units
# are enabled, whether the recycle timer runs, whether the PVE UI integration
# is in place. Read-only.
#
# A path that is a SYMLINK (an env file an operator keeps elsewhere, a unit
# linked in from another tree) is remembered as the link, the file it resolves
# to, and that file's bytes, mode and owner (`stat -L`: a symlink's own mode is
# always 777). The preflight has already refused a dangling link and anything
# that is neither a file nor a link (preflight_owned_paths).
#
# A read that fails STOPS the install here, before phase 1's first act, with a
# sentence naming the file (cr3 review 2): `$(cat f; printf x)` swallowed a
# failed cat and saved empty content, which the rollback then wrote over the
# file.
save_prior_state() {
  local f content mode owner acl u
  while IFS= read -r f; do
    if [ ! -e "${f}" ] && [ ! -L "${f}" ]; then
      PRIOR_ABSENT["${f}"]=1
      continue
    fi
    if [ -L "${f}" ]; then
      if ! PRIOR_LINK["${f}"]="$(readlink -- "${f}")" || ! PRIOR_LINK_REAL["${f}"]="$(readlink -f -- "${f}")"; then
        err "cannot read the symlink ${f} — the node was NOT modified"
        exit 1
      fi
    fi
    if [ -f "${f}" ]; then
      # The trailing x keeps the file's own trailing newlines through $( ).
      if ! content="$(cat -- "${f}" && printf x)" \
         || ! mode="$(stat -L -c '%a' -- "${f}")" \
         || ! owner="$(stat -L -c '%u:%g' -- "${f}")" \
         || ! PRIOR_FILE_MTIME["${f}"]="$(stat -L -c '%.9Y' -- "${f}")"; then
        err "cannot read ${f} (a rollback could not put it back) — the node was NOT modified"
        exit 1
      fi
      PRIOR_FILE_CONTENT["${f}"]="${content%x}"
      PRIOR_FILE_MODE["${f}"]="${mode}"
      PRIOR_FILE_OWNER["${f}"]="${owner}"
      # An extended ACL (anything beyond the mode): `--skip-base` prints
      # nothing for a file that has none. Carried across a temp+rename restore.
      if command -v getfacl >/dev/null 2>&1; then
        acl="$(getfacl --skip-base --absolute-names -p -- "${f}" 2>/dev/null || true)"
        if [ -n "${acl}" ]; then
          PRIOR_FILE_ACL["${f}"]="$(getfacl --omit-header --absolute-names -p -- "${f}")"
        fi
      fi
    fi
  done < <(prior_state_files)
  for u in anasd.service anas.service "${RECYCLE_TIMER}"; do
    if systemctl is-enabled --quiet "${u}" 2>/dev/null; then
      PRIOR_ENABLED+=("${u}")
    fi
  done
  if systemctl is-active --quiet "${RECYCLE_TIMER}" 2>/dev/null; then
    PRIOR_TIMER_ACTIVE=1
  fi
  if [ -f "${PVE_JS_DIR:-/usr/share/pve-manager/js}/anas.js" ]; then
    UI_WAS_PRESENT=1
  fi
}

# The preflight half of the saved set (cr3 review 2), read-only: every path
# phase 1 writes outside the prefix must be absent, a regular file, or a
# symlink to an existing regular file. A dangling link would have phase 1
# create its target (which the rollback cannot know to remove), and a
# directory where a hook belongs would get the hook dropped inside it. Both
# are refused here, before anything is written, naming the path. A temp file
# an earlier, killed rollback left beside one of them holds that run's only
# copy of an old file: it is named (never deleted).
preflight_owned_paths() {
  local f target left
  while IFS= read -r f; do
    if [ -L "${f}" ]; then
      target="$(readlink -- "${f}" 2>/dev/null || true)"
      if [ ! -e "${f}" ]; then
        FATAL+=("${f} is a symlink to ${target:-an unreadable target}, which does not exist: ANAS would create that file through the link. Remove the link or create its target, then re-run.")
      elif [ ! -f "${f}" ]; then
        FATAL+=("${f} is a symlink to ${target}, which is not a regular file. ANAS installs a file there; move it aside, then re-run.")
      fi
    elif [ -d "${f}" ]; then
      FATAL+=("${f} is a directory. ANAS installs a file there; move the directory aside, then re-run.")
    elif [ -e "${f}" ] && [ ! -f "${f}" ]; then
      FATAL+=("${f} is not a regular file. ANAS installs a file there; move it aside, then re-run.")
    fi
    for left in "$(dirname -- "${f}")/.$(basename -- "${f}").anas-restore."*; do
      [ -e "${left}" ] || continue
      warn "${left} was left by an earlier ANAS installation that did not finish its rollback; it may hold the only copy of an old ${f}. It is left in place: compare it with ${f} and remove it when done."
    done
  done < <(prior_state_files)
}

# Phase 1 is about to write `$1` (cr3 reviews 2 and 3). When nothing is there,
# this run CREATES it, and the rollback removes it: decided from what the run
# did, never from "absent at save, present now". Something that APPEARED there
# since the save (absent then, present now) is another process's file: phase 1
# stops here, before writing over it, and rolls back.
note_if_created() {
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then
    CREATED_PATHS+=("$1")
    return 0
  fi
  if [ -n "${PRIOR_ABSENT[$1]+set}" ]; then
    err "$1 appeared while ANAS was installing (it was not there when the installation began); another process wrote it, so ANAS stops here rather than write over it."
    return 1
  fi
}

# Create directory `$1` (mode `$2`, default 0755) only when it is absent, and
# remember every directory this creates, so the rollback removes those (only if
# empty) and never touches a directory that was there: `install -d -m` re-modes
# an existing directory (cr3 review 3: 0750 became 0755, a read-only 0555 one
# writable).
ensure_dir() {
  local d="$1" mode="${2:-0755}" missing=() p
  [ -d "${d}" ] && return 0
  p="${d}"
  while [ ! -d "${p}" ]; do
    missing=("${p}" "${missing[@]}")
    p="$(dirname -- "${p}")"
  done
  for p in "${missing[@]}"; do
    mkdir -m "${mode}" -- "${p}"
    CREATED_DIRS+=("${p}")
  done
}

# Put the saved mtime of record `$2` back on `$1` when it differs (a restored
# file reads as never touched; best effort: a failure here changes nothing else).
restore_mtime() {
  [ -n "${PRIOR_FILE_MTIME[$2]+set}" ] || return 0
  [ "$(stat -L -c '%.9Y' -- "$1" 2>/dev/null)" = "${PRIOR_FILE_MTIME[$2]}" ] && return 0
  touch -m -d "@${PRIOR_FILE_MTIME[$2]}" -- "$1" 2>/dev/null || true
}

# Does regular file `$1` hold exactly bytes `$2`, mode `$3`, owner `$4`?
file_matches() {
  [ -f "$1" ] || return 1
  [ "$(stat -L -c '%a' -- "$1")" = "$3" ] || return 1
  [ "$(stat -L -c '%u:%g' -- "$1")" = "$4" ] || return 1
  cmp -s -- "$1" <(printf '%s' "$2")
}

# Put the saved bytes of `$1` (the saved-set path `$2` names the record) back
# into the file `$1`.
#
# The complete old bytes go to a temp file in the same directory first, flushed.
# Then:
#   - in place (`$3` = inplace: a file phase 1 writes in place, the units and
#     the env file): the temp's bytes are copied INTO the existing file, so its
#     inode, hard links, ACLs and xattrs stay; then mode and owner;
#   - otherwise (a file phase 1 replaced with a new inode): the temp gets the
#     mode, owner and saved ACL and is renamed over the file.
# A temp that holds the complete old bytes is KEPT when a later step fails,
# and its path is part of the not-restored record: it may be the only copy.
restore_file() {
  local f="$1" key="$2" how="$3" dir tmp
  dir="$(dirname -- "${f}")"
  [ -d "${dir}" ] || mkdir -p -- "${dir}" 2>/dev/null || { RESTORE_FAILED+=("${f}"); return 1; }
  if ! tmp="$(mktemp -- "${dir}/.$(basename -- "${f}").anas-restore.XXXXXX" 2>/dev/null)"; then
    RESTORE_FAILED+=("${f}")
    return 1
  fi
  if ! { printf '%s' "${PRIOR_FILE_CONTENT[${key}]}" > "${tmp}" && sync -f -- "${tmp}"; } 2>/dev/null; then
    rm -f -- "${tmp:?}"
    RESTORE_FAILED+=("${f}")
    return 1
  fi
  if [ "${how}" = inplace ] && [ -f "${f}" ]; then
    if cat -- "${tmp}" > "${f}" && sync -f -- "${f}" \
       && chmod "${PRIOR_FILE_MODE[${key}]}" -- "${f}" && chown "${PRIOR_FILE_OWNER[${key}]}" -- "${f}"; then
      rm -f -- "${tmp:?}"
      restore_mtime "${f}" "${key}"
      return 0
    fi
  elif chmod "${PRIOR_FILE_MODE[${key}]}" -- "${tmp}" && chown "${PRIOR_FILE_OWNER[${key}]}" -- "${tmp}" \
     && { [ -z "${PRIOR_FILE_ACL[${key}]+set}" ] || setfacl --set-file=- -- "${tmp}" <<<"${PRIOR_FILE_ACL[${key}]}"; } \
     && mv -f -T -- "${tmp}" "${f}"; then
    restore_mtime "${f}" "${key}"
    return 0
  fi
  RESTORE_FAILED+=("${f} (its old bytes are in ${tmp})")
  return 1
}

# Point `$1` at `$2` again, atomically: a link made under a unique temp name
# in the same directory (mktemp: never a fixed name another file could have),
# renamed over it.
restore_link() {
  local f="$1" tmp
  tmp="$(mktemp -- "$(dirname -- "${f}")/.$(basename -- "${f}").anas-link.XXXXXX" 2>/dev/null)" || return 1
  if ln -sfn -- "$2" "${tmp}" 2>/dev/null && mv -f -T -- "${tmp}" "${f}"; then
    return 0
  fi
  rm -f -- "${tmp:?}"
  return 1
}

# The saved-set paths phase 1 writes IN PLACE (`sed >`, `cat >`); every other
# one it replaces with a new inode (`install`).
written_in_place() {
  case "$1" in
    "${SYSTEMD_DIR}/anasd.service" | "${SYSTEMD_DIR}/anas.service" \
    | "${SYSTEMD_DIR}/${RECYCLE_TIMER}" | "${SYSTEMD_DIR}/${RECYCLE_SERVICE}" \
    | "${ANAS_ENV_FILE}") return 0 ;;
  esac
  return 1
}

# Put back every saved path that phase 1 changed, and only those:
#   - a path that was a SYMLINK:
#       * still that same link (the env file is written through it): the file
#         behind it gets its old bytes, mode and owner back, in place, if they
#         differ;
#       * replaced by a file (GNU `install` replaces a link — the hooks, the
#         udev rule, the templates, the iSCSI drop-in): re-creating the link IS
#         the whole restore; the file behind it is not written (it may be
#         another package's, updated meanwhile);
#       * re-pointed elsewhere by someone else meanwhile: THEIR link is left
#         alone, and the link — and the file it pointed to, if this run wrote
#         through the link and its bytes are not the saved ones — are named
#         as not restored (cr3 review 3);
#   - a path that was a regular file gets its old bytes, mode and owner back
#     if, and only if, any of them differ: an untouched file is not rewritten;
#     in place for the files phase 1 writes in place, by temp+rename (with
#     its ACL) for the ones it replaces (restore_file).
# A path that could not be put back is recorded in RESTORE_FAILED.
restore_prior_files() {
  local f real how
  while IFS= read -r f; do
    how=replace
    if written_in_place "${f}"; then how=inplace; fi
    if [ -n "${PRIOR_LINK[${f}]+set}" ]; then
      real="${PRIOR_LINK_REAL[${f}]}"
      if [ -L "${f}" ] && [ "$(readlink -- "${f}")" = "${PRIOR_LINK[${f}]}" ]; then
        if [ -n "${PRIOR_FILE_CONTENT[${f}]+set}" ]; then
          if file_matches "${real}" "${PRIOR_FILE_CONTENT[${f}]}" "${PRIOR_FILE_MODE[${f}]}" "${PRIOR_FILE_OWNER[${f}]}"; then
            restore_mtime "${real}" "${f}"
          else
            restore_file "${real}" "${f}" inplace
          fi
        fi
      elif [ -L "${f}" ]; then
        RESTORE_FAILED+=("${f} (re-pointed by another process to $(readlink -- "${f}") while ANAS was installing; left as it is)")
        if [ "${how}" = inplace ] && [ -n "${PRIOR_FILE_CONTENT[${f}]+set}" ] \
           && ! file_matches "${real}" "${PRIOR_FILE_CONTENT[${f}]}" "${PRIOR_FILE_MODE[${f}]}" "${PRIOR_FILE_OWNER[${f}]}"; then
          RESTORE_FAILED+=("${real} (this installation wrote it through ${f}; not restored)")
        fi
      else
        restore_link "${f}" "${PRIOR_LINK[${f}]}" || RESTORE_FAILED+=("${f}")
      fi
      continue
    fi
    if [ -n "${PRIOR_FILE_CONTENT[${f}]+set}" ]; then
      if [ ! -L "${f}" ] && file_matches "${f}" "${PRIOR_FILE_CONTENT[${f}]}" "${PRIOR_FILE_MODE[${f}]}" "${PRIOR_FILE_OWNER[${f}]}"; then
        restore_mtime "${f}" "${f}"
        continue
      fi
      [ -L "${f}" ] && how=replace
      restore_file "${f}" "${f}" "${how}"
    fi
  done < <(prior_state_files)
}

# Remove what this run created where nothing was (CREATED_PATHS): a regular
# file or a link, never anything else; then the directories it created
# (CREATED_DIRS, deepest first), each only if empty.
remove_created_paths() {
  local f i
  for f in "${CREATED_PATHS[@]}"; do
    if [ -f "${f}" ] || [ -L "${f}" ]; then
      rm -f -- "${f:?}" || RESTORE_FAILED+=("${f}")
    fi
  done
}
remove_created_dirs() {
  local i
  for ((i = ${#CREATED_DIRS[@]} - 1; i >= 0; i--)); do
    rmdir -- "${CREATED_DIRS[i]:?}" >/dev/null 2>&1 || true
  done
}

rollback() {
  # An ERR inside a command substitution or other subshell (errtrace carries the
  # trap there) must not run a second, partial rollback in that copy of the
  # shell: it fails the subshell, and the installer itself rolls back once.
  [ "${BASHPID}" = "${ROLLBACK_SHELL_PID}" ] || exit 1
  trap - ERR
  set +e
  echo >&2
  err "installation failed — rolling back..."

  # Reverse order of Phase 1.
  if [ "${UI_INSTALLED}" -eq 1 ] && [ -x "${PREFIX}/packages/pve-integration/uninstall.sh" ]; then
    info "reverting PVE UI integration"
    PVE_TPL="${PVE_TPL:-}" PVE_JS_DIR="${PVE_JS_DIR:-}" APT_HOOK="${APT_HOOK:-}" \
      "${PREFIX}/packages/pve-integration/uninstall.sh" >/dev/null 2>&1 || true
  fi

  if [ "${UNITS_INSTALLED}" -eq 1 ] || [ "${SERVICES_STARTED}" -eq 1 ]; then
    info "stopping the new units"
    systemctl disable --now anasd anas >/dev/null 2>&1 || true
    systemctl disable --now anas-recycle.timer >/dev/null 2>&1 || true
  fi

  # Every file this run CREATED where nothing was (units, hooks, the udev rule,
  # the drop-in, the env file, templates) is removed; every file it CHANGED is
  # put back, only if it differs, through a temp file (restore_prior_files).
  if [ "${#CREATED_PATHS[@]}" -gt 0 ]; then
    info "removing the files this run created"
    remove_created_paths
  fi
  restore_prior_files
  if [ "${CACHE_HOOK_INSTALLED}" -eq 1 ] || [ "${CACHE_RULE_INSTALLED}" -eq 1 ]; then
    udevadm control --reload-rules >/dev/null 2>&1 || true
  fi
  systemctl daemon-reload >/dev/null 2>&1 || true

  if [ "${PREFIX_INSTALLED}" -eq 1 ]; then
    info "removing freshly-installed ${PREFIX}"
    rm -rf -- "${PREFIX:?}"
  fi

  if [ -n "${BACKUP_PATH}" ] && [ -d "${BACKUP_PATH}" ]; then
    info "restoring previous install from backup"
    rm -rf "${PREFIX}"
    mv "${BACKUP_PATH}" "${PREFIX}" || RESTORE_FAILED+=("${PREFIX} (the previous install is still at ${BACKUP_PATH})")
  fi

  # Only the directories this run created, only if empty, after everything
  # that could have been inside them is gone (the prefix's parent too) (cr3
  # review 3: never one that was there, however empty).
  remove_created_dirs

  systemctl daemon-reload >/dev/null 2>&1 || true
  # Enabled again exactly where they were enabled before (CORE-M2: the restored
  # install used to run until the next reboot and then never start), and the
  # services this run stopped are started again; a service that was not running
  # before is left as it was.
  local u
  for u in "${PRIOR_ENABLED[@]}"; do
    systemctl enable "${u}" >/dev/null 2>&1 || true
  done
  if [ "${SERVICES_STOPPED}" -eq 1 ]; then
    info "restarting the previous anasd/anas"
    systemctl restart anasd anas >/dev/null 2>&1 || true
  fi
  if [ "${PRIOR_TIMER_ACTIVE}" -eq 1 ]; then
    systemctl start "${RECYCLE_TIMER}" >/dev/null 2>&1 || true
  fi

  # The UI integration this run's revert removed was there before it: the
  # restored install's own integration installer puts it back.
  if [ "${UI_INSTALLED}" -eq 1 ] && [ "${UI_WAS_PRESENT}" -eq 1 ] \
     && [ -x "${PREFIX}/packages/pve-integration/install.sh" ]; then
    info "re-applying the previous PVE UI integration"
    PVE_TPL="${PVE_TPL:-}" PVE_JS_DIR="${PVE_JS_DIR:-}" APT_HOOK="${APT_HOOK:-}" \
      "${PREFIX}/packages/pve-integration/install.sh" >/dev/null 2>&1 || true
  fi

  echo >&2
  if [ "${#RESTORE_FAILED[@]}" -gt 0 ]; then
    # Never "node unchanged" when something could not be put back (cr3 review 2).
    err "installation failed — rolled back, but these paths could not be restored:"
    local p
    for p in "${RESTORE_FAILED[@]}"; do
      printf '  - %s\n' "${p}" >&2
    done
    err "they hold what this installation wrote; restore them by hand."
  else
    err "installation failed — rolled back (node unchanged)."
  fi
  exit 1
}

# Copy the unit files into place, substituting PREFIX for the default /opt/anas
# ExecStart path so a custom --prefix works. daemon-reload is the caller's job.
# The recycle purge pair (smbsvc.2) rides the same substitution — its .service
# ExecStart points at the runner under PREFIX.
install_units() {
  local u
  for u in anasd anas; do
    note_if_created "${SYSTEMD_DIR}/${u}.service"
    sed "s#/opt/anas#${PREFIX}#g" "${UNIT_SRC}/${u}.service" > "${SYSTEMD_DIR}/${u}.service"
    chmod 0644 "${SYSTEMD_DIR}/${u}.service"
    # Flushed: XFS can leave a zero-length file after a power loss otherwise.
    sync -f -- "${SYSTEMD_DIR}/${u}.service"
  done
  for u in "${RECYCLE_SERVICE}" "${RECYCLE_TIMER}"; do
    note_if_created "${SYSTEMD_DIR}/${u}"
    sed "s#/opt/anas#${PREFIX}#g" "${UNIT_SRC}/${u}" > "${SYSTEMD_DIR}/${u}"
    chmod 0644 "${SYSTEMD_DIR}/${u}"
    sync -f -- "${SYSTEMD_DIR}/${u}"
  done
  install_iscsi_dropin
}

# Install the iSCSI boot-ordering drop-in (story iscsi.5).
#
# rtslib-fb-targetctl.service is python3-rtslib-fb's, and ANAS is a guest: the
# vendor unit is never edited, a drop-in is added beside it. The unit's own
# ordering stops at local-fs.target, so nothing waits for /dev/zvol/* — and a
# restore whose backing device is missing reports systemd SUCCESS while the LUN
# silently vanishes (ISCSI-GROUND-TRUTH GT-3/GT-20/GT-21). The drop-in prevents
# the race; the `iscsi` dashboard warnings catch whatever still slips through.
#
# Idempotent: a plain overwrite, so a re-run (upgrade) re-applies the current
# content over an older one. It is installed unconditionally — the unit may not
# exist yet in the same run that apt is installing the package, and a drop-in
# for a not-yet-present unit is inert, not an error. daemon-reload is the
# caller's job (Phase 1 does one for the ANAS units anyway, and it covers this).
install_iscsi_dropin() {
  note_if_created "${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}"
  ensure_dir "${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}"
  install -m 0644 "${UNIT_SRC}/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}" \
    "${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}"
}

# Health check: services active AND the gateway answers on the port. Any HTTP
# response (even 401/404) means it is up. Returns 0 if healthy.
health_check() {
  systemctl is-active --quiet anasd || { err "anasd is not active"; journalctl -u anasd -n 20 --no-pager >&2 || true; return 1; }
  systemctl is-active --quiet anas  || { err "anas is not active";  journalctl -u anas  -n 20 --no-pager >&2 || true; return 1; }

  local code="" i
  for i in $(seq 1 10); do
    # PVE certs -> HTTPS; try https first (self-signed -> -k), then http.
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://127.0.0.1:${HEALTH_PORT}/api/health" 2>/dev/null || true)"
    if [ "${code}" = "000" ] || [ -z "${code}" ]; then
      code="$(curl -s  -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${HEALTH_PORT}/api/health" 2>/dev/null || true)"
    fi
    if [ -n "${code}" ] && [ "${code}" != "000" ]; then
      info "gateway responded on :${HEALTH_PORT} (HTTP ${code})"
      return 0
    fi
    sleep 1
  done
  err "gateway did not answer on :${HEALTH_PORT} (last curl code: ${code:-none})"
  journalctl -u anas -n 20 --no-pager >&2 || true
  return 1
}

# The whole-file copy of pve-manager's index.html.tpl that older installs took
# once, as `index.html.tpl.anas-orig` (review L5, cr.61). Nothing ever read it:
# the script line is removed surgically by pve-integration/uninstall.sh, and
# the copy was never refreshed, so after a pve-manager upgrade it is a stale
# PVE file inside /usr/share/pve-manager that a by-hand "restore" would
# downgrade the UI with (the 2026-10-14 H2 hazard class, the AnyEvent.pm copy
# cr.7 retired). No copy is taken any more; one left behind is removed here,
# never used.
sweep_stale_tpl_backup() {
  local tpl="${PVE_TPL:-/usr/share/pve-manager/index.html.tpl}"
  if [ -f "${tpl}.anas-orig" ]; then
    rm -f "${tpl}.anas-orig"
    info "removed stale ${tpl}.anas-orig left by an older install (unused, never restored)"
  fi
}

phase1_install() {
  # Read what a rollback must restore BEFORE the trap arms and before the
  # first act (CORE-M2).
  save_prior_state
  ROLLBACK_SHELL_PID="${BASHPID}"
  trap rollback ERR
  log "Installing ANAS to ${PREFIX} ..."

  # 1. If PREFIX exists: stop services (if active) and back it up.
  if [ -e "${PREFIX}" ]; then
    if systemctl is-active --quiet anasd 2>/dev/null || systemctl is-active --quiet anas 2>/dev/null; then
      info "stopping running anasd/anas"
      systemctl stop anas anasd >/dev/null 2>&1 || true
      SERVICES_STOPPED=1
    fi
    BACKUP_PATH="${PREFIX}.bak.$(date +%s)"
    info "backing up existing ${PREFIX} -> ${BACKUP_PATH}"
    mv "${PREFIX}" "${BACKUP_PATH}"
  fi

  # 2. Copy app/ -> PREFIX.
  info "copying application files"
  ensure_dir "$(dirname "${PREFIX}")"
  # Set BEFORE the copy (cr3 review 3): PREFIX was absent or moved to the
  # backup, so whatever is there after a part-way copy is this run's.
  PREFIX_INSTALLED=1
  cp -a "${APP_SRC}" "${PREFIX}"
  # The tarball and this copy preserve the build host's uid/gid; everything
  # under the prefix is read or executed by root (services, the apt hook) and
  # must be root's. On an upgrade this also repairs an older install. Modes
  # are untouched — only ownership.
  chown -R root:root "${PREFIX}"
  # app/VERSION ships in the tarball since 10.10 and rides along in the copy;
  # fall back to the release-root copy so older tarball layouts still stamp it.
  if [ ! -f "${PREFIX}/VERSION" ] && [ -f "${SCRIPT_DIR}/VERSION" ]; then
    install -m 0644 "${SCRIPT_DIR}/VERSION" "${PREFIX}/VERSION"
  fi
  chmod +x "${PREFIX}/packages/pve-integration/install.sh" \
           "${PREFIX}/packages/pve-integration/uninstall.sh" \
           "${PREFIX}/packages/pve-integration/apt-reapply.sh" 2>/dev/null || true

  # 2b. Install the mdadm md-event hook (AHR §7.2). Inert until the daemon
  # wires a PROGRAM line in mdadm.conf at pool-create time. Idempotent
  # overwrite on upgrade; a fresh install's rollback removes it.
  info "installing md-event hook -> ${HOOK_DEST}"
  note_if_created "${HOOK_DEST}"
  install -m 0755 "${SCRIPT_DIR}/anas-md-event.sh" "${HOOK_DEST}"

  # 2b2. Install the AHR read-cache removal hook and its udev rule (ahrcache.1
  # slice 2, AHR §13). Unlike the md hook this one needs no wiring at pool-create
  # time: the rule matches the `<pool>-cacheN` GPT partition name the cache
  # attach writes, so it arms itself the moment a cache exists and matches
  # nothing until then. A band member's slice is labelled `<pool>-dN-bM` and can
  # never match it — those stay mdadm's business.
  info "installing AHR cache-event hook -> ${CACHE_HOOK_DEST}"
  [ -e "${CACHE_HOOK_DEST}" ] || CACHE_HOOK_INSTALLED=1
  note_if_created "${CACHE_HOOK_DEST}"
  install -m 0755 "${SCRIPT_DIR}/anas-cache-event.sh" "${CACHE_HOOK_DEST}"
  ensure_dir "${UDEV_RULES_DIR}"
  [ -e "${CACHE_RULE_DEST}" ] || CACHE_RULE_INSTALLED=1
  note_if_created "${CACHE_RULE_DEST}"
  install -m 0644 "${SCRIPT_DIR}/anas-cache.rules" "${CACHE_RULE_DEST}"
  # udev reads its rules from disk on the next reload; a failure here is not
  # fatal (the rule is live after the next boot either way, and the boot rung
  # runs the same recovery at daemon start).
  udevadm control --reload-rules >/dev/null 2>&1 || true

  # 2c. Install the ANAS notification templates (AHR §7.2, GT-17). They live
  # in pve-manager's template dir but dpkg does not own them, so a pve-manager
  # upgrade leaves them in place (seen across repeated `apt-get install
  # --reinstall pve-manager` runs in installer.1's live proof). The apt hook
  # re-runs packages/pve-integration/install.sh, NOT this installer, so nothing
  # re-installs them if they are ever removed; re-running this installer does.
  # Overridable for tests.
  PVE_TEMPLATE_DIR="${PVE_TEMPLATE_DIR:-/usr/share/pve-manager/templates/default}"
  if [ -d "$(dirname "${PVE_TEMPLATE_DIR}")" ]; then
    info "installing PVE notification templates -> ${PVE_TEMPLATE_DIR}"
    ensure_dir "${PVE_TEMPLATE_DIR}"
    for tpl in "${NOTIFY_TEMPLATES[@]}"; do
      note_if_created "${PVE_TEMPLATE_DIR}/${tpl}"
      install -m 0644 "${SCRIPT_DIR}/templates/${tpl}" "${PVE_TEMPLATE_DIR}/"
    done
  fi

  # 2d. Write the ANAS-owned gateway env file (issue #2) BEFORE the service
  # starts, so anas.service's EnvironmentFile and AnasProxy.pm both read the
  # resolved port. Track whether we created it so rollback removes only a file
  # we introduced (an upgrade's pre-existing file is left in place).
  note_if_created "${ANAS_ENV_FILE}"
  write_env_file "${RESOLVED_PORT}"

  # 3. Install units, enable, (re)start. install_units also lays down the iSCSI
  # boot-ordering drop-in (iscsi.5) — a drop-in beside the vendor unit, never an
  # edit of it — and the recycle purge timer pair (smbsvc.2), enabled once here
  # for ALL shares: the purge age lives in each stanza's marker, so there is
  # nothing per-share to create or remove, ever.
  info "installing systemd units"
  install_units
  info "installed iSCSI ordering drop-in -> ${SYSTEMD_DIR}/${ISCSI_DROPIN_DIR}/${ISCSI_DROPIN_FILE}"
  systemctl daemon-reload
  UNITS_INSTALLED=1
  systemctl enable anasd anas >/dev/null 2>&1
  systemctl enable --now anas-recycle.timer >/dev/null 2>&1
  info "recycle purge timer enabled (anas-recycle.timer, daily)"
  info "starting services"
  systemctl restart anasd anas
  SERVICES_STARTED=1

  # 4. Health check (fails -> ERR trap -> rollback).
  info "waiting for health check"
  health_check

  # 5. PVE UI integration (injection + apt hook), then verify it landed. The
  # ONLY Proxmox-owned file edited is index.html.tpl, by one surgical <script>
  # line that the uninstall removes the same way; no whole-file copy is kept
  # (see sweep_stale_tpl_backup).
  local tpl="${PVE_TPL:-/usr/share/pve-manager/index.html.tpl}"
  sweep_stale_tpl_backup
  info "installing PVE UI integration"
  # Set BEFORE the call (cr3 review): an integration installer that fails half
  # way has already changed the template, the JS or the proxy hook, and the
  # rollback reverts that partial work with the integration uninstaller.
  UI_INSTALLED=1
  "${PREFIX}/packages/pve-integration/install.sh"
  local js_dir="${PVE_JS_DIR:-/usr/share/pve-manager/js}"
  # `false`, never `return 1` (cr3 review): bash puts the CALLER's ERR trap
  # back when a function returns, so a `return 1` here left phase 1 with no
  # rollback at all; a failing command inside the body fires the trap.
  [ -f "${js_dir}/anas.js" ] || { err "UI verify: ${js_dir}/anas.js missing"; false; }
  grep -qF '/pve2/js/anas.js' "${tpl}" || { err "UI verify: script line not present in ${tpl}"; false; }
  info "UI integration verified"

  INSTALL_DONE=1
  trap - ERR
}

finish_success() {
  # Drop the backup — the new install is healthy.
  if [ -n "${BACKUP_PATH}" ] && [ -d "${BACKUP_PATH}" ]; then
    rm -rf "${BACKUP_PATH}"
  fi
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "${ip}" ] || ip="<node-ip>"
  echo
  log "ANAS ${NEW_VERSION} installed — https://${ip}:8006 (the normal PVE web UI)"
  echo
  info "ANAS panels appear inside the Proxmox web UI you already use. The API is"
  info "served through pveproxy on :8006 under /anas, so there is no separate"
  info "origin and NO extra certificate to trust — if the PVE UI loads, ANAS does."
  info "Log in to the PVE web UI and open a node to find the ANAS section."
  echo
  info "to remove: sudo ${SCRIPT_DIR}/uninstall.sh"
}

# --- main -------------------------------------------------------------------
# ANAS_INSTALL_LIB_ONLY lets the test harness source this file to exercise the
# pure helpers (port resolution, env-file writing) without running the installer.
if [ "${ANAS_INSTALL_LIB_ONLY:-0}" != "1" ]; then
  phase0_preflight
  phase0b_install_deps
  phase1_install
  finish_success
fi
