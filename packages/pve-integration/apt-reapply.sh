#!/usr/bin/env bash
#
# apt-reapply.sh — the body of the ANAS DPkg::Post-Invoke apt hook (story
# installer.1, GitHub #74).
#
# install.sh writes /etc/apt/apt.conf.d/80anas-pve-integration, whose one line
# runs THIS script after every dpkg transaction:
#
#   DPkg::Post-Invoke { "if [ -x <dir>/apt-reapply.sh ]; then <dir>/apt-reapply.sh || true; fi"; };
#
# It re-runs the integration installer beside it (install.sh), because a
# pve-manager upgrade overwrites index.html.tpl and a libpve-http-server-perl
# upgrade overwrites AnyEvent.pm. Before installer.1 that re-run was
# `install.sh || true` with no logging at all: a failed re-apply left no trace
# anywhere (not even in apt's term log), and the first symptom was a user filing
# a bug. This script makes it visible, through the host's own channels only
# (PRINCIPLES #15 — journald for logs, PVE notifications for alerts):
#
#   * journald, tag `anas-pve-integration`: a start line, the installer's own
#     output (stdout + stderr, one record per line), and a result line carrying
#     the exit status. `journalctl -t anas-pve-integration` shows every run.
#   * on failure, ONE PVE notification (severity warning, template/type
#     `anas-integration`) naming the manual fix — the same PVE::Notify path
#     anas-md-event uses, so it lands wherever the operator's matchers send it.
#
# It NEVER fails apt: every step is guarded and the script always exits 0 (the
# hook line keeps its `|| true` as a second belt). It does not change what the
# installer does — the perl -c gate, the coexistence rules (issue #20) and the
# idempotency all live in install.sh, untouched.
#
# The installer is captured to a temp file and logged AFTER it exits, never piped
# straight into logger: a pipe would let a missing or failing logger kill the
# installer with SIGPIPE half-way through a re-splice.
#
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="${SCRIPT_DIR}/install.sh"
TAG="anas-pve-integration"
NOTIFY_TEMPLATE="anas-integration"

# journald, best-effort: a missing logger must not stop the re-apply.
jlog() { # jlog <priority> <message>
  logger -t "${TAG}" -p "daemon.$1" -- "$2" >/dev/null 2>&1 || true
}

jlog info "EVENT=ReapplyStart TRIGGER=dpkg-post-invoke INSTALLER=${INSTALLER}"

OUT="$(mktemp 2>/dev/null)" || OUT=""
if [ ! -x "${INSTALLER}" ]; then
  STATUS=127
  jlog err "EVENT=InstallerMissing INSTALLER=${INSTALLER} DETAIL=not-found-or-not-executable"
elif [ -n "${OUT}" ]; then
  "${INSTALLER}" >"${OUT}" 2>&1 </dev/null
  STATUS=$?
  # One journald record per output line; a blank line is not worth a record.
  if [ -s "${OUT}" ]; then
    grep -v '^[[:space:]]*$' "${OUT}" | logger -t "${TAG}" -p daemon.info >/dev/null 2>&1 || true
  fi
else
  # No temp file (full /tmp?): still re-apply, say the output was not kept.
  "${INSTALLER}" >/dev/null 2>&1 </dev/null
  STATUS=$?
  jlog warning "EVENT=OutputNotCaptured DETAIL=mktemp-failed"
fi

if [ "${STATUS}" -eq 0 ]; then
  jlog info "EVENT=ReapplyResult RESULT=ok STATUS=0"
  [ -n "${OUT}" ] && rm -f "${OUT}"
  exit 0
fi

jlog warning "EVENT=ReapplyResult RESULT=failed STATUS=${STATUS} FIX=${INSTALLER}"

# The installer's own ERROR lines (at most three) ride in the notification so the
# operator sees the cause without opening a shell first.
ERRLINES=""
if [ -n "${OUT}" ] && [ -s "${OUT}" ]; then
  ERRLINES="$(grep -E 'ERROR' "${OUT}" 2>/dev/null | tail -n 3)"
fi
[ -n "${OUT}" ] && rm -f "${OUT}"

NODE="$(hostname 2>/dev/null || echo this-node)"
TITLE="PVE UI integration could not be re-applied on ${NODE}"
if [ "${STATUS}" -eq 127 ]; then
  CAUSE="The integration installer ${INSTALLER} is missing or not executable."
else
  CAUSE="The integration installer exited with status ${STATUS}."
fi
MSG="After a package upgrade or install on ${NODE}, the ANAS PVE UI integration could not be re-applied. ${CAUSE}"
[ -n "${ERRLINES}" ] && MSG="${MSG}

${ERRLINES}"
MSG="${MSG}

Until it is re-applied, the ANAS section may be missing from the Proxmox web UI and /anas requests may fail. Proxmox itself is not affected.

To fix, run as root on ${NODE}:
  ${INSTALLER}

The log of this run: journalctl -t ${TAG}"

# Same mechanism as anas-md-event and the daemon's pve-notify client: PVE::Notify
# renders the ANAS-shipped template pair and routes through the operator's own
# matchers. Arguments pass via @ARGV (no quoting surface) and are decoded from
# UTF-8 as the daemon's client does. Best-effort: a delivery failure is logged.
if perl -e 'use PVE::Notify; use Encode qw(decode); my ($sev, $title, $msg) = map { decode("UTF-8", $_, Encode::FB_DEFAULT) } @ARGV; PVE::Notify::notify($sev, "anas-integration", { title => $title, message => $msg }, { type => "anas-integration" });' \
     warning "${TITLE}" "${MSG}" >/dev/null 2>&1; then
  jlog info "EVENT=NotifySent TEMPLATE=${NOTIFY_TEMPLATE} SEVERITY=warning"
else
  jlog warning "EVENT=NotifyForwardFailed TEMPLATE=${NOTIFY_TEMPLATE}"
fi

exit 0
