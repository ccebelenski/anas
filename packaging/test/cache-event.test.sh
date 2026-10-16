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
#   6-9. Delivery is judged by the HTTP status (cr.61, review M8), against a
#      REAL curl and a fake anasd on a Unix socket (a few lines of python):
#      202 and 200 are delivered; a 403 and a 409 are CacheEventUndelivered
#      REASON=http-<code> with the daemon's sentence; no answer at all is
#      CacheEventUndelivered REASON=curl-exit-<n>. Before cr.61 every one of
#      them logged CacheEventDelivered.
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
# simulate success: a 202 body, then the --write-out status line
printf '{"job":{"id":"j1"}}\n202'
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

# ---- 6-9: the delivery verdict, real curl against a fake anasd ------------
# Only `logger` is shimmed here; curl is the node's own. The fake daemon is a
# python HTTP server bound to a Unix socket that answers every POST with the
# status it was started with and an anasd-shaped body, and records the
# request line so the test can see the request really arrived.
if ! command -v curl >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
  echo "  FAIL curl and python3 are required for the delivery cases"; FAIL=$((FAIL + 1))
else
mkdir -p "${TMP}/logonly"
cp "${TMP}/bin/logger" "${TMP}/logonly/logger"
cat > "${TMP}/fake-anasd.py" <<'PY'
import http.server, os, socketserver, sys
path, code, log = sys.argv[1], int(sys.argv[2]), sys.argv[3]
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length', 0)))
        with open(log, 'a') as f:
            f.write(self.requestline + '\n')
        if code < 300:
            body = b'{"job":{"id":"j1"}}'
        else:
            body = b'{"error":{"code":"FORBIDDEN","message":"refused by the fake daemon"}}'
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
    def address_string(self):
        return 'unix'
if os.path.exists(path):
    os.unlink(path)
socketserver.UnixStreamServer(path, Handler).serve_forever()
PY

REAL_SOCK="${TMP}/real.sock"
FAKE_PID=""
stop_fake() {
  if [ -n "${FAKE_PID}" ]; then
    kill "${FAKE_PID}" 2>/dev/null
    wait "${FAKE_PID}" 2>/dev/null
    FAKE_PID=""
  fi
  rm -f "${REAL_SOCK}"
}
start_fake() {
  stop_fake
  : > "${TMP}/fake.log"
  python3 -I "${TMP}/fake-anasd.py" "${REAL_SOCK}" "$1" "${TMP}/fake.log" &
  FAKE_PID=$!
  for _ in $(seq 1 50); do
    [ -S "${REAL_SOCK}" ] && return 0
    sleep 0.1
  done
  return 1
}
trap 'stop_fake; rm -rf "${TMP}"' EXIT

run_real() {
  : > "${TMP}/logger.log"
  PATH="${TMP}/logonly:${PATH}" ANASD_SOCKET="${REAL_SOCK}" sh "${HOOK}" "$@"
}

echo "== 6. the daemon answers 202: delivered =="
start_fake 202
run_real tank-cache1 sdd1
RC=$?
check "exit 0" test "$RC" -eq 0
check "the POST reached the fake daemon" grep -q 'POST /v1/ahr/tank/cache/event' "${TMP}/fake.log"
check "logger has Delivered with the status" grep -q 'EVENT=CacheEventDelivered POOL=tank SLICE=tank-cache1 HTTP=202' "${TMP}/logger.log"
check "no Undelivered line" bash -c "! grep -q CacheEventUndelivered '${TMP}/logger.log'"

echo "== 6b. the daemon answers 200 (nothing to recover): delivered =="
start_fake 200
run_real tank-cache1 sdd1
check "logger has Delivered HTTP=200" grep -q 'EVENT=CacheEventDelivered POOL=tank SLICE=tank-cache1 HTTP=200' "${TMP}/logger.log"

echo "== 7. the daemon answers 403: UNDELIVERED, never delivered (M8) =="
start_fake 403
run_real tank-cache1 sdd1
RC=$?
check "exit 0 (a udev RUN never fails)" test "$RC" -eq 0
check "the POST reached the fake daemon" grep -q 'POST /v1/ahr/tank/cache/event' "${TMP}/fake.log"
check "logger has Undelivered REASON=http-403" grep -q 'EVENT=CacheEventUndelivered POOL=tank SLICE=tank-cache1 REASON=http-403' "${TMP}/logger.log"
check "the daemon's sentence rides the line" grep -q 'refused by the fake daemon' "${TMP}/logger.log"
check "NO Delivered line" bash -c "! grep -q CacheEventDelivered '${TMP}/logger.log'"
check "logged at err priority" grep -q -- '-p daemon.err EVENT=CacheEventUndelivered' "${TMP}/logger.log"

echo "== 8. the daemon answers 409: UNDELIVERED REASON=http-409 =="
start_fake 409
run_real tank-cache1 sdd1
check "logger has Undelivered REASON=http-409" grep -q 'EVENT=CacheEventUndelivered POOL=tank SLICE=tank-cache1 REASON=http-409' "${TMP}/logger.log"
check "NO Delivered line" bash -c "! grep -q CacheEventDelivered '${TMP}/logger.log'"

echo "== 9. a socket nobody answers on: UNDELIVERED REASON=curl-exit-<n> =="
stop_fake
# A socket file that exists (the script's own presence check passes) with no
# listener behind it: connect() is refused, curl exits 7 with no HTTP status.
python3 -I -c "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])" "${REAL_SOCK}"
run_real tank-cache1 sdd1
RC=$?
check "exit 0" test "$RC" -eq 0
check "logger has Undelivered REASON=curl-exit-7" grep -q 'EVENT=CacheEventUndelivered POOL=tank SLICE=tank-cache1 REASON=curl-exit-7' "${TMP}/logger.log"
check "NO Delivered line" bash -c "! grep -q CacheEventDelivered '${TMP}/logger.log'"
rm -f "${REAL_SOCK}"
fi

echo
echo "cache-event tests: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
