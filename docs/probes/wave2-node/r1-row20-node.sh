#!/usr/bin/env bash
# Row 20, the node half (run as `bash -s -- <ticket> <journal-since>` over ssh by
# r1-gateway-rows.sh): 4 curl loops hammer GET /anas/…/v1/health through the real
# pveproxy for 12 s; `systemctl restart anas` at t+4 s rotates the key. Counts every
# answer, shows the window of non-200s, whether pveproxy was restarted, and the journal.
TICKET=$1 MARK=$2
W=/var/tmp/w2/r20; mkdir -p $W; cd $W || exit 1; rm -f loop*
systemctl show -p MainPID pveproxy; echo "workers $(pgrep -f '^pveproxy worker' | tr '\n' ' ')"; ls -li /run/anas/proxy.key
end=$(( $(date +%s) + 12 ))
for w in 1 2 3 4; do
  ( while [ "$(date +%s)" -lt $end ]; do
      curl -sk -o /dev/null -w "%{http_code} $(date +%s.%N | cut -c1-14)\n" -b "PVEAuthCookie=$TICKET" \
        https://127.0.0.1:8006/anas/api/nodes/anas-pve/v1/health
    done > loop$w ) &
done
sleep 4; echo "restart at $(date +%s.%N | cut -c1-14)"; systemctl restart anas; echo "restart returned $(date +%s.%N | cut -c1-14)"; wait
echo "status counts:"; cat loop* | cut -d' ' -f1 | sort | uniq -c
first=$(cat loop* | grep -v '^200' | sort -k2 | head -1 | cut -d' ' -f2)
last=$(cat loop* | grep -v '^200' | sort -k2 | tail -1 | cut -d' ' -f2)
after=$(cat loop* | awk -v t="$last" '$1==200 && $2>t' | sort -k2 | head -1 | cut -d' ' -f2)
echo "window: first non-200 $first, last non-200 $last, first 200 after it $after"
echo "non-200 answers by code:"; cat loop* | grep -v '^200' | cut -d' ' -f1 | sort | uniq -c
ls -li /run/anas/proxy.key; systemctl show -p MainPID pveproxy; echo "workers $(pgrep -f '^pveproxy worker' | tr '\n' ' ')"
echo "journal:"
journalctl -u pveproxy --since "$MARK" --no-pager -o cat | grep -a anas-proxy | sed 's/^/    pveproxy| /' | sort | uniq -c
journalctl -u anas --since "$MARK" --no-pager -o cat | grep -a authz | sed 's/^/    anas| /' | cut -c1-300
cd /; rm -rf $W
