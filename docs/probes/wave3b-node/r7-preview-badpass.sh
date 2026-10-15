#!/usr/bin/env bash
# Wave-3b row 7: what does rclone write in the preview's 12 s against an sftp
# remote with a WRONG password? (cloud-tasks-api.spec.ts:640 asks for an error
# line.) A private config /tmp/w3r-rclone.conf (the node's /etc/anas/rclone.conf
# is not touched), the preview's argv shape (buildRcloneArgs + --dry-run) under
# `timeout 12`; each stderr line stamped with seconds since start. Then the
# same through the API with a throwaway remote w3rbad.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
say "rclone by hand, timeout 12, stamped stderr"
node "T=${T:-12}; zfs list -o name -r gtbackup | grep cloud; mkdir -p /tmp/w3r-src && echo x > /tmp/w3r-src/f; rclone version | head -1; P=\$(rclone obscure wrong-password); printf '[w3rbad]\ntype = sftp\nhost = 127.0.0.1\nuser = rclonegt\npass = %s\n' \"\$P\" > /tmp/w3r-rclone.conf; s=\$(date +%s.%N); timeout ${T:-12} rclone copy /tmp/w3r-src w3rbad:dst/fail --config /tmp/w3r-rclone.conf --ask-password=false --use-json-log -v --stats 30s --stats-log-level NOTICE --dry-run 2>&1 >/dev/null | while IFS= read -r l; do printf '  +%5.2fs %s\n' \"\$(echo \"\$(date +%s.%N) - \$s\" | bc)\" \"\$(echo \"\$l\" | cut -c1-220)\"; done; echo \"  exit \${PIPESTATUS[0]}\"; rm -rf /tmp/w3r-rclone.conf /tmp/w3r-src"
say "through the API: remote w3rbad, POST /cloud/tasks/preview"
r=$(api POST /cloud/remotes '{"name":"w3rbad","type":"sftp","options":{"host":"127.0.0.1","user":"rclonegt","pass":"wrong-password"}}'); echo "$r"; wait_job "$(job_of "$r")" 60
s=$(date +%s%N)
api POST /cloud/tasks/preview '{"source":"/gtbackup","remote":"w3rbad","path":"dst/fail","mode":"copy"}'
echo "  (preview answered in $(( ($(date +%s%N) - s) / 1000000 )) ms)"
WAIT_S=60 "$(dirname "$0")/../wave3-node/confirmed.sh" DELETE /cloud/remotes/w3rbad
