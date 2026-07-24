#!/bin/sh
#
# anas-md-event — mdadm --monitor PROGRAM hook for ANAS AHR pools.
#
# Installed by the ANAS installer as /usr/local/bin/anas-md-event and wired via
# a surgical `PROGRAM /usr/local/bin/anas-md-event` line in /etc/mdadm/mdadm.conf
# (AHR-DESIGN §7.2, GT-11: mdmonitor runs out of the box on Debian — this hook
# makes its events land somewhere useful instead of root mail).
#
# Contract (mdadm.conf(5) / mdadm --monitor):
#   anas-md-event <event> <md-device> [<member-device>]
#     $1  event name (Fail, FailSpare, DegradedArray, RebuildFinished,
#         SparesMissing, RebuildStarted, Rebuild20, NewArray, SpareActive,
#         MoveSpare, DeviceDisappeared, TestMessage, ...)
#     $2  md device the event concerns (e.g. /dev/md127)
#     $3  member device, when the event concerns one (e.g. /dev/sdb2) — optional
#
# Output: one structured journald record via logger, tag `anas-ahr`, facility
# daemon, severity mapped from the event (AHR-DESIGN §7.2 table). Message body
# is key=value fields (EVENT= DEVICE= MEMBER=) per the journald audit
# conventions.
#
# Exit status: 0 after logging (never make mdadm's monitor loop unhappy);
# 64 (EX_USAGE) only when called without the mandatory <event> <md-device>.
#
set -u

if [ "$#" -lt 2 ]; then
  logger -t anas-ahr -p daemon.err "EVENT=UsageError DETAIL=called-with-$#-args EXPECTED=event-and-md-device"
  exit 64
fi

EVENT="$1"
DEVICE="$2"
MEMBER="${3:-}"

# Severity map (AHR-DESIGN §7.2): redundancy lost / at risk -> warning,
# redundancy restored -> notice, everything informational -> info.
case "$EVENT" in
  Fail | FailSpare | DegradedArray | SparesMissing)
    PRIORITY=warning
    ;;
  RebuildFinished)
    PRIORITY=notice
    ;;
  *)
    PRIORITY=info
    ;;
esac

if [ -n "$MEMBER" ]; then
  logger -t anas-ahr -p "daemon.${PRIORITY}" "EVENT=${EVENT} DEVICE=${DEVICE} MEMBER=${MEMBER}"
else
  logger -t anas-ahr -p "daemon.${PRIORITY}" "EVENT=${EVENT} DEVICE=${DEVICE}"
fi

# Forward redundancy-affecting events through the PVE notification system
# (GT-17: PVE::Notify + the ANAS-shipped anas-ahr templates; args pass via
# @ARGV so there is no quoting/injection surface). Best-effort: a delivery
# failure is logged and swallowed — never make the monitor loop unhappy.
case "$EVENT" in
  Fail | FailSpare | DegradedArray | SparesMissing | RebuildFinished)
    NOTIFY_SEV=warning
    [ "$EVENT" = "RebuildFinished" ] && NOTIFY_SEV=info
    if [ -n "$MEMBER" ]; then
      MSG="mdadm reported ${EVENT} on ${DEVICE} (member ${MEMBER})"
    else
      MSG="mdadm reported ${EVENT} on ${DEVICE}"
    fi
    perl -e 'use PVE::Notify; my ($sev, $title, $msg) = @ARGV; PVE::Notify::notify($sev, "anas-ahr", { title => $title, message => $msg }, { type => "anas-ahr" });' \
      "$NOTIFY_SEV" "md ${EVENT}: ${DEVICE}" "$MSG" 2>/dev/null \
      || logger -t anas-ahr -p daemon.info "EVENT=NotifyForwardFailed ORIG_EVENT=${EVENT} DEVICE=${DEVICE}"
    ;;
esac

exit 0
