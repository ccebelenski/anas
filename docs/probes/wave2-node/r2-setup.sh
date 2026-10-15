#!/usr/bin/env bash
# Rows 2-4 setup (cr.28, cr.48, cr.49): the throwaway objects, all `w2` prefixed.
#   up:   dataset gtbackup/w2src (+ 20 MiB of files); nft table `inet w2bh` dropping
#         everything to 192.0.2.10 (TEST-NET-1: a peer that never answers, so a
#         connect hangs — no real remote is touched); the cloud fixture (captures
#         /etc/anas/rclone.conf, sftp user rclonegt@127.0.0.1); cloud remotes `w2ok`
#         (sftp → rclonegt@127.0.0.1) and `w2bh` (sftp → 192.0.2.10); backup repo
#         `w2bh` (→ 192.0.2.10:8007) and three backup tasks w2b1..w2b3 on it (raw
#         date schedule years out, never self-run); snapshot schedule `w2snap` on
#         gtbackup/w2src (hourly, enabled — its unit is fired by hand in row 2).
#   down: every one of them, through the API where there is a door, and the fixture.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
A="$(dirname "$0")/a.sh"
FIX="$(cd "$(dirname "$0")/../../.." && pwd)/test/stunt-node/cloud-fixture.sh"
runjob() { local out; out=$("$A" "$@" 2>&1); echo "$out" | head -3; local id; id=$(job_of "$out"); [ -n "$id" ] && "$A" wait "$id" 120 | tail -1; }
case "${1:-up}" in
up)
  say "dataset gtbackup/w2src"
  runjob POST /pools/gtbackup/datasets '{"path":"w2src"}'
  node 'zfs list -H -o name gtbackup/w2src && mkdir -p /gtbackup/w2src/d && for i in 1 2 3 4; do head -c 5M /dev/urandom > /gtbackup/w2src/d/f$i; done; du -sh /gtbackup/w2src'
  say "nft blackhole for 192.0.2.10"
  node 'nft delete table inet w2bh 2>/dev/null; nft add table inet w2bh; nft add chain inet w2bh out "{ type filter hook output priority 0; }"; nft add rule inet w2bh out ip daddr 192.0.2.10 drop; nft list table inet w2bh'
  say "cloud fixture"
  bash "$FIX" up 2>&1 | tail -3
  say "cloud remotes w2ok, w2bh"
  runjob POST /cloud/remotes '{"name":"w2ok","type":"sftp","options":{"host":"127.0.0.1","user":"rclonegt","pass":"gtpass"}}'
  runjob POST /cloud/remotes '{"name":"w2bh","type":"sftp","options":{"host":"192.0.2.10","user":"nobody","pass":"x"}}'
  say "backup repo w2bh"
  v=$(jq_ "$(json_of "$("$A" GET /backup/repos 2>/dev/null)")" data.version)
  runjob POST /backup/repos "{\"expectedVersion\":$v,\"repo\":{\"name\":\"w2bh\",\"host\":\"192.0.2.10\",\"port\":8007,\"datastore\":\"w2none\",\"authType\":\"token\",\"tokenId\":\"root@pam!w2\",\"fingerprint\":\"00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff\",\"secret\":\"00000000-0000-0000-0000-000000000000\"}}"
  for t in w2b1 w2b2 w2b3; do
    say "backup task $t"
    runjob POST /backup/tasks "{\"name\":\"$t\",\"repository\":\"w2bh\",\"backupId\":\"$t\",\"archives\":[{\"name\":\"w2data\",\"path\":\"/gtbackup/w2src\",\"excludes\":[]}],\"changeDetectionMode\":\"default\",\"notify\":\"on-failure\",\"schedule\":\"2030-01-01 00:00:00\",\"enabled\":true}"
  done
  say "snapshot schedule w2snap"
  runjob POST /schedules '{"id":"w2snap","name":"w2 node pass","target":{"kind":"zfs","dataset":"gtbackup/w2src"},"cadence":"hourly","retention":{"hourly":2},"enabled":true}'
  node 'ls /etc/systemd/system | grep -E "w2snap|w2b[123]"'
  ;;
down)
  say "schedule, tasks, repo, remotes"
  runjob DELETE /schedules/w2snap
  for t in w2b1 w2b2 w2b3; do runjob DELETE /backup/tasks/$t; done
  v=$(jq_ "$(json_of "$("$A" GET /backup/repos 2>/dev/null)")" data.version)
  r=$("$A" DELETE "/backup/repos/w2bh?expectedVersion=$v" 2>&1); echo "$r" | head -3
  c=$(code_of "$r"); [ -n "$c" ] && { r=$("$A" DELETE "/backup/repos/w2bh?expectedVersion=$v" -H "x-anas-confirm: $c" 2>&1); echo "$r" | head -2; }
  id=$(job_of "$r"); [ -n "$id" ] && "$A" wait "$id" 60 | tail -1
  for rm in w2ok w2bh; do
    r=$("$A" DELETE /cloud/remotes/$rm 2>&1); echo "$r" | head -2; c=$(code_of "$r")
    [ -n "$c" ] && r=$("$A" DELETE /cloud/remotes/$rm -H "x-anas-confirm: $c" 2>&1)
    id=$(job_of "$r"); [ -n "$id" ] && "$A" wait "$id" 60 | tail -1
  done
  say "cloud fixture down"; bash "$FIX" down 2>&1 | tail -3
  say "dataset"; node 'zfs list -H -o name -t snapshot -r gtbackup/w2src'
  confirmed DELETE '/pools/gtbackup/datasets/w2src?recursive=true' >/dev/null; [ -n "${CONFIRMED_JOB:-}" ] && "$A" wait "$CONFIRMED_JOB" 60 | tail -1
  node 'zfs list -H -o name -r gtbackup; nft delete table inet w2bh; nft list tables; ls /etc/systemd/system | grep -E "w2" || echo "no w2 units"; wc -c < /etc/anas/rclone.conf'
  ;;
esac
