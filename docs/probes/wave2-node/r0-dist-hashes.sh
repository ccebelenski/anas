#!/usr/bin/env bash
# R0: the deployed dist equals the host's — sha256 of every file under
# packages/{daemon,gateway,shared}/dist, LC_ALL=C sorted, host vs /opt/anas on the node;
# plus the installed Perl module and the UI bundle source.
set -uo pipefail
source "$(dirname "$0")/../wave3-node/lib.sh"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
hashlist='cd "$1" && find packages/daemon/dist packages/gateway/dist packages/shared/dist -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum'
host=$(bash -c "$hashlist" _ "$ROOT")
nodeh=$(node "bash -c '$hashlist' _ /opt/anas")
echo "host files: $(wc -l <<<"$host")   node files: $(wc -l <<<"$nodeh")"
echo "host list hash: $(sha256sum <<<"$host" | cut -c1-16)"
echo "node list hash: $(sha256sum <<<"$nodeh" | cut -c1-16)"
if [ "$host" = "$nodeh" ]; then echo "IDENTICAL"; else echo "DIFFER:"; diff <(echo "$host") <(echo "$nodeh") | head -20; fi
echo "--- spot list"
grep -E 'gateway/dist/auth/(assertion|proxy-key|policy)\.js$|daemon/dist/jobs/(authority|queue|read-jobs)\.js$|daemon/dist/routes/share-identity\.js$' <<<"$host" | cut -c1-16,65-
echo "--- AnasProxy.pm  host $(sha256sum "$ROOT/packages/pve-integration/perl/AnasProxy.pm" | cut -c1-16)  node $(node sha256sum /usr/share/anas/perl/AnasProxy.pm | cut -c1-16)"
