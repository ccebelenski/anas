#!/usr/bin/env bash
#
# Tests for packaging/anas-cache-event.sh (cr.9 M7)
# The hook runs from udev with a GPT label, logs via logger, and POSTs to anasd
# over a Unix socket. We stub logger and curl to capture what would be sent.
#
# Covers:
#   1. Valid label tank-cache1 posts to /v1/ahr/tank/cache/event
#   2. Malicious / path-traversal label is ignored with REASON=label-not-a-pool-name
#   3. Quote injection label is ignored
#   4. Pool name starting with dash is ignored
#   5. Trailing space is ignored
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${HERE}/../anas-cache-event.sh"

PASS=0
FAIL=0
check() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  ok   ${desc}"; PASS=$((PASS + 1))
  else
    echo "  FAIL ${desc}"; FAIL=$((FAIL + 1))
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

# shims
mkdir -p "${TMP}/bin"
cat > "${TMP}/bin/logger" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "${TMP}/logger.log"
EOF
cat > "${TMP}/bin/curl" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "${TMP}/curl.log"
# simulate success
exit 0
EOF
chmod +x "${TMP}/bin/logger" "${TMP}/bin/curl"

# fake socket
SOCKET="${TMP}/anasd.sock"
python3 -c "import socket; s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.bind('$SOCKET'); s.listen(1)"

run_hook() {
  : > "${TMP}/logger.log"
  : > "${TMP}/curl.log"
  PATH="${TMP}/bin:${PATH}" ANASD_SOCKET="${SOCKET}" sh "${HOOK}" "$@"
}

echo "== 1. valid label tank-cache1 posts correctly =="
run_hook tank-cache1 sdd1
RC=$?
check "exit 0" test "$RC" -eq 0
check "logger has CacheDeviceRemoved" grep -q 'EVENT=CacheDeviceRemoved POOL=tank SLICE=tank-cache1' "${TMP}/logger.log"
check "logger has Delivered" grep -q 'EVENT=CacheEventDelivered POOL=tank SLICE=tank-cache1' "${TMP}/logger.log"
check "curl called with correct URL" grep -q 'http://localhost/v1/ahr/tank/cache/event' "${TMP}/curl.log"
check "curl data contains slice" grep -q '"slice":"tank-cache1"' "${TMP}/curl.log"
# cr.28: the job queue refuses a request that names no privileges.
check "curl names both privileges" grep -q 'x-anas-privileges: Sys.Audit,Sys.Modify' "${TMP}/curl.log"

echo "== 2. path traversal label x/../y-cache1 is ignored =="
run_hook 'x/../y-cache1'
RC=$?
check "exit 0" test "$RC" -eq 0
check "logger has Ignored" grep -q 'EVENT=CacheEventIgnored LABEL=x/../y-cache1 REASON=label-not-a-pool-name' "${TMP}/logger.log"
check "curl not called" [ ! -s "${TMP}/curl.log" ]

echo "== 3. quote injection a\"b-cache1 is ignored =="
run_hook 'a"b-cache1'
RC=$?
check "exit 0" test "$RC" -eq 0
check "logger has Ignored" grep -q 'EVENT=CacheEventIgnored LABEL=a"b-cache1 REASON=label-not-a-pool-name' "${TMP}/logger.log"
check "curl not called" [ ! -s "${TMP}/curl.log" ]

echo "== 4. pool name starting with dash -x-cache1 is ignored =="
run_hook '-x-cache1'
RC=$?
check "exit 0" test "$RC" -eq 0
check "logger has Ignored" grep -q 'EVENT=CacheEventIgnored LABEL=-x-cache1 REASON=label-not-a-pool-name' "${TMP}/logger.log"
check "curl not called" [ ! -s "${TMP}/curl.log" ]

echo "== 4b. a pool with a traversal after two good characters is ignored =="
run_hook 'ab/../x-cache1'
RC=$?
check "exit 0" test "$RC" -eq 0
check "logger has Ignored" grep -q 'EVENT=CacheEventIgnored LABEL=ab/../x-cache1 REASON=label-not-a-pool-name' "${TMP}/logger.log"
check "curl not called" [ ! -s "${TMP}/curl.log" ]

echo "== 4c. a one-letter pool name posts =="
run_hook 'a-cache1'
RC=$?
check "exit 0" test "$RC" -eq 0
check "curl called with the one-letter pool URL" grep -q 'http://localhost/v1/ahr/a/cache/event' "${TMP}/curl.log"

echo "== 5. trailing space tank-cache1  is ignored =="
run_hook 'tank-cache1 '
RC=$?
check "exit 0" test "$RC" -eq 0
check "logger has Ignored" grep -q 'EVENT=CacheEventIgnored' "${TMP}/logger.log"
check "curl not called" [ ! -s "${TMP}/curl.log" ]

echo
echo "cache-event tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
