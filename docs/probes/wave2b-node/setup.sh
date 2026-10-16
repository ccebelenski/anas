#!/usr/bin/env bash
# Rows 2-3 setup (cr.41b, cr.33c): the throwaway objects, all `w2b` prefixed.
#   up:   dataset gtbackup/w2bsrc (+ 8 MiB of files); nft table `inet w2bbh` dropping everything
#         to 192.0.2.10 (TEST-NET-1: a peer that never answers — no real PBS is written to);
#         backup repo `w2bbh` (→ 192.0.2.10:8007); backup tasks w2bt1..w2bt3 on it (raw date
#         schedule years out, never self-run).
#   down: every one of them, through the API where there is a door.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
A="$(dirname "$0")/a.sh"
runjob() { local out; out=$("$A" "$@" 2>&1); echo "$out" | head -3; local id; id=$(job_of "$out"); [ -n "$id" ] && "$A" wait "$id" 120 | tail -1; }
task_json() { echo "{\"name\":\"$1\",\"repository\":\"w2bbh\",\"backupId\":\"$1\",\"archives\":[{\"name\":\"w2bdata\",\"path\":\"$2\",\"excludes\":[]}],\"changeDetectionMode\":\"default\",\"notify\":\"on-failure\",\"schedule\":\"2030-01-01 00:00:00\",\"enabled\":true}"; }
case "${1:-up}" in
up)
  say "dataset gtbackup/w2bsrc"
  runjob POST /pools/gtbackup/datasets '{"path":"w2bsrc"}'
  node 'mkdir -p /gtbackup/w2bsrc/d && for i in 1 2; do head -c 4M /dev/urandom > /gtbackup/w2bsrc/d/f$i; done; du -sh /gtbackup/w2bsrc'
  say "nft blackhole for 192.0.2.10"
  node 'nft delete table inet w2bbh 2>/dev/null; nft add table inet w2bbh; nft add chain inet w2bbh out "{ type filter hook output priority 0; }"; nft add rule inet w2bbh out ip daddr 192.0.2.10 drop; nft list table inet w2bbh'
  say "backup repo w2bbh"
  v=$(jq_ "$(json_of "$("$A" GET /backup/repos 2>/dev/null)")" data.version)
  runjob POST /backup/repos "{\"expectedVersion\":$v,\"repo\":{\"name\":\"w2bbh\",\"host\":\"192.0.2.10\",\"port\":8007,\"datastore\":\"w2bnone\",\"authType\":\"token\",\"tokenId\":\"root@pam!w2b\",\"fingerprint\":\"00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff\",\"secret\":\"00000000-0000-0000-0000-000000000000\"}}"
  for t in w2bt1 w2bt2 w2bt3; do
    say "backup task $t"
    runjob POST /backup/tasks "$(task_json $t /gtbackup/w2bsrc)"
  done
  node 'ls -l /etc/systemd/system | grep -E "w2b"'
  ;;
task)  # task <name> <path> — one more task on the same repo (row 3's AHR source)
  say "backup task $2 ($3)"
  runjob POST /backup/tasks "$(task_json "$2" "$3")"
  ;;
down)
  say "tasks, repo"
  for t in $(node 'ls /etc/systemd/system' | sed -n 's/^anas-backup-\(w2b[a-z0-9-]*\)\.service$/\1/p'); do runjob DELETE /backup/tasks/$t; done
  v=$(jq_ "$(json_of "$("$A" GET /backup/repos 2>/dev/null)")" data.version)
  r=$("$A" DELETE "/backup/repos/w2bbh?expectedVersion=$v" 2>&1); echo "$r" | head -3
  c=$(code_of "$r"); [ -n "$c" ] && { r=$("$A" DELETE "/backup/repos/w2bbh?expectedVersion=$v" -H "x-anas-confirm: $c" 2>&1); echo "$r" | head -2; }
  id=$(job_of "$r"); [ -n "$id" ] && "$A" wait "$id" 60 | tail -1
  say "dataset"; node 'zfs list -H -o name -t snapshot -r gtbackup/w2bsrc'
  confirmed DELETE '/pools/gtbackup/datasets/w2bsrc?recursive=true' >/dev/null; [ -n "${CONFIRMED_JOB:-}" ] && "$A" wait "$CONFIRMED_JOB" 60 | tail -1
  node 'zfs list -H -o name -r gtbackup; nft delete table inet w2bbh; nft list tables; ls /etc/systemd/system /run/systemd/system | grep -E "w2b" || echo "no w2b units"'
  ;;
esac
