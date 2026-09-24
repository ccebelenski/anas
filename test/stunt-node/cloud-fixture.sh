#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# rclone.1 live-proof fixture — disposable state on the stunt node, never a
# new pool (there is nothing to create: the store is ANAS's own
# /etc/anas/rclone.conf, which the SPEC writes through the API and this
# fixture only backs up and restores).
#
# Builds:
#   user rclonegt / password gtpass — the remote-side target of the bounded
#   lsjson probe (an sftp remote pointing at 127.0.0.1), with ~/dst/hello.txt
#   in its home so a Test against the path `dst` has one entry to list.
#
# Password auth: probed with `sshd -T -C user=rclonegt` — the EFFECTIVE
# config, after every include — and the Match-User drop-in
# /etc/ssh/sshd_config.d/60-anas-rclonegt.conf is written ONLY when that
# config refuses it. A node that already answers password auth gets nothing.
#
# The store: `up` copies an existing /etc/anas/rclone.conf to .pre-fixture
# (once — a second up never overwrites the true pre-state) and `down`
# restores it, so a crashed spec run's remotes cannot outlive the fixture.
# When the pre-state is ABSENT (a fresh node), a sentinel records it: the
# restore on `down` is "no file", and a repeat `up` must not capture the
# store a crashed run left behind as the "before". No backup AND no sentinel
# (a `down` without an `up`) means no one knows what was there, so the store
# is left alone and it says so.
#
# Having captured the pre-state, `up` REMOVES the store: every run starts
# from no file at all, so what the spec asserts about the file is the spec's
# own writing and nothing a crashed earlier run (or an rclone shell
# detection) left behind. `down` puts the captured pre-state back and clears
# the capture files.
#
# Tolerant of a repeat ground-truth run: an existing rclonegt (right or wrong
# password) is kept and reset to the fixture credentials, never errored on.

RCLONE_USER="rclonegt"
RCLONE_PASS="gtpass"
RCLONE_CONF="/etc/anas/rclone.conf"
RCLONE_BACKUP="${RCLONE_CONF}.pre-fixture"
RCLONE_ABSENT="${RCLONE_CONF}.pre-fixture-absent"
SSHD_DROPIN="/etc/ssh/sshd_config.d/60-anas-rclonegt.conf"

usage() {
  echo "Usage: cloud-fixture.sh <up|down|status>"
  echo "  up      Create rclonegt/gtpass with ~/dst/hello.txt, the sshd drop-in (only if needed), capture the pre-state of ${RCLONE_CONF} (backup, or the absent-sentinel) and start from no store"
  echo "  down    Restore ${RCLONE_CONF} from its captured pre-state (file, or absence), remove the drop-in, userdel -r ${RCLONE_USER}"
  echo "  status  User, target file, effective sshd password auth, drop-in, store + backup"
  exit 1
}

[ $# -eq 1 ] || usage

user_exists() { $SSH_CMD "getent passwd ${RCLONE_USER}" >/dev/null 2>&1; }

# The EFFECTIVE password-auth answer for the fixture user — `sshd -T` with the
# connection context, i.e. the main config plus every include, after Match
# blocks. The only input the drop-in decision trusts.
password_auth_effective() {
  $SSH_CMD "sshd -T -C user=${RCLONE_USER},host=localhost,addr=127.0.0.1 2>/dev/null | grep -i '^passwordauthentication' | awk '{print \$2}'"
}

# Does the fixture user actually answer sftp on 127.0.0.1 with its password?
# rclone's own env-defined remote, against a THROWAWAY config (rclone persists
# its sftp shell detection into whatever --config it is handed), so this check
# leaves nothing behind. Returns non-zero while sshd is still reloading.
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
  echo "--- rclone ---"
  $SSH_CMD "command -v rclone && rclone version | head -n1 || echo 'rclone missing'"
  echo
  echo "--- user ${RCLONE_USER} ---"
  if user_exists; then
    $SSH_CMD "getent passwd ${RCLONE_USER}"
    echo
    echo "--- target file ---"
    $SSH_CMD "ls -la /home/${RCLONE_USER}/dst/ && cat /home/${RCLONE_USER}/dst/hello.txt"
    echo
    echo "--- effective password auth for ${RCLONE_USER} ---"
    password_auth_effective
    if $SSH_CMD "test -f ${SSHD_DROPIN}"; then
      echo "drop-in present: ${SSHD_DROPIN}"
    else
      echo "no sshd drop-in"
    fi
  else
    echo "no user ${RCLONE_USER}"
  fi
  echo
  echo "--- store ---"
  $SSH_CMD "ls -la ${RCLONE_CONF} ${RCLONE_BACKUP} ${RCLONE_ABSENT} 2>/dev/null || echo 'no store (yet)'"
}

case "$1" in
  up)
    echo "=== rclone.1 fixture — up ==="

    # The binary (a hard dependency since slice 2 — install.sh installs it;
    # the stunt node deploys without install.sh, so ensure it here, idempotent).
    if $SSH_CMD "command -v rclone >/dev/null 2>&1"; then
      echo "✓ rclone present"
    else
      $SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get install -y rclone"
      $SSH_CMD "command -v rclone >/dev/null 2>&1" || { echo "ERROR: rclone install failed" >&2; exit 1; }
      echo "✓ rclone installed"
    fi

    # The user: created when absent, RESET when present (a repeat ground-truth
    # run may have left it with a different password — the fixture's
    # credentials must be deterministic).
    if user_exists; then
      echo "✓ ${RCLONE_USER} already exists (resetting credentials — tolerating a repeat run)"
    else
      $SSH_CMD "useradd -m -s /bin/bash ${RCLONE_USER}"
      echo "✓ ${RCLONE_USER} created"
    fi
    $SSH_CMD "echo '${RCLONE_USER}:${RCLONE_PASS}' | chpasswd"
    $SSH_CMD "mkdir -p /home/${RCLONE_USER}/dst && printf 'hello from the rclone.1 fixture\n' > /home/${RCLONE_USER}/dst/hello.txt"
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

    # The fixture is not ready until password auth actually WORKS: a
    # `systemctl reload ssh` drops the listener for a moment, and a spec that
    # starts inside that window meets refused connections — both in its own
    # ssh calls and in the bounded lsjson probe, whose verdicts then have
    # nothing to do with what is being proven. Proven the way the probe
    # itself does it: rclone's env-defined remote against a throwaway config.
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

    # The store pre-state, captured ONCE: an existing file to .pre-fixture, or
    # the sentinel when the file is absent. A later re-up must not capture the
    # store a crashed run left behind as the "before" — and it must not CLEAR
    # a store that reappeared under a held capture: `down` would then restore
    # the OLD pre-state right over it, silently losing the file. That case is
    # refused, not absorbed.
    if $SSH_CMD "test -f ${RCLONE_ABSENT}"; then
      if $SSH_CMD "test -f ${RCLONE_CONF}"; then
        echo "ERROR: a fixture capture is already held (${RCLONE_ABSENT}) and ${RCLONE_CONF} now exists on the node — this 'up' would clear it and 'down' would then restore nothing. Run '$0 down' first." >&2
        exit 1
      fi
      echo "✓ ${RCLONE_ABSENT} present (pre-state was: no ${RCLONE_CONF} — keeping it)"
    elif $SSH_CMD "test -f ${RCLONE_BACKUP}"; then
      if $SSH_CMD "test -f ${RCLONE_CONF}"; then
        echo "ERROR: a fixture capture is already held (${RCLONE_BACKUP}) and ${RCLONE_CONF} now exists on the node — this 'up' would clear it and 'down' would restore the OLD capture over it. Run '$0 down' first." >&2
        exit 1
      fi
      echo "✓ ${RCLONE_BACKUP} already present (keeping the original pre-state)"
    elif $SSH_CMD "test -f ${RCLONE_CONF}"; then
      $SSH_CMD "cp -a ${RCLONE_CONF} ${RCLONE_BACKUP}"
      echo "✓ ${RCLONE_CONF} backed up to ${RCLONE_BACKUP}"
    else
      $SSH_CMD "touch ${RCLONE_ABSENT}"
      echo "✓ no existing ${RCLONE_CONF} (sentinel: the pre-state was absent)"
    fi

    # Now that the pre-state is safe, START FROM NOTHING: a crashed earlier
    # run's remotes — or an [anastest] section an rclone shell detection left
    # in the file — are not a "before" the spec should be reading. Idempotent:
    # a second up finds no file and removes nothing.
    $SSH_CMD "rm -f ${RCLONE_CONF}"
    echo "✓ ${RCLONE_CONF} cleared — the run starts with no store"

    echo
    echo "=== Fixture ready ==="
    status
    ;;

  down)
    echo "=== rclone.1 fixture — down ==="

    # The store: restore the pre-state when this `down` pairs with an `up` —
    # the backed-up file, or ABSENCE when the sentinel says that is what there
    # was. Neither sentinel nor backup = no `up` ran (or a prior down
    # restored) = the store is someone else's problem again; a guest does not
    # delete data it did not capture.
    if $SSH_CMD "test -f ${RCLONE_ABSENT}"; then
      $SSH_CMD "rm -f ${RCLONE_CONF} ${RCLONE_ABSENT}"
      echo "✓ ${RCLONE_CONF} removed (the pre-state was: no file)"
    elif $SSH_CMD "test -f ${RCLONE_BACKUP}"; then
      $SSH_CMD "mv -f ${RCLONE_BACKUP} ${RCLONE_CONF}"
      echo "✓ ${RCLONE_CONF} restored from ${RCLONE_BACKUP}"
    elif $SSH_CMD "test -f ${RCLONE_CONF}"; then
      echo "⚠ no ${RCLONE_BACKUP} — leaving ${RCLONE_CONF} in place (remove its remotes through the API first)"
    fi
    # The capture files are the fixture's own — none of them outlives a down.
    $SSH_CMD "rm -f ${RCLONE_CONF}.pre-fixture*"

    # The drop-in (only what we may have written — never a foreign entry).
    if $SSH_CMD "test -f ${SSHD_DROPIN}"; then
      $SSH_CMD "rm -f ${SSHD_DROPIN} && systemctl reload ssh"
      echo "✓ sshd drop-in removed and ssh reloaded"
    fi

    # The user (and its home, -r). The last bounded probe leaves an sshd
    # session for the fixture user alive for a moment, and userdel refuses
    # while one is ("user is currently used by process N"). Those processes
    # are the fixture's own, so they are asked to leave (TERM — never KILL:
    # OpenSSH 10 charges a killed session to its source address as a `crash`
    # penalty, 90 s during which 127.0.0.1 cannot log in again, which is
    # exactly what the next run's probe needs) and the removal is retried.
    if user_exists; then
      removed="no"
      for attempt in 1 2 3 4 5; do
        if $SSH_CMD "userdel -r ${RCLONE_USER}" 2>/dev/null; then
          removed="yes"
          break
        fi
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
    ;;

  status)
    status
    ;;

  *)
    usage
    ;;
esac
