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
# Since cr.28 the job queue refuses a request that names no privileges, so
# the script names both, as the runners do (it is root on a root-only socket).
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

# The label comes from a GPT whoever had the disk could write, and POOL goes
# into a URL path sent with root identity (review M7). POOL must satisfy the
# shared PoolName rule, ^[A-Za-z][A-Za-z0-9_-]*$ (packages/shared/src/schemas/
# common.ts — keep the two in step): a leading letter, then no character
# outside the set. In a case pattern `*` matches anything, so the set is
# checked as "no forbidden character anywhere", not as a trailing glob.
case "$POOL" in
  [A-Za-z]*) POOL_OK=1 ;;
  *) POOL_OK=0 ;;
esac
case "$POOL" in
  *[!A-Za-z0-9_-]*) POOL_OK=0 ;;
esac
if [ "$POOL_OK" -ne 1 ]; then
  logger -t "$TAG" -p daemon.info "EVENT=CacheEventIgnored LABEL=${LABEL} REASON=label-not-a-pool-name"
  exit 0
fi
case "$LABEL" in
  "${POOL}-cache"[0-9] | "${POOL}-cache"[0-9][0-9])
    ;;
  *)
    logger -t "$TAG" -p daemon.info "EVENT=CacheEventIgnored LABEL=${LABEL} REASON=label-not-a-pool-name"
    exit 0
    ;;
esac

# The kernel name ($2, udev's %k) rides the journal line as a KEY=VALUE token
# and the JSON body (cr.61r): a space or quote would break the line and a `/`
# would be no device name at all. A kernel device name is `[A-Za-z0-9_-]+` —
# checked as "no character outside the set", the POOL rule's shape; the empty
# value (the argument is optional) passes.
case "$KERNEL" in
  *[!A-Za-z0-9_-]*)
    # The bad value is NOT echoed: that is the very line this guards.
    logger -t "$TAG" -p daemon.info "EVENT=CacheEventIgnored LABEL=${LABEL} REASON=bad-argument"
    exit 0
    ;;
esac

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
# as soon as the job is queued (200 when there is nothing to recover), so the
# normal case is milliseconds.
#
# DELIVERED MEANS THE DAEMON ACCEPTED IT (review M8). curl exits 0 on ANY HTTP
# answer, so its exit status alone would log a 409 or a 503 as delivered while
# the pool keeps returning EIO. The status code is the verdict: 2xx is
# delivered; any other answer is a refusal, logged with the code and the
# daemon's own sentence (the event stays unrecovered until the next event or
# the boot rung at the next daemon start); a curl failure with no HTTP answer
# at all (the daemon died mid-request, the timeout) is logged with curl's exit
# status. The reply body is read into the journal line, flattened to one line
# and cut, never evaluated. Flattening maps EVERY control character — tab,
# newline, CR and the rest, octal \0-\37 plus DEL — to a space, not just the
# newlines (cr.61r): a tab in the body would otherwise sit inside the line and
# break the KEY=VALUE shape of everything after it.
RESP=$(curl --silent --show-error --max-time 10 \
  --unix-socket "$SOCKET" \
  --header 'content-type: application/json' \
  --header 'x-anas-user: system:udev-cache-event' \
  --header 'x-anas-user-uid: 0' \
  --header "x-anas-request-id: ${REQ_ID}" \
  --header 'x-anas-privileges: Sys.Audit,Sys.Modify' \
  --data "$BODY" \
  --write-out '\n%{http_code}' \
  "http://localhost/v1/ahr/${POOL}/cache/event" 2>/dev/null)
CURL_RC=$?
HTTP_CODE=$(printf '%s\n' "$RESP" | tail -n 1)
REPLY=$(printf '%s\n' "$RESP" | sed '$d' | tr '\0-\37\177' ' ' | cut -c1-300)

case "$HTTP_CODE" in
  2[0-9][0-9])
    logger -t "$TAG" -p daemon.info "EVENT=CacheEventDelivered POOL=${POOL} SLICE=${LABEL} HTTP=${HTTP_CODE}"
    ;;
  [1-5][0-9][0-9])
    logger -t "$TAG" -p daemon.err \
      "EVENT=CacheEventUndelivered POOL=${POOL} SLICE=${LABEL} REASON=http-${HTTP_CODE} DETAIL=${REPLY:-no-reply-body}"
    ;;
  *)
    logger -t "$TAG" -p daemon.warning \
      "EVENT=CacheEventUndelivered POOL=${POOL} SLICE=${LABEL} REASON=curl-exit-${CURL_RC} DETAIL=recovered-at-next-daemon-start"
    ;;
esac

exit 0
