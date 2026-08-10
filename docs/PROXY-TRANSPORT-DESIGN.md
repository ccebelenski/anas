# ANAS Transport: single-surface reverse-proxy through pveproxy :8006

**Status:** designed 2026-07-25 (two stunt-node spikes proved feasibility + fail-open). Replaces the public `:3000` HTTPS origin as ANAS's default and only browser/inter-node transport.

## Motivation
ANAS served its API on its own `:3000` HTTPS origin. Browsers scope cert trust per host:port, so `:3000` needs its own cert exception even though PVE's `:8006` is already trusted — friction we won't fix by requiring a domain/ACME at install (non-starter for homelab). Serving the API at `/anas/*` through PVE's own `:8006` eliminates: the cert exception, CORS, and the cross-origin `PVEAuthCookie` (SameSite) friction — all at once. Single surface (operator: a dormant `:3000` fallback is "vestigial, not insurance" — dropped entirely).

## Architecture
```
browser ─(https, PVE session cookie)→ https://<node>:8006/anas/v1/...
  └ pveproxy (existing PVE front door, TLS terminated here)
      └ [additive hook in AnyEvent.pm] path =~ ^/anas → runtime-require AnasProxy.pm
          └ AnasProxy::handle → forward (AnyEvent::HTTP, non-blocking) to
              └ ANAS gateway on 127.0.0.1:3000 (LOOPBACK, plain HTTP, no public origin)
                  └ anasd over the unix socket (unchanged)
```
The UI (`anas.js`, already same-origin static under `:8006`) calls `/anas/...` — same origin, so the cookie flows automatically and there is no CORS.

## The PVE hook (fail-open by construction)
One **additive** block in `PVE::APIServer::AnyEvent::handle_request` (`/usr/share/perl5/PVE/APIServer/AnyEvent.pm`, pkg `libpve-http-server-perl`), spliced **after the `/api2` dispatch and before the pages/dirs/404 fallbacks** so it can never alter existing dispatch:
```perl
# >>> ANAS (additive; restored on uninstall/upgrade-clobber)
if ($path =~ m{^/anas(?:/|$)}) {
    eval {
        require '/usr/share/anas/perl/AnasProxy.pm';
        AnasProxy::handle($self, $reqstate, $method, $r->uri);
    };
    $self->error($reqstate, 500, 'ANAS proxy error') if $@;
    return;
}
# <<< ANAS
```
Anchor for the installer matcher: insert immediately after the `/api2` block (the `handle_api2_request($reqstate, $auth, $method, $path)` call with exactly 4 args). All proxy logic lives in the **ANAS-owned** `/usr/share/anas/perl/AnasProxy.pm` — PVE never ships or touches it.

**AnasProxy.pm must use non-blocking `AnyEvent::HTTP`** (NOT the spike's blocking `LWP`), mirroring how pveproxy itself proxies to pvedaemon — so a slow/large ANAS response never stalls a pveproxy event-loop worker. Strip hop-by-hop + `Client-*` + framing headers both directions; drop upstream `Accept-Encoding` and let PVE's `response()` own compression; hand the result back via `$self->response($reqstate, $res)`.

### Fail-open guarantees (proved on the stunt node, spike 2)
The `require` is at **request time**, inside `eval` — pveproxy never compiles ANAS code at worker startup. Therefore:
- ANAS module throws / has a syntax error / is missing → `/anas` 500s, **`:8006` unaffected**.
- Loopback gateway down → synthetic 5xx on `/anas`, **`:8006` unaffected**.
- Hook absent (PVE upgrade clobbered `AnyEvent.pm` before the apt-hook re-applies) → `/anas` 404s, **`:8006` unaffected**.
- **The one hazard:** a malformed patch block in `AnyEvent.pm` (PVE-owned, compiled at startup) → pveproxy won't start → `:8006` DOWN. **Guard:** installer runs `perl -c` on the patched file and only restarts pveproxy on pass; on fail it restores pristine and aborts. Proven to catch it deterministically.

## Gateway changes (packages/gateway)
- Bind **`127.0.0.1:3000`, plain HTTP, no TLS** — pveproxy terminates TLS. Remove the `0.0.0.0` bind, the PVE-cert auto-detection, and the HTTPS server. No public origin.
- **Remove CORS entirely** (`cors.ts` + the hook) — same-origin now; the allow/expose-header machinery is dead.
- Ticket verification unchanged (cookie arrives via the proxy; gateway verifies RSA-SHA1 vs `/etc/pve/authkey.pub` as today).
- **Unauthenticated health/installed probe route** (e.g. `GET /anas/installed` → 200 `{name:'anas',version}` with no auth) so panels can detect "is ANAS on node X" pre-login without a 401.

## Cross-node (multi-node)
Since `:3000` is gone, `forwardToNode` (packages/gateway proxy) retargets from `https://<nodeB>:3000/...` to **`https://<nodeB>:8006/anas/...`** — same cluster-CA TLS machinery (incl. the fail-closed CA behavior). One surface for browser AND inter-node.
- **Peer address resolution — via cluster membership, NOT DNS (live-proof catch 2026-07-25).** PVE node names are not DNS names (operators commonly have no DNS entries for them; PVE routes by the cluster's own addresses). `forwardToNode` resolves `<node>` → IP from **`/etc/pve/.members`** (`nodelist[<node>].ip`), connects to that IP, and sets the TLS **`servername`** to the node NAME so the cert-identity check passes (PVE node certs carry the node name in their SAN) while still verifying the chain against the cluster CA. A node absent from membership → `502 NODE_UNRESOLVED`; a resolvable-but-down peer → `502 NODE_UNREACHABLE` (a 15s forward timeout keeps a firewalled/partitioned peer from hanging the browser request). *(The single-node stunt proof could not exercise this — connecting by bare node name failed to resolve on the real cluster; caught on first multi-node test.)*
- **Node without ANAS (e.g. a Ceph-only node):** `:8006` is always up (it's PVE), so `/anas` hits pveproxy's file-fallthrough instead of `:3000`'s connection-refused. The exact shape is version-dependent — 404 Not Found, 501 Not Implemented, or (**PVE 9, confirmed on the stunt node**) a plain-text **`500 no such file '<path>'`**. The gateway detects all three (`classifyUpstreamResponse`: a fallback status whose body is not the ANAS JSON error envelope; a 500 must additionally carry pveproxy's `no such file` text so a genuine gateway/hook 500 is never masked) and returns a clean **`ANAS_NOT_INSTALLED`** for that node; the UI shows a "ANAS is not installed on this node" state, not a raw error. Same end result as today (can't manage a node without ANAS) with a clearer, distinguishable signal.
- **Loop-safety:** node A → `nodeB:8006/anas` → nodeB hook → nodeB loopback gateway → target is nodeB's own node → served locally. A node must never forward `/anas/nodes/<self>` back out through `:8006`. Unit-test this.
- **Node identity — from PVE, not `os.hostname()` (issue #5, external report 2026-08-04).** Local-vs-peer routing is an exact-match on the gateway's own node name, so a wrong identity turns every local request into a self-forward: node A's gateway forwards `/anas/nodes/A` to its OWN `:8006`, which routes it straight back in, until the 15s timeout — the UI's health probe fails and every panel shows "ANAS is not installed on this node". That is exactly what an **FQDN hostname** did (`pve-atlas.internal.…` vs the PVE node name `pve-atlas` — PVE node names are always the SHORT hostname). Identity now resolves, once at startup: `ANAS_NODE_NAME` → **`readlink /etc/pve/local`** (PVE's own authoritative answer — a symlink to `/etc/pve/nodes/<nodename>` on every node, matching the `<node>` the PVE UI puts in its URLs; path overridable via `ANAS_PVE_LOCAL_PATH` for tests) → **short** hostname. Every tier is non-throwing; the startup log names the winning source (`node 'pve-atlas' (from /etc/pve/local)`).
- **Forward-loop guard (defense in depth):** `forwardToNode` stamps `x-anas-forwarded: 1`. The legitimate hop is entry gateway → peer `:8006` → peer gateway → LOCAL socket, so a peer receiving the marker and serving locally is normal; a gateway that would forward a request *already* carrying the marker refuses with `502 FORWARD_LOOP` naming both the requested node and its own identity. Any future identity mismatch fails as one clean, self-describing error instead of a request loop.
- **Live-proof deferred:** the stunt node is single-node; cross-node forwarding is designed + unit-tested now and live-proven on the operator's prod cluster later (the changes are transport-symmetric, so it exercises the same path).

## UI (packages/pve-integration / anas.js)
Every gateway URL gains the `/anas` base prefix (one constant); routes reach the gateway as `/anas/api/nodes/<node>/v1/...`, the proxy strips `/anas`, gateway route table unchanged. Audit for any absolute-URL/redirect assumptions.

## Installer / uninstaller (packaging)
This makes ANAS's PVE integration **three** surgical, apt-hook-reapplied, fail-open patches: the menu `<script>` in `index.html.tpl`, `anas.js` in `js/`, and now the proxy hook in `AnyEvent.pm` + `AnasProxy.pm`.
- **Install:** ship `AnasProxy.pm` → `/usr/share/anas/perl/`; back up pristine `AnyEvent.pm`; splice the hook **only on an exact anchor match** (never force); `perl -c` the patched file → restart pveproxy only on pass, else restore pristine + abort with a clear error; `systemctl reset-failed pveproxy` defensively.
- **apt-hook re-apply:** extend the existing `DPkg::Post-Invoke` hook that already re-applies the menu injection — after a PVE upgrade clobbers `AnyEvent.pm`, re-splice (same perl-c gate). Fail-open in the gap: `/anas` 404s until re-applied (which is the same dpkg transaction, so effectively no window).
- **Uninstall:** take our block back out of `AnyEvent.pm`, remove `/usr/share/anas/perl/AnasProxy.pm`, restart pveproxy.
- **Coexistence (issue #20):** a sibling project (ADOCK) splices the same file by the same convention. So the whole-file backup is **skipped** when a foreign `# >>> … proxy hook` block is already present (it would enshrine their block as "pristine"), and uninstall prefers **marker excision**, falling back to the whole-file restore only when no foreign block exists — a backup that predates a sibling's splice (or a `libpve-http-server-perl` upgrade) would otherwise silently delete their hook. Either removal route is `perl -c`-gated before adoption, like the install's patch. See `packages/pve-integration/README.md`.

## Removed / retired
Public `:3000` HTTPS origin; gateway PVE-cert auto-detection + HTTPS server; CORS code; the README/installer "trust the :3000 cert" first-run note (the cert exception no longer exists).

## Notes for the build
- `require` caches by `%INC`: a new `AnasProxy.pm` needs a pveproxy **restart** to load (fail-safe: a live worker keeps serving the old good code). No hot-reload promise.
- pveproxy workers run as `www-data`; loopback TCP sidesteps socket-permission issues (confirmed reachable as www-data).
- Story: EPICS 12.2 (transport). Live-proof full-feature on the stunt node (not just spikes) before pve5; pve5 deploy is the operator's step.
