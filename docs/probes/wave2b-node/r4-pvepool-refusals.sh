#!/usr/bin/env bash
# Row 4, pvepool-api tests 5-9: what the owned-dataset doors answer today (cr.47 (a)(b) moved them to
# 409 PVE_MANAGED). Each call is a refusal; nothing is created (the schedule case's accepted twin is
# not sent), and the node is read after to show that.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
say "DELETE /pools/pvfix/datasets/vm-100-disk-0"; api DELETE /pools/pvfix/datasets/vm-100-disk-0
say "PUT /pools/pvfix/datasets/subvol-101-disk-0 {compression}"; api PUT /pools/pvfix/datasets/subvol-101-disk-0 '{"properties":{"compression":"lz4"}}'
say "POST /pools/pvfix/datasets//snapshots"; api POST /pools/pvfix/datasets//snapshots '{"name":"proof-snap"}'
say "DELETE /pools/sysfix/datasets/ROOT/pve-1"; api DELETE /pools/sysfix/datasets/ROOT/pve-1
say "POST /schedules on pvfix/vm-100-disk-0"; api POST /schedules '{"id":"w2b-owned","name":"w2b owned","target":{"kind":"zfs","dataset":"pvfix/vm-100-disk-0"},"cadence":"hourly","retention":{"hourly":2},"enabled":true}'
say "node after"; node 'zfs list -H -o name -t snapshot -d 1 pvfix; ls /etc/systemd/system | grep -c w2b-owned'
