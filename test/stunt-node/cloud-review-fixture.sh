#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# Live-proof fixture for the 2026-09-25 cloud review-fix proofs
# (tests/integration/cloud-review-fixes.spec.ts) — the token-paste
# normalisation (rclone.1) and the Run-now gate + live runningProgress
# (rclone.3), over a real anasd.
#
# DELIBERATELY DIFFERENT from cloud-fixture.sh in the one way that matters on
# this node: it NEVER touches /etc/anas/rclone.conf. That file carries the
# operator's own remote(s) — captured, cleared and restored by cloud-fixture.sh
# for its own specs — and a capture/restore cycle around a LIVE store with
# foreign remotes and an in-flight task would hide them from the daemon. The
# spec writes its remote through the API (a surgical INI section alongside
# whatever is already there) and removes it again; this fixture provides only
# the PHYSICAL half:
#
#   rclonegt / gtpass   the loopback sftp target (same shape as cloud-fixture.sh:
#                       user + ~/dst/hello.txt + an sshd drop-in ONLY when the
#                       effective config refuses password auth + the rclone
#                       env-remote probe proving sftp actually answers)
#   gtbackup/gtgatesrc  a ZFS dataset with ~40 MiB in 20 files — the long-run
#                       source. A DATASET on purpose: the run reads through a
#                       transient `anas-cloud-gtgate-<unix>` snapshot, which
#                       only a real dataset proves.
#   /home/rclonegt/gtgate-dst
#                       the sftp-side landing area (`gtsftp:gtgate-dst`),
#                       swept so the run starts against an empty destination.
#
# `sigint` is the end-the-run-without-waiting lever the long-run test pulls:
# SIGINT to the rclone child the daemon spawned (`rclone copy … gtsftp:gtgate-dst`,
# whose argv names gtgate-dst). The run then FAILS — fine, it is teardown; the
# Cancel verb itself is story rclone.5.
#
# `down` reverses all of it: the gtgate task units (only this fixture's OWN
# names — never a foreign anas-cloud unit), the dataset, the sftp landing
# areas, the drop-in and the user. The store is not ours; nothing here reads,
# writes or removes a byte of it.

RCLONE_USER="rclonegt"
RCLONE_PASS="gtpass"
SSHD_DROPIN="/etc/ssh/sshd_config.d/60-anas-rclonegt.conf"

SRC_DS="gtbackup/gtgatesrc"
SRC_PATH="/${SRC_DS}"
SRC_FILES=20
SRC_FILE_MIB=2
DST_DIR="/home/${RCLONE_USER}/gtgate-dst"

# The unit names this fixture's spec creates (`down` removes exactly these,
# plus their stamp and failed state — the sched.stamps lesson).
TASK_NAME="gtgate"

usage() {
  echo "Usage: cloud-review-fixture.sh <up|down|sigint|status>"
  echo "  up      rclonegt/gtpass with ~/dst/hello.txt (sshd drop-in only if needed), the ${SRC_DS} dataset with ${SRC_FILES} x ${SRC_FILE_MIB}MiB files, an empty ${DST_DIR}"
  echo "  down    Remove the ${TASK_NAME} units + stamp, the dataset, the sftp landing areas, the drop-in and the user — NEVER the rclone store"
  echo "  sigint  SIGINT the rclone child copying to gtgate-dst (ends the long run early)"
  echo "  status  User, dataset + file sizes, sftp tree, anas-cloud-gtgate units"
  exit 1
}

[ $# -eq 1 ] || usage

user_exists() { $SSH_CMD "getent passwd ${RCLONE_USER}" >/dev/null 2>&1; }

password_auth_effective() {
  $SSH_CMD "sshd -T -C user=${RCLONE_USER},host=localhost,addr=127.0.0.1 2>/dev/null | grep -i '^passwordauthentication' | awk '{print \$2}'"
}

# Does the fixture user actually answer sftp on 127.0.0.1 with its password?
# rclone's env-defined remote against a THROWAWAY config (rclone persists its
# sftp shell detection into whatever --config it is handed, so this check must
# not point at the live store). Returns non-zero while sshd is still reloading.
probe_ready() {
  $SSH_CMD "tmp=\$(mktemp -d) && \
RCLONE_CONFIG_ANASFIXTURE_TYPE=sftp \
RCLONE_CONFIG_ANASFIXTURE_HOST=127.0.0.1 \
RCLONE_CONFIG_ANASFIXTURE_USER=${RCLONE_USER} \
RCLONE_CONFIG_ANASFIXTURE_PASS=\$(printf %s '${RCLONE_PASS}' | rclone obscure -) \
rclone --config \$tmp/rclone.conf --ask-password=false lsjson anasfixture:dst --max-depth 1 >/dev/null 2>&1; \
rc=\$?; rm -rf \$tmp; exit \$rc" >/dev/null 2>&1
}

status() {
  echo "--- user ${RCLONE_USER} ---"
  if user_exists; then
    $SSH_CMD "getent passwd ${RCLONE_USER}"
    echo "--- dataset ---"
    $SSH_CMD "zfs list -H ${SRC_DS} 2>/dev/null || echo 'no ${SRC_DS}'"
    $SSH_CMD "ls -la ${SRC_PATH} 2>/dev/null | head -25"
    $SSH_CMD "du -sh ${SRC_PATH} 2>/dev/null || true"
    echo "--- sftp landing areas ---"
    $SSH_CMD "ls -la /home/${RCLONE_USER}/dst ${DST_DIR} 2>/dev/null || true"
    echo "--- units ---"
    $SSH_CMD "systemctl status anas-cloud-${TASK_NAME}.service --no-pager -n 0 2>/dev/null | head -3 || true"
    $SSH_CMD "ls /etc/systemd/system | grep 'anas-cloud-${TASK_NAME}' || echo 'no unit files'"
  else
    echo "no user ${RCLONE_USER}"
  fi
}

case "$1" in
  up)
    echo "=== cloud review-fix fixture — up ==="

    # The binary (install.sh installs it; the stunt node deploys without it).
    if $SSH_CMD "command -v rclone >/dev/null 2>&1"; then
      echo "✓ rclone present"
    else
      $SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get install -y rclone"
      $SSH_CMD "command -v rclone >/dev/null 2>&1" || { echo "ERROR: rclone install failed" >&2; exit 1; }
      echo "✓ rclone installed"
    fi

    # The user: created when absent, RESET when present (deterministic creds).
    if user_exists; then
      echo "✓ ${RCLONE_USER} already exists (resetting credentials — tolerating a repeat run)"
    else
      $SSH_CMD "useradd -m -s /bin/bash ${RCLONE_USER}"
      echo "✓ ${RCLONE_USER} created"
    fi
    $SSH_CMD "echo '${RCLONE_USER}:${RCLONE_PASS}' | chpasswd"
    $SSH_CMD "mkdir -p /home/${RCLONE_USER}/dst && printf 'hello from the cloud review-fix fixture\n' > /home/${RCLONE_USER}/dst/hello.txt"
    echo "✓ /home/${RCLONE_USER}/dst/hello.txt in place"

    # The drop-in, ONLY when the effective config refuses password auth.
    auth_answer="$(password_auth_effective)"
    if [ "${auth_answer}" = "no" ]; then
      $SSH_CMD "install -d -m 0755 /etc/ssh/sshd_config.d && printf 'Match User ${RCLONE_USER}\n    PasswordAuthentication yes\n' > ${SSHD_DROPIN}"
      $SSH_CMD "systemctl reload ssh"
      echo "✓ sshd refuses password auth for ${RCLONE_USER} — drop-in written and ssh reloaded"
    else
      echo "✓ password auth already effective for ${RCLONE_USER} (no drop-in)"
    fi

    # The fixture is not ready until password auth actually WORKS (a reload
    # drops the listener for a moment — same trap cloud-fixture.sh documents).
    ready="no"
    for _attempt in 1 2 3 4 5 6 7 8 9 10; do
      if probe_ready; then
        ready="yes"
        break
      fi
      sleep 2
    done
    if [ "${ready}" = "yes" ]; then
      echo "✓ ${RCLONE_USER} answers sftp on 127.0.0.1 (rclone lsjson dst)"
    else
      echo "ERROR: ${RCLONE_USER} cannot authenticate over sftp — the fixture is not ready" >&2
      exit 1
    fi

    # The long-run source dataset: rebuilt from scratch every up.
    if $SSH_CMD "zfs list -H ${SRC_DS}" >/dev/null 2>&1; then
      $SSH_CMD "zfs destroy -r ${SRC_DS}"
      echo "✓ stale ${SRC_DS} destroyed"
    fi
    $SSH_CMD "zfs create ${SRC_DS}"
    $SSH_CMD "for i in \$(seq -w 1 ${SRC_FILES}); do dd if=/dev/urandom of=${SRC_PATH}/f\$i.bin bs=1048576 count=${SRC_FILE_MIB} status=none; done && chmod -R a+r ${SRC_PATH} && sync"
    files=$($SSH_CMD "find ${SRC_PATH} -maxdepth 1 -type f | wc -l")
    size=$($SSH_CMD "du -sh ${SRC_PATH} | cut -f1")
    [ "${files}" = "${SRC_FILES}" ] || { echo "ERROR: expected ${SRC_FILES} source files, found ${files}" >&2; exit 1; }
    echo "✓ ${SRC_DS} built: ${files} files, ${size} (the ~13 min copy at --bwlimit 50k)"

    # The sftp-side landing area, swept so the run starts against an empty one.
    $SSH_CMD "rm -rf ${DST_DIR} && mkdir -p ${DST_DIR} && chown -R ${RCLONE_USER}:${RCLONE_USER} ${DST_DIR}"
    echo "✓ ${DST_DIR} swept and empty"

    echo
    echo "=== Fixture ready ==="
    status
    ;;

  sigint)
    # The daemon's rclone child: argv is `/usr/bin/rclone copy <src> gtsftp:gtgate-dst …`.
    # SIGINT — the key a user would press; the run fails, which is fine here.
    if $SSH_CMD "pgrep -f 'rclone copy .*${TASK_NAME}' >/dev/null 2>&1"; then
      $SSH_CMD "pkill -INT -f 'rclone copy .*${TASK_NAME}'"
      echo "✓ SIGINT sent to the rclone child copying to ${TASK_NAME}"
    else
      echo "⚠ no rclone child matching '${TASK_NAME}' — nothing to signal"
    fi
    ;;

  down)
    echo "=== cloud review-fix fixture — down ==="

    # End any run this fixture's spec may have left, then the unit pair (the
    # fixture's OWN task names only — a foreign anas-cloud unit is not ours).
    $SSH_CMD "pkill -INT -f 'rclone copy .*${TASK_NAME}' >/dev/null 2>&1; true"
    if $SSH_CMD "test -f /etc/systemd/system/anas-cloud-${TASK_NAME}.service -o -f /etc/systemd/system/anas-cloud-${TASK_NAME}.timer"; then
      $SSH_CMD "systemctl disable --now anas-cloud-${TASK_NAME}.timer >/dev/null 2>&1; rm -f /etc/systemd/system/anas-cloud-${TASK_NAME}.service /etc/systemd/system/anas-cloud-${TASK_NAME}.timer"
      echo "✓ anas-cloud-${TASK_NAME} units removed"
    fi
    $SSH_CMD "systemctl reset-failed anas-cloud-${TASK_NAME}.service anas-cloud-${TASK_NAME}.timer >/dev/null 2>&1; true"
    $SSH_CMD "rm -f /var/lib/systemd/timers/stamp-anas-cloud-${TASK_NAME}.timer"
    $SSH_CMD "systemctl daemon-reload"

    # The dataset (with any transient snapshot a killed run left behind).
    if $SSH_CMD "zfs list -H ${SRC_DS}" >/dev/null 2>&1; then
      $SSH_CMD "zfs destroy -r ${SRC_DS}"
      echo "✓ ${SRC_DS} destroyed"
    fi

    # The landing areas (ours; ~/dst/hello.txt is only swept of a gtgate tree).
    $SSH_CMD "rm -rf ${DST_DIR} /home/${RCLONE_USER}/dst/gtgate-dst"
    echo "✓ landing areas swept"

    # The drop-in (only what we may have written) and the user (with its home).
    if $SSH_CMD "test -f ${SSHD_DROPIN}"; then
      $SSH_CMD "rm -f ${SSHD_DROPIN} && systemctl reload ssh"
      echo "✓ sshd drop-in removed and ssh reloaded"
    fi
    if user_exists; then
      removed="no"
      for attempt in 1 2 3 4 5; do
        if $SSH_CMD "userdel -r ${RCLONE_USER}" 2>/dev/null; then
          removed="yes"
          break
        fi
        # TERM, never KILL — OpenSSH 10 charges a killed session to its source
        # address as a `crash` penalty (90 s of refused 127.0.0.1 logins).
        $SSH_CMD "pkill -TERM -u ${RCLONE_USER} >/dev/null 2>&1; true"
        sleep 2
      done
      if [ "${removed}" = "yes" ]; then
        echo "✓ ${RCLONE_USER} removed (with its home)"
      else
        echo "ERROR: ${RCLONE_USER} could not be removed (still in use)" >&2
        exit 1
      fi
    else
      echo "✓ ${RCLONE_USER} not present (skipping)"
    fi
    echo "✓ the rclone store was never touched (not ours to capture or restore)"
    ;;

  status)
    status
    ;;

  *)
    usage
    ;;
esac
