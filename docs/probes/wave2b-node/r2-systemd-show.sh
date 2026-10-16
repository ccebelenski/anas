#!/usr/bin/env bash
# Row 2 (cr.41b) — systemd's own answers on the node (PVE 9, systemd 257). The daemon's strict
# read is `systemctl show <unit> -p ActiveState,InactiveExitTimestamp` with TZ=UTC
# (unit-run-status.ts execSystemctlShow / showUnitPropsStrict): exit code != 0 → refuse.
#   (i)   a stored, loadable ANAS task unit (anas-backup-w2bt1.service, made by setup.sh)
#   (ii)  unit files that exist but systemd cannot load — throwaway copies under /run/systemd/system,
#         removed at the end:  w2bbad-a  relative ExecStart        w2bbad-b  [Service] with no ExecStart
#                              w2bbad-c  a garbled section header   w2bbad-d  an unknown Type=
#                              w2bbad-e  a zero-byte file           w2bbad-f  a symlink to /dev/null (masked)
#   (iii) a nonexistent unit (anas-backup-w2bnope.service)
#   (iv)  a template name with no instance (anas-backup-@.service, w2bbad@.service)
# Each: the daemon's exact argv, then the same with -p LoadState,LoadError for context.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
node 'bash -s' <<'NODE'
set -u
W=/var/tmp/w2b; mkdir -p $W
cap() { local out err rc; out=$(mktemp -p $W); err=$(mktemp -p $W); "$@" >"$out" 2>"$err"; rc=$?
  echo "\$ $*"; echo "exit code: $rc"; echo "stdout:"; sed "s/^/  | /" "$out"; echo "stderr:"; sed "s/^/  | /" "$err"; rm -f "$out" "$err"; }
both() { cap env TZ=UTC systemctl show "$1" -p ActiveState,InactiveExitTimestamp; cap systemctl show "$1" -p ActiveState; cap systemctl show "$1" -p LoadState,LoadError; }
R=/run/systemd/system
printf '[Service]\nType=oneshot\nExecStart=true\n' > $R/w2bbad-a.service
printf '[Service]\nType=oneshot\n' > $R/w2bbad-b.service
printf '[Service\nType=oneshot\nExecStart=/bin/true\n' > $R/w2bbad-c.service
printf '[Service]\nType=w2bnope\nExecStart=/bin/true\n' > $R/w2bbad-d.service
: > $R/w2bbad-e.service
ln -sf /dev/null $R/w2bbad-f.service
systemctl daemon-reload
echo "systemd $(systemctl --version | head -1)"
echo; echo "==================== (i) a stored, loadable ANAS task unit"; both anas-backup-w2bt1.service
for x in a b c d e f; do echo; echo "==================== (ii-$x) $(head -c 60 $R/w2bbad-$x.service 2>/dev/null | tr '\n' ' ' || true) [$(readlink $R/w2bbad-$x.service || echo file)]"; both w2bbad-$x.service; done
echo; echo "==================== (ii) the journal's view of the bad units (daemon-reload)"
journalctl -b --since -2min --no-pager -o cat | grep -E 'w2bbad' | sort -u | sed 's/^/  | /'
echo; echo "==================== (iii) a nonexistent unit"; both anas-backup-w2bnope.service
echo; echo "==================== (iv) a template name with no instance"; both anas-backup-@.service; both w2bbad@.service
echo; echo "==================== cleanup"
rm -f $R/w2bbad-*.service; systemctl daemon-reload; ls $R | grep w2b || echo "no w2bbad units left"
NODE
