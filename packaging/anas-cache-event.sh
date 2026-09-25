#!/bin/sh
#
# anas-cache-event — udev RUN hook for AHR read-cache device removal
# (story ahrcache.1 slice 2, AHR-DESIGN §13 "Resolved 2026-09-24").
#
# Installed by the ANAS installer as /usr/local/bin/anas-cache-event and wired
# by /etc/udev/rules.d/99-anas-cache.rules, which matches the removal of a
# partition whose GPT name is `<pool>-cache<n>` — the label ANAS itself wrote
# when the cache was attached. A band member's slice (`<pool>-d<n>-b<band>`)
# never matches: those are mdadm's business and reach ANAS through
# anas-md-event, the --monitor PROGRAM hook this script is modelled on.
#
# Contract:
#   anas-cache-event <partition-label> [<kernel-name>]
#     $1  GPT partition name, e.g. gtcache-cache1  (udev ID_PART_ENTRY_NAME)
#     $2  kernel device name, e.g. sdd1            (udev %k) — optional
#
# WHAT IT DOES. One journald record (tag `anas-ahr`, the AHR audit convention)
# and one POST to anasd. It decides NOTHING: the daemon reads `dmsetup status`
# for itself and only recovers a cache that is really failed, so a spurious or
# replayed event costs a 200 and no work. That split is deliberate — this
# script runs from a udev RUN with no context, and the health signal it would
# have to interpret is exactly the one `lvs` gets wrong (GT-23).
#
# AUTHENTICATION is the socket (Principle 9): /run/anas/anasd.sock is mode 0600
# owned by root, so reaching the daemon at all proves local root, and the
# X-Anas-* identity headers are trusted because of that. The user string names
# the RUNG rather than a person, so the job's audit record says where it came
# from — the same shape the systemd task runners use (`root@pam`, uid 0).
#
# Exit status: 0 whatever happens (a udev RUN that fails is noise in the event
# loop and changes nothing), 64 (EX_USAGE) only when called with no label.
#
set -u

TAG="anas-ahr"
SOCKET="${ANASD_SOCKET:-/run/anas/anasd.sock}"

if [ "$#" -lt 1 ]; then
  logger -t "$TAG" -p daemon.err "EVENT=CacheUsageError DETAIL=called-with-$#-args EXPECTED=partition-label"
  exit 64
fi

LABEL="$1"
KERNEL="${2:-}"

# The pool a `<pool>-cache<n>` label belongs to. Second door behind the udev
# rule's own pattern: a label that is not ours ends here rather than at the API.
case "$LABEL" in
  *-cache[0-9] | *-cache[0-9][0-9]) ;;
  *)
    logger -t "$TAG" -p daemon.info "EVENT=CacheEventIgnored LABEL=${LABEL} REASON=not-an-anas-cache-slice"
    exit 0
    ;;
esac
POOL="${LABEL%-cache*}"
if [ -z "$POOL" ]; then
  logger -t "$TAG" -p daemon.info "EVENT=CacheEventIgnored LABEL=${LABEL} REASON=no-pool-in-label"
  exit 0
fi

LOGLINE="EVENT=CacheDeviceRemoved POOL=${POOL} SLICE=${LABEL}"
[ -n "$KERNEL" ] && LOGLINE="${LOGLINE} KERNEL=${KERNEL}"
logger -t "$TAG" -p daemon.warning "$LOGLINE"

# The daemon may legitimately not be running (an ANAS upgrade, a node shutting
# down). Say so and stop: the BOOT RUNG runs the same recovery at the next
# daemon start, so a missed event costs a delayed repair, never a lost one.
if [ ! -S "$SOCKET" ]; then
  logger -t "$TAG" -p daemon.notice \
    "EVENT=CacheEventUndelivered POOL=${POOL} REASON=daemon-socket-absent DETAIL=recovered-at-next-daemon-start"
  exit 0
fi

# A request id per event. /proc/sys/kernel/random/uuid is in the kernel and
# needs no package; `uuidgen` is the fallback for a kernel without it.
if [ -r /proc/sys/kernel/random/uuid ]; then
  REQ_ID=$(cat /proc/sys/kernel/random/uuid)
else
  REQ_ID=$(uuidgen 2>/dev/null) || REQ_ID=""
fi

# Body built with printf, never by interpolating into a shell string that is
# then eval'd — the label comes from a GPT the operator's disk carries.
BODY=$(printf '{"event":"device-removed","slice":"%s","kernel":"%s"}' "$LABEL" "$KERNEL")

# --max-time bounds this against udev's event timeout; the daemon answers 202
# as soon as the job is queued, so the normal case is milliseconds.
if curl --silent --show-error --max-time 10 \
  --unix-socket "$SOCKET" \
  --header 'content-type: application/json' \
  --header 'x-anas-user: system:udev-cache-event' \
  --header 'x-anas-user-uid: 0' \
  --header "x-anas-request-id: ${REQ_ID}" \
  --data "$BODY" \
  "http://localhost/v1/ahr/${POOL}/cache/event" >/dev/null 2>&1; then
  logger -t "$TAG" -p daemon.info "EVENT=CacheEventDelivered POOL=${POOL} SLICE=${LABEL}"
else
  logger -t "$TAG" -p daemon.warning \
    "EVENT=CacheEventUndelivered POOL=${POOL} SLICE=${LABEL} REASON=post-failed DETAIL=recovered-at-next-daemon-start"
fi

exit 0
