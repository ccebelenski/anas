#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# Live-proof fixture for cloudproof.1 (tests/integration/cloud-backends.spec.ts)
# — the four NON-OAuth curated backends exercised against real loopback
# servers, none of them needing a cloud account:
#
#   s3      versitygw (Apache-2, one static binary, /opt/anas-test/versitygw)
#           as transient unit anas-gt-s3 on 127.0.0.1:7070, posix backend,
#           fixed root keys gtaccess/gtsecret123, bucket = the directory
#           gtbucket under /opt/anas-test/s3-data.
#           (MinIO was ruled out by the operator 2026-09-26; the earlier
#           attempt's fallback garage binary stays on disk but is not used.)
#   smb     the node's OWN Samba: the fixture user gtsmbuser and the share
#           gtsmbshare on /var/tmp/anas-gtsmb are created through the ANAS
#           API (identity + shares routes) — the API is the only writer of
#           smb.conf, same as any other client of the product.
#   webdav  `rclone serve webdav` (1.60 has it) as anas-gt-webdav on
#           127.0.0.1:8087, user gtdav / pass gtdavpass.
#   ftp     rclone 1.60 has NO `serve ftp` (its serve subcommands are dlna,
#           docker, http, restic, sftp, webdav — captured 2026-09-27), so the
#           server here is python3-pyftpdlib (Debian's apt package, no config
#           file, transient unit anas-gt-ftp) on 127.0.0.1:2121, user gtftp /
#           pass gtftppass. The rclone FTP REMOTE (the client the product
#           drives) is exercised all the same.
#
# Shared by all four profiles: the copy-task source directory
# /var/tmp/anas-gtcloud-src — 12 small files plus scratch.tmp, the file the
# task's `*.tmp` exclude must keep off every destination.
#
# `down` reverses ALL of it and SAYS SO: each check prints a ✓ line (unit
# gone, directory gone, no leftover server process, and on smb the user and
# share gone). The s3 profile's down keeps the binaries; everything else goes.
# Nothing here touches the operator's remote gtest, their task testoff, the
# existing shares/users, or the gtbackup/gtiscsi pools — every name this
# fixture creates starts with gtcloud-, gtsmb, gtdav, gtftp or gtaccess/
# gtsecret123 (the latter only inside the fixture's own S3 server).

S3_BIN="/opt/anas-test/versitygw"
S3_UNIT="anas-gt-s3"
S3_PORT="7070"
S3_DATA="/opt/anas-test/s3-data"
S3_BUCKET="gtbucket"
S3_ACCESS="gtaccess"
S3_SECRET="gtsecret123"
S3_REGION="us-east-1"

SMB_USER="gtsmbuser"
SMB_PASS="gtsmbpass"
SMB_SHARE="gtsmbshare"
SMB_DIR="/var/tmp/anas-gtsmb"

WEBDAV_UNIT="anas-gt-webdav"
WEBDAV_PORT="8087"
WEBDAV_USER="gtdav"
WEBDAV_PASS="gtdavpass"
WEBDAV_DIR="/var/tmp/anas-gtwebdav"

FTP_UNIT="anas-gt-ftp"
FTP_PORT="2121"
FTP_USER="gtftp"
FTP_PASS="gtftppass"
FTP_DIR="/var/tmp/anas-gtftp"

SRC_DIR="/var/tmp/anas-gtcloud-src"
SRC_FILES=12

usage() {
  echo "Usage: cloud-backends-fixture.sh <up|down|status> [s3|smb|webdav|ftp]"
  echo "  up      (re)create the profile's loopback server + the shared source dir"
  echo "  down    Remove the profile's unit, dirs, and server process — verifying each"
  echo "  status  What of the profile is on the node right now"
  echo "  No profile argument = all four."
  exit 1
}

[ $# -ge 1 ] && [ $# -le 2 ] || usage
VERB="$1"
case "${2:-all}" in
  all)    PROFILES="s3 smb webdav ftp" ;;
  s3|smb|webdav|ftp) PROFILES="$2" ;;
  *)      usage ;;
esac

# --- the ANAS API over the node's loopback (the fixture's smb half) ----------
# The daemon is reached through pveproxy's /anas forward with a PVE ticket —
# the same door the specs use from the outside; here it just runs on the node.

api_ticket() {
  $SSH_CMD "curl -sk -d 'username=root@pam&password=anas-test' https://127.0.0.1:8006/api2/json/access/ticket \
    | sed 's/.*\"ticket\":\"\([^\"]*\)\".*/\1/'"
}

# api_call METHOD PATH [JSON-BODY] → stdout, with the HTTP code prefixed.
api_call() {
  local method="$1" path="$2" body="${3:-}" extra="${4:-}"
  method="${method^^}"
  $SSH_CMD "curl -sk -b 'PVEAuthCookie=$TICKET' -H 'Content-Type: application/json' \
    ${body:+-d '$body'} ${extra:+-H '$extra'} -X $method -w '\n%{http_code}' \
    https://127.0.0.1:8006/anas/api/nodes/anas-pve/v1$path"
}

# POST/PUT/DELETE a mutation and wait for its job to reach a terminal state.
# A 409 CONFIRMATION_REQUIRED (Principle 14) is answered the way a client
# must: re-request to collect the minted X-Anas-Confirm-Code, resend with it.
api_mutate() {
  local method="$1" path="$2" body="${3:-}" out code jobid status conf hdr
  out="$(api_call "$method" "$path" "$body")"
  code="${out##*$'\n'}"
  if [ "$code" = "409" ] && printf '%s' "$out" | grep -q CONFIRMATION_REQUIRED; then
    hdr="$($SSH_CMD "curl -sk -b 'PVEAuthCookie=$TICKET' -H 'Content-Type: application/json' \
      ${body:+-d '$body'} -X ${method^^} -D - -o /dev/null \
      https://127.0.0.1:8006/anas/api/nodes/anas-pve/v1$path" | tr -d '\r')"
    conf="$(printf '%s\n' "$hdr" | sed -n 's/^[Xx]-[Aa]nas-[Cc]onfirm-[Cc]ode: *//p')"
    [ -n "$conf" ] || { echo "ERROR: 409 without a confirm code for $method $path" >&2; return 1; }
    out="$(api_call "$method" "$path" "$body" "x-anas-confirm: $conf")"
    code="${out##*$'\n'}"
  fi
  if [ "$code" != "202" ]; then
    echo "ERROR: API $method $path answered $code: ${out%$'\n'*}" >&2
    return 1
  fi
  jobid="$(printf '%s' "${out%$'\n'*}" | sed 's/.*\"job\":{\"id\":\"\([^\"]*\)\".*/\1/')"
  for _ in $(seq 1 30); do
    status="$($SSH_CMD "curl -sk -b 'PVEAuthCookie=$TICKET' \
      https://127.0.0.1:8006/anas/api/nodes/anas-pve/v1/jobs/$jobid" \
      | jq -r '.job.status // empty')"
    [ "$status" = "completed" ] && return 0
    [ "$status" = "failed" ] && { echo "ERROR: job for $method $path failed" >&2; return 1; }
    sleep 1
  done
  echo "ERROR: job for $method $path did not finish" >&2
  return 1
}

# unit_down UNIT — stop a transient unit, reset its failed state, prove it gone.
unit_down() {
  local unit="$1"
  $SSH_CMD "systemctl stop $unit >/dev/null 2>&1; systemctl reset-failed $unit >/dev/null 2>&1; true"
  if $SSH_CMD "systemctl status $unit >/dev/null 2>&1"; then
    echo "✗ $unit still present"; return 1
  fi
  echo "✓ $unit stopped and gone"
}

# unit_up UNIT CMD… — systemd-run a transient unit, retrying the readiness probe.
unit_up() {
  local unit="$1" cmd="$2" probe="$3"
  $SSH_CMD "systemd-run --unit $unit $cmd" >/dev/null
  local ok="no"
  for _ in $(seq 1 10); do
    if $SSH_CMD "$probe" >/dev/null 2>&1; then ok="yes"; break; fi
    sleep 1
  done
  if [ "$ok" != "yes" ]; then
    echo "ERROR: $unit never answered its readiness probe" >&2
    $SSH_CMD "journalctl -u $unit -n 20 --no-pager" >&2 || true
    return 1
  fi
  echo "✓ $unit serving (probe answered)"
}

# src_up / src_down — the shared copy-task source.
src_up() {
  $SSH_CMD "rm -rf $SRC_DIR && mkdir -p $SRC_DIR && for i in \$(seq -w 1 $SRC_FILES); do \
    printf 'fixture file %s\n' \$i > $SRC_DIR/f\$i.txt; done \
    && printf 'to be excluded\n' > $SRC_DIR/scratch.tmp && chmod -R a+r $SRC_DIR"
  local n
  n="$($SSH_CMD "find $SRC_DIR -type f | wc -l")"
  [ "$n" = "$((SRC_FILES + 1))" ] || { echo "ERROR: source dir has $n files, expected $((SRC_FILES + 1))" >&2; return 1; }
  echo "✓ $SRC_DIR built: $SRC_FILES files + scratch.tmp"
}

src_down() {
  $SSH_CMD "rm -rf $SRC_DIR"
  if $SSH_CMD "test -e $SRC_DIR"; then echo "✗ $SRC_DIR still present"; return 1; fi
  echo "✓ $SRC_DIR removed"
}

# rclone env-remote probes against the node's OWN rclone binary. A probe config
# must be a THROWAWAY file (rclone persists shell detection into --config) and
# password-typed values must be OBSCURED (exactly what the daemon does for the
# remotes the spec writes through the API).

up_s3() {
  # The binary: install on demand, never re-download when present.
  if ! $SSH_CMD "test -x $S3_BIN"; then
    echo "  installing versitygw (was absent)"
    $SSH_CMD "mkdir -p /opt/anas-test /tmp/anas-vgw && cd /tmp/anas-vgw \
      && curl -fsSL -o vgw.tgz https://github.com/versity/versitygw/releases/download/v1.8.0/versitygw_v1.8.0_Linux_x86_64.tar.gz \
      && tar xzf vgw.tgz && cp versitygw_v*/versitygw $S3_BIN && chmod +x $S3_BIN && cd / && rm -rf /tmp/anas-vgw" \
      || { echo "ERROR: versitygw install failed" >&2; return 1; }
  fi
  unit_down "$S3_UNIT" || return 1
  $SSH_CMD "rm -rf $S3_DATA && mkdir -p $S3_DATA/$S3_BUCKET"
  unit_up "$S3_UNIT" \
    "-p Environment=ROOT_ACCESS_KEY=$S3_ACCESS -p Environment=ROOT_SECRET_KEY=$S3_SECRET $S3_BIN --port 127.0.0.1:$S3_PORT posix $S3_DATA" \
    "tmp=\$(mktemp -d) && RCLONE_CONFIG_GTPROBE_TYPE=s3 RCLONE_CONFIG_GTPROBE_PROVIDER=Other \
     RCLONE_CONFIG_GTPROBE_ACCESS_KEY_ID=$S3_ACCESS RCLONE_CONFIG_GTPROBE_SECRET_ACCESS_KEY=$S3_SECRET \
     RCLONE_CONFIG_GTPROBE_ENDPOINT=http://127.0.0.1:$S3_PORT RCLONE_CONFIG_GTPROBE_REGION=$S3_REGION \
     rclone --config \$tmp/rclone.conf lsd gtprobe: >/dev/null 2>&1; rc=\$?; rm -rf \$tmp; exit \$rc" \
    || return 1
  echo "✓ S3 bucket $S3_BUCKET present (a directory under $S3_DATA)"
  src_up
}

down_s3() {
  unit_down "$S3_UNIT" || return 1
  $SSH_CMD "rm -rf $S3_DATA"
  if $SSH_CMD "test -e $S3_DATA"; then echo "✗ $S3_DATA still present"; return 1; fi
  echo "✓ $S3_DATA removed (the binary $S3_BIN stays)"
  if $SSH_CMD "pgrep -f versityg[w] >/dev/null 2>&1"; then
    echo "✗ a versitygw process survived"; return 1
  fi
  echo "✓ no leftover versitygw process"
  src_down
}

status_s3() {
  echo "--- s3 ---"
  if $SSH_CMD "test -x $S3_BIN"; then
    echo "server binary: versitygw ($($SSH_CMD "$S3_BIN --version 2>/dev/null | head -1"))"
  elif $SSH_CMD "test -x /opt/anas-test/garage"; then
    echo "server binary: garage fallback (versitygw absent)"
  else
    echo "server binary: NONE"
  fi
  $SSH_CMD "systemctl is-active $S3_UNIT 2>/dev/null || echo 'unit inactive'"
  $SSH_CMD "ls $S3_DATA 2>/dev/null || echo 'no $S3_DATA'"
}

up_smb() {
  TICKET="$(api_ticket)"
  # Idempotent: a leftover share (a crashed earlier up/spec) is removed
  # through the API BEFORE the directory it points at is rebuilt.
  if $SSH_CMD "curl -sk -b 'PVEAuthCookie=$TICKET' https://127.0.0.1:8006/anas/api/nodes/anas-pve/v1/shares/smb" \
      | grep -q "\"name\":\"$SMB_SHARE\""; then
    api_mutate delete "/shares/smb/$SMB_SHARE" || return 1
    echo "✓ leftover share $SMB_SHARE removed through the API"
  fi
  # The directory first (the share create stats its path).
  $SSH_CMD "rm -rf $SMB_DIR && mkdir -p $SMB_DIR && chmod 777 $SMB_DIR"
  # The user (with its SMB passdb entry), then the share, both through the API.
  if $SSH_CMD "curl -sk -b 'PVEAuthCookie=$TICKET' https://127.0.0.1:8006/anas/api/nodes/anas-pve/v1/identity/users" \
      | grep -q "\"name\":\"$SMB_USER\""; then
    echo "  $SMB_USER already exists (leaving it — the share up re-uses it)"
  else
    api_mutate post /identity/users "{\"name\":\"$SMB_USER\",\"smbPassword\":\"$SMB_PASS\"}" \
      || return 1
    echo "✓ user $SMB_USER created through the API (with its passdb entry)"
  fi
  api_mutate post "/shares/smb" "{\"name\":\"$SMB_SHARE\",\"path\":\"$SMB_DIR\",\"validUsers\":[\"$SMB_USER\"]}" \
    || return 1
  echo "✓ share $SMB_SHARE created through the API (valid users = $SMB_USER, writable)"
  # The share actually answers: smbclient lists the share root with the password.
  local ok="no"
  for _ in $(seq 1 10); do
    if $SSH_CMD "smbclient //127.0.0.1/$SMB_SHARE -U $SMB_USER%$SMB_PASS -c 'ls' >/dev/null 2>&1"; then ok="yes"; break; fi
    sleep 1
  done
  [ "$ok" = "yes" ] || { echo "ERROR: smbclient cannot list //$SMB_SHARE" >&2; return 1; }
  echo "✓ smbclient lists //$SMB_SHARE as $SMB_USER"
  src_up
}

down_smb() {
  TICKET="$(api_ticket)"
  # Share first: the user delete refuses while a share names it in valid users.
  if $SSH_CMD "curl -sk -b 'PVEAuthCookie=$TICKET' https://127.0.0.1:8006/anas/api/nodes/anas-pve/v1/shares/smb" \
      | grep -q "\"name\":\"$SMB_SHARE\""; then
    api_mutate delete "/shares/smb/$SMB_SHARE" || return 1
  fi
  if $SSH_CMD "grep -q '\\[$SMB_SHARE\\]' /etc/samba/smb.conf 2>/dev/null"; then
    echo "✗ share $SMB_SHARE still in smb.conf"; return 1
  fi
  echo "✓ share $SMB_SHARE removed (absent from smb.conf)"
  if $SSH_CMD "getent passwd $SMB_USER >/dev/null 2>&1"; then
    api_mutate delete "/identity/users/$SMB_USER" || return 1
  fi
  if $SSH_CMD "getent passwd $SMB_USER >/dev/null 2>&1 || pdbedit -L 2>/dev/null | grep -q \"^$SMB_USER:\""; then
    echo "✗ user $SMB_USER still present"; return 1
  fi
  echo "✓ user $SMB_USER removed (passwd + passdb)"
  $SSH_CMD "rm -rf $SMB_DIR"
  if $SSH_CMD "test -e $SMB_DIR"; then echo "✗ $SMB_DIR still present"; return 1; fi
  echo "✓ $SMB_DIR removed"
  src_down
}

status_smb() {
  echo "--- smb ---"
  TICKET="$(api_ticket)"
  $SSH_CMD "curl -sk -b 'PVEAuthCookie=$TICKET' https://127.0.0.1:8006/anas/api/nodes/anas-pve/v1/shares/smb" \
    | grep -o "\"name\":\"$SMB_SHARE\"" || echo "no $SMB_SHARE share"
  $SSH_CMD "getent passwd $SMB_USER || echo 'no $SMB_USER'"
  $SSH_CMD "ls -ld $SMB_DIR 2>/dev/null || echo 'no $SMB_DIR'"
}

up_webdav() {
  unit_down "$WEBDAV_UNIT" || return 1
  $SSH_CMD "rm -rf $WEBDAV_DIR && mkdir -p $WEBDAV_DIR"
  unit_up "$WEBDAV_UNIT" \
    "rclone serve webdav $WEBDAV_DIR --addr 127.0.0.1:$WEBDAV_PORT --user $WEBDAV_USER --pass $WEBDAV_PASS" \
    "curl -su $WEBDAV_USER:$WEBDAV_PASS -X PROPFIND -H 'Depth: 1' http://127.0.0.1:$WEBDAV_PORT/ -o /dev/null -w '%{http_code}' | grep -q 207" \
    || return 1
  src_up
}

down_webdav() {
  unit_down "$WEBDAV_UNIT" || return 1
  $SSH_CMD "rm -rf $WEBDAV_DIR"
  if $SSH_CMD "test -e $WEBDAV_DIR"; then echo "✗ $WEBDAV_DIR still present"; return 1; fi
  echo "✓ $WEBDAV_DIR removed"
  if $SSH_CMD "pgrep -f 'serve webda[v]' >/dev/null 2>&1"; then
    echo "✗ a webdav server process survived"; return 1
  fi
  echo "✓ no leftover webdav server process"
  src_down
}

status_webdav() {
  echo "--- webdav ---"
  $SSH_CMD "systemctl is-active $WEBDAV_UNIT 2>/dev/null || echo 'unit inactive'"
  $SSH_CMD "curl -su $WEBDAV_USER:$WEBDAV_PASS -X PROPFIND http://127.0.0.1:$WEBDAV_PORT/ -o /dev/null -w '%{http_code}\n' 2>/dev/null || echo 'no answer'"
  $SSH_CMD "ls -ld $WEBDAV_DIR 2>/dev/null || echo 'no $WEBDAV_DIR'"
}

up_ftp() {
  unit_down "$FTP_UNIT" || return 1
  if ! $SSH_CMD "python3 -c 'import pyftpdlib' >/dev/null 2>&1"; then
    echo "  installing python3-pyftpdlib (was absent)"
    $SSH_CMD "DEBIAN_FRONTEND=noninteractive apt-get install -y python3-pyftpdlib" >/dev/null \
      || { echo "ERROR: python3-pyftpdlib install failed" >&2; return 1; }
  fi
  $SSH_CMD "rm -rf $FTP_DIR && mkdir -p $FTP_DIR"
  unit_up "$FTP_UNIT" \
    "python3 -m pyftpdlib -i 127.0.0.1 -p $FTP_PORT -d $FTP_DIR -u $FTP_USER -P $FTP_PASS -w" \
    "tmp=\$(mktemp -d) && RCLONE_CONFIG_GTPROBE_TYPE=ftp RCLONE_CONFIG_GTPROBE_HOST=127.0.0.1 \
     RCLONE_CONFIG_GTPROBE_PORT=$FTP_PORT RCLONE_CONFIG_GTPROBE_USER=$FTP_USER \
     RCLONE_CONFIG_GTPROBE_PASS=\$(printf %s '$FTP_PASS' | rclone obscure -) \
     rclone --config \$tmp/rclone.conf lsd gtprobe: >/dev/null 2>&1; rc=\$?; rm -rf \$tmp; exit \$rc" \
    || return 1
  # The task's landing dir, PRE-CREATED: pyftpdlib answers `501 No such
  # directory` (not the standard 550) to a LIST of a missing path, and rclone
  # 1.60's ftp backend then cannot treat the destination as creatable
  # (captured live 2026-09-27 — the run failed with "error reading destination
  # root directory: 501 No such directory" before any MKD). rclone creates
  # this fine against its own webdav/s3 servers; it is a pyftpdlib quirk.
  $SSH_CMD "mkdir -p $FTP_DIR/proof"
  echo "✓ $FTP_DIR/proof landing dir pre-created"
  src_up
}

down_ftp() {
  unit_down "$FTP_UNIT" || return 1
  $SSH_CMD "rm -rf $FTP_DIR"
  if $SSH_CMD "test -e $FTP_DIR"; then echo "✗ $FTP_DIR still present"; return 1; fi
  echo "✓ $FTP_DIR removed"
  if $SSH_CMD "pgrep -f 'pyftpdl[i]b' >/dev/null 2>&1"; then
    echo "✗ an ftp server process survived"; return 1
  fi
  echo "✓ no leftover ftp server process"
  src_down
}

status_ftp() {
  echo "--- ftp ---"
  $SSH_CMD "systemctl is-active $FTP_UNIT 2>/dev/null || echo 'unit inactive'"
  $SSH_CMD "ls -ld $FTP_DIR 2>/dev/null || echo 'no $FTP_DIR'"
}

case "$VERB" in
  up)
    for p in $PROFILES; do
      echo "=== cloud backends fixture — up $p ==="
      "up_$p"
    done
    ;;
  down)
    rc=0
    for p in $PROFILES; do
      echo "=== cloud backends fixture — down $p ==="
      "down_$p" || rc=1
    done
    exit $rc
    ;;
  status)
    for p in $PROFILES; do "status_$p"; done
    ;;
  *)
    usage
    ;;
esac
