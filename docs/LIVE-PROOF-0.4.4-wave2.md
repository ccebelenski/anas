# Live proof — 0.4.4 wave 2 (cr.27, cr.28, cr.48, cr.49, cr.29/29b/29c/29d, cr.47 (c)/(e) probe, cr.25b leftovers), stunt node

Node: the stunt node (PVE 9 / pve-manager 9.2.21, kernel 7.0.14-23-pve, zfs-2.4.4-pve1, Node v22.23.3, perl v5.40.1),
the same node and build method as [wave 3b](LIVE-PROOF-0.4.4-wave3b.md), 2026-10-15 UTC, 22:06–22:51. The VM was shut
off at the start and was booted for the pass (no snapshot restore; `authkey.pub` mtime 1792085540 < now 1792102000, root
login with `anas-test` worked). The PBS VM anas-pbs was booted too and used read-only (one group listing and one catalog
listing of an existing snapshot, row 3); nothing was backed up to it or pruned on it.
Build: worktree fast-forwarded `026bf64..455ff82` (main HEAD at the start, contains cr.27 `e55ea00` + its review
follow-ups `455ff82`, cr.28 `5c039fc` + `91689b3`, cr.48 `49a4125`, cr.49 `ae728c8`, cr.29 `4c10a26`, cr.29c `fd590f1`,
cr.29b/d `9a8df52`). Main did not move during the pass.
ADOCK is installed on the same node; none of its pieces were edited, stopped or redeployed (row 8 table).

Methods as in wave 3b: API calls through the gateway exactly as the panels go (`https://<node>:8006/anas/api/nodes/
anas-pve/v1/...`, a ticket + CSRF token from one `/access/ticket` reply), with wave 3's client (`docs/probes/wave3-node/
api.sh`, `lib.sh`) wrapped by `docs/probes/wave2-node/a.sh` so its session and temp files stay inside the worktree; 202
jobs polled through `GET /v1/jobs/:id`; a 409 confirm resent with `x-anas-confirm: <code>`. Calls over the daemon's unix
socket are `curl --unix-socket /run/anas/anasd.sock` on the node with the identity headers spelled out. Every probe is a
script under `docs/probes/wave2-node/` and its raw output is under `docs/probes/wave2-node/out/` (`run.sh <script> <log>
[args]` runs one). Browser proofs are Playwright specs in the same directory (`playwright.config.ts` there).

Throwaway objects carry a `w2` prefix: PVE users `anas-{audit,admin,none,np,node,gm,off}@pve` and group `anas-g` (the
names WAVE2-DESIGN §8 gives), dataset `gtbackup/w2src`, nft table `inet w2bh` (drops everything to 192.0.2.10, a peer
that never answers), rclone remotes `w2ok` / `w2bh`, backup repo `w2bh`, backup tasks `w2b1..w2b3`, snapshot schedule
`w2snap`, pools `w2id` and `w2z` on sparse files under `/var/tmp/w2/`, local accounts `w2u*` / `w2g*` / `w2ui*`. Row 7's
specs create their own named objects (the vdev fixture's `gtvdev` on hot disk 9; the cloud-tasks fixture's), each removed
by the spec or its fixture.

Classification key (brief rule): (a) stale test expectation, (b) test/script bug, (c) node fact. A product defect is
recorded as **D<n>** (numbering continues wave 3b's D1–D11) with a repro, a severity and the suspected file:line.

---

## R0 — deploy (and row 17: the upgrade install)

```
host$ git merge-base HEAD main -> 026bf64 (= HEAD);  git merge --ff-only main  026bf64..455ff82
host$ npm ci; ./test/stunt-node/deploy-anas.sh                   (out/deploy.log)
  ✓ anasd active, 0 restarts, /v1/health answers version 0.4.3
  ✓ anas active, /installed answers the same version
  anas: installed /usr/share/anas/perl/AnasProxy.pm
  anas: proxy hook already present; AnasProxy.pm changed, pveproxy reloaded so its workers load it
host vs node, sha256 of every file under packages/{daemon,gateway,shared}/dist (2192 files, LC_ALL=C sorted list):
  IDENTICAL; hash of the list 1303cdef0c086ef9   (out/dist-hashes.log; authority.js, queue.js, read-jobs.js,
  share-identity.js, gateway auth/{assertion,policy,proxy-key}.js spot-listed);  AnasProxy.pm host = node c6beac85a012f590
```

Row 17 (§8: "upgrade install over the previous build with no other change → pveproxy reloaded by the installer; row 1
passes without a manual restart", F12). The node ran wave 3b's build `5b36fbe` (pre-cr.27; no `/run/anas/proxy.key`,
AnasProxy.pm 9350 bytes). Before the deploy, 12 GETs through `/anas` (all 200) made pveproxy's workers 1413–1415 load
the OLD module (`out/r17-old-build-warm.log`). The deploy's installer then reloaded pveproxy itself:

```
22:08:12 systemd: Reloading pveproxy.service … pveproxy[2837]: send HUP to 1412 … server shutdown (restart)
22:08:12 pveproxy[1412]: restarting server; starting 3 worker(s): 2842 2843 2844      (MainPID 1412 unchanged)
installed module 25493 bytes, mtime 22:08:12, sha256 c6beac85a012f590; /run/anas/proxy.key root:www-data 0640 22:08:08
```

No manual restart followed; the first request after it was row 1's (22:10:06, 200 / 202, below). A second install with
nothing changed (`r1-gateway-rows.sh 17b`):

```
anas: proxy hook already present in …/AnyEvent.pm and AnasProxy.pm unchanged (nothing to do)
MainPID 1412, workers 2842 2843 2844 before and after; no reload/HUP/restart line in the pveproxy journal
```

**Verdict: PROVEN** — `455ff82` deployed and running; the upgrade install reloaded pveproxy because the module changed
and only then; the new module served row 1 with no manual restart. (This is the dev deploy path, which runs the same
`packages/pve-integration/install.sh` the tarball installer runs; the tarball itself was not built.)

---

## Row 1 — cr.27: PVE decides inside pveproxy, the gateway trusts only the signed hand-off

Setup (`r1-setup-users.sh`, `out/r1-setup-users.log`): the seven users, the group and the ACLs exactly as §8 lists them.
The §7 captures are in `out/captures/`: `user.cfg` (no secrets — passwords live in `priv/shadow.cfg`), `pvesh get
/access/permissions --userid <u> --path / --output-format json` for root and every test user, `anas-node`'s all-paths
reply, and the standalone node's `.members` (`{"nodename": "anas-pve", "version": 0}` — no `nodelist`). The propagate-0
capture is the one an `=== 1` comparison would get wrong: `anas-np@pve / -> {"/":{… "Sys.Audit":0, … "Sys.Modify":0 …}}`.

§8 rows through the real pveproxy (`r1-authz-rows.sh`, `out/r1-authz-rows.log`; each with its response and journal line):

| # | Who / request | Answer | Journal |
|---|---|---|---|
| 1 | root@pam GET /pools; POST scrub with its token | 200; 202 `zpool.scrub` createdBy root@pam | none (no refusal) |
| 2 | root@pam POST scrub without a token; with anas-admin's token | 401 "Permission denied - invalid csrf token" both, after 3.0 s | pveproxy: `anas-proxy: refused POST /api/nodes/anas-pve/v1/pools/gtbackup/scrub from ::ffff:192.168.200.1 (root@pam): invalid csrf token` ×2 |
| 3 | anas-audit GET /pools; POST scrub with its own token | 200; 403 "Permission check failed (/, Sys.Modify): anas-audit@pve does not have it. ANAS asks the privilege PVE asks for its own disk and ZFS operations." | anas: `[authz] forbidden: anas-audit@pve POST /api/nodes/anas-pve/v1/pools/gtbackup/scrub lacks Sys.Modify on /` |
| 4 | anas-none GET /health | 403 "Permission check failed (/, Sys.Audit): anas-none@pve …" | anas: `[authz] forbidden: anas-none@pve GET …/v1/health lacks Sys.Audit on /`; panel half below |
| 5 | anas-np (Administrator, propagate 0) GET; POST scrub | 200; 202 createdBy anas-np@pve | none |
| 6 | anas-node (Administrator on /nodes/anas-pve) ANAS GET /pools; PVE's own `POST /api2/json/nodes/anas-pve/disks/zfs` and its GET | ANAS 403 Sys.Audit; PVE 403 "Permission check failed (/, Sys.Modify)" and GET 403 "(/, Sys.Audit)" — the same refusal at the same place (root@pam's same bogus create passes the check and fails "not a valid block device") | anas: `[authz] forbidden: anas-node@pve GET …/v1/pools lacks Sys.Audit on /` |
| 7 | anas-gm (PVEAuditor via group) GET; POST | 200; 403 Sys.Modify | anas: `[authz] forbidden: anas-gm@pve POST … lacks Sys.Modify on /` |
| 8 | anas-off GET (200) → `pveum user modify anas-off@pve --enable 0` (22:10:16.009) → the same ticket again | 200, then 401 "Authentication failed!" on the very next request | pveproxy: `anas-proxy: refused GET …/v1/pools from ::ffff:192.168.200.1: authentication failed` |
| 9 | `curl http://127.0.0.1:3000/api/nodes/anas-pve/v1/pools` with a valid root cookie; again with a forged `X-Anas-Auth` (zero MAC) | 401 "This request did not come through pveproxy" both | anas: `[authz] refused GET …: no proxy assertion`; `[authz] refused GET …: bad proxy assertion MAC (forged, tampered, or signed for another method or path)` |
| 9b | anas-none through :8006 with a client-supplied `X-Anas-Auth` claiming root@pam | 403 Sys.Audit for anas-none (AnasProxy dropped the header) | anas: `[authz] forbidden: anas-none@pve GET …` |
| 10 / 21 | `GET http://127.0.0.1:85/anas/installed` on the real pvedaemon (and an authenticated path there) | 404 "ANAS is served through pveproxy on :8006 only" both | pvedaemon: `anas-proxy: refused GET /installed from 127.0.0.1: served outside pveproxy (trusted_env)` (and the same for `/api/…/pools`) |
| 11 | `/anas/installed` without a cookie | 200 `{"name":"anas","version":"0.4.3"}` | none |
| 13 | `/var/log/pveproxy/access.log` | every `/anas` line after the deploy names the user (`- root@pam`, `- anas-audit@pve`, …); before the deploy the same lines read `- -` | — |
| 15 | ADOCK `/adock/` without a cookie; `/adock/installed` with root's | 401; 200 `{"name":"adock","version":"0.1.0"}`; adock, adockd active | — |

Rows 12, 14, 18–20 (`r1-gateway-rows.sh`, `out/r1-gateway-rows.log`, `out/r1-gateway-row20-rerun.log`):

```
row 12  systemctl stop anas -> /run/anas/proxy.key removed by the gateway on stop
        GET /pools -> 502 {"code":"UPSTREAM_UNREACHABLE","message":"ANAS gateway not ready (no proxy key)"} in 0.012 s
          pveproxy| anas-proxy: refused GET /api/nodes/anas-pve/v1/pools from ::ffff:192.168.200.1 (root@pam): proxy key unreadable: /run/anas/proxy.key: No such file or directory
        GET /anas/installed (exempt, so no key is read) -> 502 "ANAS gateway not reachable on the loopback interface"
          pveproxy| anas-proxy: 502 for GET /installed from ::ffff:192.168.200.1: gateway not reachable on the loopback interface (595 Connection refused)
                    ^ the cr.27 review's new _respond_502 line
        systemctl start anas -> new key (inode 2624 -> 3524), GET /pools 200; pveproxy MainPID 1412, workers unchanged
row 18  GET /shares/nfs/%2Ftestpool%2Fshare1?w2=a%2Fb&x=1 -> 200 {"data":{"path":"/testpool/share1",…}}
        (two more encoded targets with queries: 404s from the DAEMON — "Share path … could not be read", "Dataset
        'gtbackup/cloudsrc/x' not found" — i.e. past the gateway); no [authz] line and no anas-proxy line in the window;
        access.log keeps the target verbatim: "GET /anas/api/nodes/anas-pve/v1/shares/nfs/%2Ftestpool%2Fshare1?w2=a%2Fb&x=1" 200
row 19  /run/anas drwxr-xr-x root:root;  /run/anas/proxy.key -rw-r----- root:www-data 32 bytes
        sudo -u www-data head -c 64 … -> 32 bytes read, exit 0;  pveproxy workers run as www-data
        sudo -u nobody …  -> head: cannot open '/run/anas/proxy.key' for reading: Permission denied
        sudo -u debian (uid 1000) … -> Permission denied
row 20  4 loops of GET /anas/…/v1/health on the node for 12 s, `systemctl restart anas` at t+4 s; twice:
          run 1: 2693 × 200, 57 × 502, 0 × 401; non-200 window 22:11:22.368 – .578 (210 ms), first 200 at .579
          run 2: 2756 × 200, 57 × 502, 1 × 503, 0 × 401; window .428 – .651 (223 ms), first 200 at .652
        the 502s: "proxy key unreadable … No such file or directory" (47) and "595 Connection refused" / "596 Connection
        reset by peer" (10) — between the old gateway removing its key and the new one listening; pveproxy MainPID 1412
        unchanged, no reload; it self-heals on the next request (the module re-reads the key when the inode changes)
row 14  GET /v1/pools through /anas on the node (loopback, one TLS handshake per curl), 20 runs: median 56.2 ms
        (min 36.3, max 85.1); the daemon alone over its socket: median 29.3 ms; PVE's /api2/json/version: median 13.3 ms
        in process (AnasProxy-node.t, real PVE modules as www-data): auth_handler + 2 × check + key read + HMAC,
          50 runs: min 0.309, median 0.391, max 1.436 ms
```

Row 20's one 503 (run 2) carried 80 bytes — Fastify's own "Service Unavailable" body for a request that reached the old
gateway while it was closing (`return503OnClosing`), not the ANAS envelope; the access log names root@pam on it. Noted,
not a defect: a restart window answers 502/503 for ~0.2 s and never 401.

Row 14 has no pre-cr.27 number on this node (the old build was replaced before a 20-run baseline was taken; the 12 warm
GETs before the deploy ran from the host and include TLS setup over the network, 29–64 ms). The added work is therefore
given as measured in process: a median of 0.39 ms per request for everything AnasProxy now does before it forwards, well
under the 2 ms the row allows; the gateway's MAC check is one HMAC-SHA256 over a short string.

`prove` on the node (`r1-prove-node.sh`, `out/r1-prove-node.log`):

```
(1) the shipped suite (pure helpers + handler against transliterated fakes), node perl v5.40.1:
    AnasProxy-auth.t .. ok   AnasProxy.t .. ok   Files=2, Tests=176   Result: PASS
(2) AnasProxy-node.t — the REAL PVE::HTTPServer::auth_handler, PVE::RPCEnvironment (live user.cfg) and
    PVE::AccessControl verifiers, run as www-data (uid 33) with tickets and CSRF tokens from real /access/ticket
    logins, the installed /usr/share/anas/perl/AnasProxy.pm, forwarding to the real gateway with the real key;
    anas-off disabled for the run:   Files=1, Tests=57   Result: PASS
      privileges as PVE compiles them on /: root, anas-admin, anas-np (propagate 0) [Sys.Audit,Sys.Modify];
        anas-audit, anas-gm (group) [Sys.Audit]; anas-none, anas-node (/nodes only) []
      row 8: anas-off (disabled) -> 401 "Authentication failed!", reason "authentication failed"
      CSRF: own token passes; none -> "invalid csrf token" (user still named); root@pam's token -> refused
      §7 mutation case: auth_handler(POST, csrf undef) as www-data dies "invalid csrf token"; GET with none passes
      end to end through the real gateway: audit GET 200 / POST 403; none GET 403; np GET 200 / POST past authz (the
        daemon's own 404 for a missing pool); node GET 403; gm GET 200 / POST 403; root GET of the %2F target 200;
        every 403 names the privilege and the user; the access-log user id set on each
```

Row 4's panel half (`w2-privilege-panel.spec.ts`, `out/w2-privilege-panel.log`, 1 passed): anas-none@pve logged in
through the PVE form (realm "Proxmox VE authentication server") and opened the node's ANAS Dashboard;
`GET /anas/api/nodes/anas-pve/v1/health` → 403 FORBIDDEN "Permission check failed (/, Sys.Audit): anas-none@pve …"; the
panel heading reads "You need Sys.Audit on / to view ANAS on this node", followed by the explanation and the gateway's
sentence; "ANAS is not installed on this node" and `.anas-view-notinstalled` count 0.

Row 16 (the full integration suite green) was **not run**: the brief forbids `run-tests.sh` whole (it restores the
baseline). Every integration spec run in this pass (row 7) went through the enforcing proxy as root@pam with the cr.25b
cookie + CSRF fixture.

**Verdict: PROVEN** for §8 rows 1–15 and 17, and the four review rows 18–21; row 16 not run (brief). No defect.

---

## Row 2 — cr.28: the job queue's backstop

`r2-backstop.sh` (`out/r2-backstop.log`; a first run sent a non-UUID `x-anas-request-id` and every call was refused at
the identity layer, 401 — script bug (b), kept as `out/r2-backstop-scriptbug-requestid.log`).

```
over the socket, x-anas-user w2probe@pve, POST /v1/pools/gtbackup/scrub:
  x-anas-privileges: Sys.Audit            -> 403 FORBIDDEN "Permission check failed (/, Sys.Modify): w2probe@pve does not have it. …"
    anasd| {"audit":true,"event":"job.refused","user":"w2probe@pve","operation":"zpool.scrub","params":{"pool":"gtbackup","action":"start"},
            "privilege":"Sys.Modify","reason":"holds Sys.Audit on /","msg":"audit: w2probe@pve refused zpool.scrub: lacks Sys.Modify on / (holds Sys.Audit on /…"}
  x-anas-privileges: Sys.Audit,Sys.Modify -> 202 zpool.scrub createdBy w2probe@pve
  x-anas-privileges: Sys.Modify           -> 202 (Sys.Modify also passes wherever Sys.Audit is asked, 317d5be)
  no x-anas-privileges header             -> 401 "Missing or invalid identity headers (…, x-anas-privileges)"
    anasd| [authz] refused POST /v1/pools/gtbackup/scrub: invalid identity headers (x-anas-privileges: Invalid input: expected string, received undefined)
a read.* job over the socket with Sys.Audit only:
  POST /v1/cloud/tasks/preview (w2ok)     -> 202 read.cloud.preview -> completed, result {"transfers":4,"bytes":20971520,…,"errors":[],"truncated":false}
  POST /v1/cloud/tasks/preview (w2bh)     -> 202; rclone running under `timeout 600`; POST /v1/jobs/<id>/cancel with Sys.Audit only
                                          -> 202 job.cancel; the preview "cancelled by w2probe@pve"; no rclone process left
  a running backup DIRECT run's cancel with Sys.Audit only (row 4's run) -> 403 FORBIDDEN
    audit: job.refused w2probe@pve job.cancel {"id":"97a50270-…","operation":"backup.task.run"} holds Sys.Audit on /
through /anas as anas-audit@pve, the same preview POST -> 403 Sys.Modify (the gateway asks Sys.Modify for every POST)
    anas| [authz] forbidden: anas-audit@pve POST /api/nodes/anas-pve/v1/cloud/tasks/preview lacks Sys.Modify on /
```

Work no request started:

```
snapshot schedule w2snap (OnCalendar=hourly; ExecStart=/usr/bin/node …/snapshot-task.js --id w2snap):
  systemctl start anas-snap-w2snap.service -> exit 0, Result=success; its journal:
    {"schedule":"w2snap","result":{"schedule":"w2snap","taken":"anas-hourly-2026-10-15T221840Z",…}}
  job schedule.run completed, createdBy root@pam (the runner's identity, runner-poll.ts: Sys.Audit,Sys.Modify)
backup Run-Now (row 4): each task's unit submitted its direct run over the socket — audit `job.submitted root@pam
  backup.task.run {"task": "w2b1", "direct": true}` ×3 — and each ran (refused by nothing; failed later on the
  blackholed repo, as intended)
udev cache-event script (/usr/local/bin/anas-cache-event, packaging/anas-cache-event.sh):
  its exact header set (x-anas-user: system:udev-cache-event, x-anas-privileges: Sys.Audit,Sys.Modify) on a POST that
    submits a job: POST /v1/pools/gtbackup/scrub -> 202 createdBy system:udev-cache-event
  the script itself, `anas-cache-event w2nopool-cache0 sdz` -> exit 0; journal (tag anas-ahr):
    EVENT=CacheDeviceRemoved POOL=w2nopool SLICE=w2nopool-cache0 KERNEL=sdz / EVENT=CacheEventDelivered …
    the same request by hand: 404 "AHR pool 'w2nopool' not found" (the route answers before any submit)
```

The cache-event job itself could not be run: it needs an AHR pool with a dm-cache, and creating an AHR pool writes
`/etc/mdadm/mdadm.conf`, which the brief forbids. The script's identity is proven to pass `submit`; the event route's
own job is not.

**Verdict: PROVEN** (Audit-only refused with the reason logged as an audit `job.refused`; both privileges accepted;
a `read.*` job and its cancel accepted on Sys.Audit over the socket and refused through `/anas`; the schedule runner and
the Run-Now units run). **Partial** for the udev script: identity proven on a scrub, the event job not reachable without
an AHR pool.

---

## Row 3 — cr.48: the slow reads are cancellable read jobs

`r3-read-jobs.sh` through `/anas` as root@pam (`out/r3-read-jobs-run1.log`, `out/r3-read-jobs-run2.log`):

```
preview, fast (w2ok)  POST /cloud/tasks/preview -> 202 read.cloud.preview; completed at t+0 s,
                      progress "0 checked, 4 to transfer (20971520 bytes), 0 to delete", result {transfers 4, bytes 20971520, errors [], truncated false}
preview, slow (w2bh)  202; at t+15 s still `running`; children:
                        44648 pgid 44648 /usr/bin/timeout 600 /usr/bin/rclone copy /gtbackup/w2src w2bh:w2dst … --dry-run
                        44649 pgid 44648 /usr/bin/rclone copy …
                      POST /jobs/<id>/cancel (no x-anas-confirm) -> 202 job.cancel; the job `cancelled` "cancelled by root@pam at …";
                      process group 44648: 0 processes; lasted 17 s (past the old 12 s budget)
remote test, fast     POST /cloud/remotes/test {"name":"w2ok"} -> 202 read.cloud.remote.test; completed {"verdict":"ok"}
remote test, slow     202; at t+3 s running (pgid 45559: timeout 120 rclone … lsjson w2bh: --contimeout 10s …);
                      cancel -> 202, `cancelled`, process group 45559: 0 processes
catalog, fast         GET /backup/repos/pbsgt/groups -> 7 groups; POST /backup/restore/browse {pbsgt, host/gtguard/2026-09-25T02:36:53Z,
                      guarded.pxar, /} -> 202 read.backup.catalog; completed {"verdict":"ok", entries [/proof.txt, 23 bytes]}
catalog, slow (w2bh)  202; at t+3 s running (pgid 45667: timeout 300 proxmox-backup-client catalog shell …);
                      cancel -> 202, `cancelled`, process group 45667: 0 processes
```

Run 1 waited 15 s before cancelling the remote test and the catalog listing: both had already ended on their own —
`{"verdict":"unreachable","message":"… dial tcp 192.0.2.10:22: i/o timeout"}` and `"… tcp connect error: deadline has
elapsed"` — inside 12 s, because rclone's `--contimeout 10s` and proxmox-backup-client's own connect deadline give up
on a dead peer first (c). So the preview is the one shown outliving 12 s, as the brief allows; run 2 cancelled the other
two at t+3 s.

Panel side (`w2-readjobs.spec.ts`, `out/w2-readjobs.log`, 6 passed, 50 s; every request recorded, the DOM sampled every
50 ms):

```
preview fast   Cloud Sync wizard Preview: POST /cloud/tasks/preview 202 read.cloud.preview; "asking the server…" and
               "Cancel preview" shown at t+0.1 s; completed at t+0.7 s, the line "Would transfer 4 files / 20.00 MiB",
               Cancel hidden; the wizard closed without saving
preview slow   w2bh: at t+14.1 s still running (14 polls), one rclone on the node; Cancel preview → POST /jobs/<id>/cancel
               202 with no x-anas-confirm, no message box; next poll `cancelled`; the line "Preview cancelled — nothing was
               copied or deleted."; `pgrep -ax rclone` empty
test fast      Remotes… → row → Test: 202 read.cloud.remote.test, "testing remote…" + "Cancel test", then "Reachable"
test slow      w2bh: running at t+3.1 s (rclone lsjson on the node); Cancel test → 202, no confirm; cancelled at t+3.8 s;
               "Test cancelled — nothing was changed."; no rclone left
catalog fast   Backup → Restore from repository… → pbsgt, host/gtguard, snapshot 2026-09-25T02:36:53Z, guarded.pxar →
               Choose files…: POST /backup/restore/browse 202 read.backup.catalog; Stop + "Loading..." from t+0.1 to 0.7 s;
               the tree row "proof.txt 23 B 2026-09-25 02:36:52 node local time"
catalog slow   the same picker the dialog opens (ANAS.pathPicker, backend 'archive', 68-backup.js:6194), opened with
               page.evaluate on repo w2bh — the dialog cannot reach a dead repo's archive list (its snapshot picker cannot
               list a dead repo); running at t+3.3 s (timeout 300 proxmox-backup-client catalog shell …); Stop → 202, no
               confirm; cancelled at t+3.8 s; "Listing of / stopped."; no proxmox-backup-client left
```

Notes from the browser run: only the preview renders `job.progress`; the remote Test window shows a spinner line and the
catalog picker a "Loading..." mask with Stop — neither shows a progress line, and both jobs report `progress: null`. EPICS
cr.48 says "a progress line" for the dialog generally; the operator may want to rule whether that means all three
(recorded, not a defect). A first slow-preview run cancelled itself 0.1 s after the 202: ExtJS's buffered change event
on the path field fired after the Preview click and ran `refreshCloudPreview`, which withdraws an in-flight preview by
design — test timing (b), fixed in the spec by waiting 600 ms after filling the fields.

**Verdict: PROVEN** — all three reads answer 202 with a `read.*` job, the dialogs poll it and show `job.result`; Cancel
stops the job through the job-cancel door with no confirm and the child's whole process group is gone; the preview ran
past 12 s (17 s by API, 15.7 s in the browser) until cancelled.

---

## Row 4 — cr.49: Run-Now supervisors in their own watch lane

`r4-runnow-lanes.sh` (`out/r4-runnow-lanes-run2.log`; run 1's job table was empty because `GET /v1/jobs` carries no
`params` — a script bug (b), its process listing and job timestamps are in `out/r4-runnow-lanes-run1-scriptbug.log` and
show the same picture). Three Run-Nows back to back on tasks whose repo is the blackholed `w2bh`, so each direct run sits
in proxmox-backup-client's connect for ~10 s; the queue has 4 slots, 3 of them long, and the watch lane's 8:

```
  d0e49bfc supervisor running   created 22:22:56.637 started 22:22:56.637 | started backup task 'w2b1'
  fc4b48c1 supervisor running   created 22:22:56.736 started 22:22:56.736 | started backup task 'w2b2'
  55924b79 supervisor running   created 22:22:56.812 started 22:22:56.812 | started backup task 'w2b3'
  97a50270 direct     running   created 22:22:56.953 started 22:22:56.953 | archive 'w2data' <- /gtbackup/w2src/.zfs/snapshot/anas-backu…
  f8edcdc8 direct     running   created 22:22:56.968 started 22:22:56.968 | archive 'w2data' <- …
  13c580ae direct     running   created 22:22:57.068 started 22:22:57.068 | archive 'w2data' <- …
  t+3 s: 46879 / 46887 / 46914 proxmox-backup-client backup w2data.pxar:/gtbackup/w2src/.zfs/snapshot/anas-backup-w2b{1,2,3}-… alive at once
  end: the three direct runs failed 22:23:07.28–.32 "Error: client error (Connect)", the supervisors 22:23:19.0–.13 with it
  audit: job.submitted root@pam backup.task.run {"task":"w2bN"} ×3, then {"task":"w2bN","direct":true} ×3
```

Run 1 (22:22:13) the same: three supervisors started at creation, the three direct runs created 13.363/.393/.415 and
started within 1 ms, three pbc processes alive at t+3 s.

**Verdict: PROVEN** — every direct run started the millisecond it was submitted while all three supervisors were
running; with the old shared long lane the three supervisors would have held the three long slots.

---

## Row 5 — cr.29 / 29b / 29c / 29d on a real node

Node facts first (`r5-zfs-space-captures.sh`, `out/r5-captures.log`): pool `w2id` with `w2id/fs` (mounted, a file owned
by 51099), `w2id/unm` (a file owned by 51098, then `zfs unmount`), `w2id/enc` (encryption=on, keyformat=passphrase, a
file owned by 51097, unmounted, `zfs unload-key`), `w2id/vol` (a 64M zvol). Captures in the brief's form and in the
daemon's own argv (`identity-ids.ts` `spaceArgs`); both forms answered identically each time:

```
$ zfs userspace -Hpn -o name w2id/fs                      (mounted — reference)
exit code: 0
stdout (8 bytes):
  | 0
  | 51099
stderr (0 bytes):

$ zfs userspace -Hpn -o name w2id/unm                     (UNMOUNTED filesystem)
exit code: 0
stdout (8 bytes):
  | 0
  | 51098
stderr (0 bytes):

$ zfs userspace -Hpn -o name w2id/enc                     (LOCKED encrypted: unmounted, keystatus unavailable)
exit code: 255
stdout (0 bytes):
stderr (54 bytes):
  | cannot get used/quota for w2id/enc: permission denied

$ zfs userspace -Hpn -o name w2id/vol                     (zvol)
exit code: 1
stdout (0 bytes):
stderr (74 bytes):
  | cannot open 'w2id/vol': operation not applicable to datasets of this type
```

`groupspace` answered the same shapes (51099 / 51098 for the gid; the same stderr and exit codes for the locked
dataset and the zvol); `-H -p -n -o name -t posixuser -- <ds>` and `-t posixgroup` the same bytes. The daemon lists
`zfs list -H -o name -t filesystem` → `w2id`, `w2id/enc`, `w2id/fs`, `w2id/unm` — the zvol is never asked; the locked
dataset is.

The API flows (`r5-identity.sh`, `out/r5-identity.log`; `r5b-identity.sh`, `out/r5b-identity.log`):

```
1a automatic pick, w2id/enc LOCKED  POST /identity/users {"name":"w2u0"} ->
   409 CONFLICT reason id-check-unreadable "ANAS could not check which uid is free: it could not read ZFS's per-user
   accounting of 'w2id/enc' (zfs userspace: cannot get used/quota for w2id/enc: permission denied). Nothing was created.
   To create the user without this check, give its User ID explicitly (an id you give is not checked for files)."
1b the same with the key loaded and w2id/enc mounted (w2id/unm still unmounted, the zvol still there)
   -> 202, "Creating share user 'w2u1' with uid 1002"; getent w2u1:x:1002:100::/home/w2u1:/usr/sbin/nologin
   audit: job.submitted identity.user.add {"user":"w2u1","uid":1002,"explicit":false,"smbEnabled":false}
   (1001 is the cloud fixture's rclonegt; 1002 = the highest in-band account + 1)
1c group door: {"name":"w2g0"} -> gid 1003, audit {"group":"w2g0","gid":1003,"explicit":false}
2  explicit uid 1000 -> 409 reason id-in-use "uid 1000 already belongs to user 'debian'. Nothing was created. …"
2b explicit uid 51099, which owns /w2id/fs/owned-51099 -> 202 created (an explicit id is not checked for files),
   audit {"user":"w2u99","uid":51099,"explicit":true,…}
3  group w2g1 gid 51001; user w2u2 uid 51001 -> 409 CONFIRMATION_REQUIRED "Create user 'w2u2' with uid 51001?"
   warning: "Group 'w2g1' already has gid 51001. User 'w2u2' will get uid 51001 with primary group gid 100 (the
   default), so uid 51001 and gid 51001 will belong to two unrelated accounts. To avoid it, give another User ID,
   choose 'w2g1' as the primary group, or leave the User ID empty and ANAS picks one no group holds as its gid."
   resend with the code -> 202, w2u2 uid 51001 gid 100(users); w2g1 unchanged
   a replay of a code after the state changed -> 409 "User 'w2u2' already exists"
3b group w2g2 with gid 1002 (= w2u1's uid) -> 409 confirm "… 'w2g2' looks like the private group of 'w2u1' without
   being it …"; resend -> 202 gid 1002
4  primaryGroup w2g1 (band) -> uid=51003(w2u3) gid=51001(w2g1); primaryGroup users -> uid=51100 gid=100(users),
   audit {"primaryGroup":"users","primaryGid":100,"explicit":false}; primaryGroup root -> 409 SYSTEM_ACCOUNT
   "Group 'root' (gid 0) is a system group, so it cannot be a share user's primary group. …"
5  group w2u5 gid 51005, user w2u5 uid 51006 primaryGroup w2u5 (USERGROUPS_ENAB yes); DELETE /identity/users/w2u5 ->
   409 "Deleting share user 'w2u5' removes the account and its group 'w2u5'", warnings incl. "Its group 'w2u5' (gid
   51005) will be removed too: it is the user's primary group, named like the user, and no other account uses it, so
   userdel removes it (USERGROUPS_ENAB in /etc/login.defs)" and the "Files owned by this group keep gid 51005 …" line;
   resend -> 202 "Deleting share user 'w2u5' and its group 'w2u5'", result {"groupRemoved":"w2u5"}; both gone
5b group w2u7 is the primary group of w2u7 AND w2u8; DELETE w2u7 -> 409 "Deleting share user 'w2u7' removes the
   account" (no group named); resend -> result {"groupRemoved":null}; group w2u7 SURVIVES, w2u8 still gid 51007
6  the pick steps over ZFS-accounted ids on a mounted and an UNMOUNTED filesystem: highest in-band uid 51100; a file
   owned by 51101 on /w2id/fs, one owned by 51102 written to w2id/unm then unmounted (`zfs userspace` there: 0 51098
   51102) -> "Creating share user 'w2u6' with uid 51103 (uid 51101 still owns the ZFS filesystem 'w2id/fs'; uid 51102
   still owns the ZFS filesystem 'w2id/unm')"
```

r5-identity.sh's own items 3 and 3b resent WITHOUT the code (its `create` helper dropped the header argument — script
bug (b)); `r5b-identity.sh` re-ran them with the header, as above.

Two of the brief's expectations differ from what EPICS says shipped, and the node does what EPICS says:
- "resend creates with the next free gid" — cr.29c shipped "with one correction: ANAS keeps `useradd -N` … so no private
  group is ever made"; the resend creates uid N with the default primary gid 100, and the confirm says so.
- "the confirm names the group and the group survives" — cr.29d shipped "userdel has no way to keep the group … so the
  user delete mirrors remove_usergroup's rule …, names the group in its confirm … and refuses as the group delete
  would". The node: a like-named primary group nobody else uses is named in the confirm and removed with the user
  (item 5); when another account uses it, it is not named and survives (5b). The refusal half (`referenced-by-share`,
  `SYSTEM_ACCOUNT`) was not provoked here.

Panel side (`w2-identity-ui.spec.ts`, `out/w2-identity-ui.log`, 1 passed): New Group's "Advanced" fieldset collapsed,
expanded shows "Group ID (optional):" — w2uigrp created with gid 51234 (`w2uigrp:x:51234:`); New Share User's Advanced
collapsed, expanded shows "User ID (optional):" and "Primary group:" defaulting to `users`; the primary-group list offered
`users(100), debian(1000), rclonegt(1001), w2g0(1003), w2g1(51001), w2g2(1002), w2u7(51007), w2uigrp(51234)` — no root, out
of 70 groups on the node, 63 outside the band; the supplementary picker the same without `users`; the create sent
`{"name":"w2uiuser","uid":51234,"primaryGroup":"w2uigrp"}` (no confirm: uid N and gid N belong to related accounts) →
`w2uiuser:x:51234:51234::/home/w2uiuser:/usr/sbin/nologin`; the user delete's confirm carried "Files owned by this user keep
uid 51234 … re-create the user with User ID 51234", the group survived the user delete and went with its own Delete.

**Answer to the brief's question:** an UNMOUNTED filesystem does not block the automatic pick (ZFS accounts for it, exit
0, and the pick uses it — item 6); a zvol is never asked; a LOCKED encrypted dataset makes `zfs userspace` exit 255
"permission denied", and every automatic uid/gid pick on the node refuses 409 `id-check-unreadable` until the key is
loaded (an explicit id still works). That is the shipped fail-closed rule working as written; whether a locked dataset
should count as "owns nothing" or "unreadable" is the operator's call (finding F1 below).

**Verdict: PROVEN** — picked id with `explicit: false` on the audit line; an explicit id held by an account refused
409; the same-number confirm on both doors, resend creates; `primaryGroup` in band and `users`, root refused; the
like-named-primary-group delete names the group (removed when nobody else uses it, kept and unnamed when someone does);
the panel's Advanced sections and the band-only group lists. The fixture captures are above.

---

## Row 6 — cr.47 (e) and (c): pure-ZFS partial-operation probe

`r6-zfs-partial.sh` (`out/r6-zfs-partial.log`), `r6b-send-across-rename.sh` (`out/r6b-send-across-rename.log`). No ANAS
code. Pool `w2z` on a 1 GiB sparse file, rebuilt before each case: `w2z/p`, `w2z/p/a`, `w2z/p/a/g`, `w2z/p/c` (32 MiB of
random data), `w2z/p/c/g`, `w2z/p/z`, then `zfs snapshot -r w2z/p@s` — a sibling sorting before the held child and one
after it. zfs-2.4.4-pve1, kernel 7.0.14-23-pve. Verbatim:

```
==================== (e) zfs destroy -r of the parent filesystem, child@s held   (zfs hold keep w2z/p/c@s)
$ zfs destroy -r w2z/p
exit code: 1
stdout:
stderr:
  | cannot destroy snapshot w2z/p/c@s: it's being held. Run 'zfs holds -r w2z/p/c@s' to see holders.
  | cannot unmount '/w2z/p': pool or dataset is busy
zfs list -t all -r -o name w2z  (after):
  | w2z
  | w2z/p
  | w2z/p/c
  | w2z/p/c@s

==================== (e') the same, dry-run first: zfs destroy -rnv w2z/p (held)
$ zfs destroy -rnv w2z/p
exit code: 0
stdout:
  | would destroy w2z/p/a/g@s
  | would destroy w2z/p/a/g
  | would destroy w2z/p/a@s
  | would destroy w2z/p/a
  | would destroy w2z/p/c/g@s
  | would destroy w2z/p/c/g
  | would destroy w2z/p/c@s
  | would destroy w2z/p/c
  | would destroy w2z/p/z@s
  | would destroy w2z/p/z
  | would destroy w2z/p@s
  | would destroy w2z/p
stderr:
(the dry run changes nothing and does NOT see the hold: exit 0, it lists the held snapshot as "would destroy")

==================== (c1) zfs destroy -r w2z/p@s, child@s held
$ zfs destroy -r w2z/p@s
exit code: 1
stdout:
stderr:
  | cannot destroy snapshot w2z/p/c@s: it's being held. Run 'zfs holds -r w2z/p/c@s' to see holders.
zfs list (after): all six filesystems and all six @s snapshots present — nothing destroyed

==================== (c2) zfs rename -r w2z/p@s w2z/p@t, child@s held
$ zfs rename -r w2z/p@s w2z/p@t
exit code: 0
stdout:
stderr:
zfs list (after): all six snapshots renamed @t
$ zfs holds -H -r w2z/p@t
exit code: 0
stdout:
  | w2z/p/c@t	keep	Thu Oct 15 22:26 2026
stderr:
(a hold does not stop a rename; the hold moves with the snapshot)

==================== (c3) zfs rename -r w2z/p@s w2z/p@t while zfs send w2z/p/c@s runs (no hold)
send running: 50551 zfs send w2z/p/c@s
$ zfs holds -H w2z/p/c@s
exit code: 0
stdout:
stderr:
$ zfs rename -r w2z/p@s w2z/p@t
exit code: 0
stdout:
stderr:
zfs list (after): all six snapshots renamed @t
(r6b: the send of w2z/p/c@s, piped through a 6 s pause into `zfs recv w2z/r`, with the rename -r inside the pause:
 send/recv exit 0/0, w2z/r@s received under the OLD name, data sha256 69941fb621d6e600 = source)

==================== (c4) zfs destroy -r w2z/p@s while zfs send w2z/p/c@s runs (no hold)
$ zfs destroy -r w2z/p@s
exit code: 1
stdout:
stderr:
  | cannot destroy snapshot w2z/p/c@s: dataset is busy
zfs list (after): all six filesystems and all six @s snapshots present — nothing destroyed

==================== (c5) zfs destroy (single, not -r) w2z/p/c@s while the send runs
$ zfs destroy w2z/p/c@s
exit code: 1
stderr:
  | cannot destroy snapshot w2z/p/c@s: dataset is busy

==================== holds
$ zfs holds -H w2z/p/c@s          (held)
exit code: 0
stdout:
  | w2z/p/c@s	keep	Thu Oct 15 22:26 2026
stderr:
$ zfs holds -H w2z/p@s            (unheld)
exit code: 0
stdout:
stderr:
$ zfs holds -H w2z/p@nope         (nonexistent)
exit code: 1
stdout:
stderr:
  | cannot open 'w2z/p@nope': dataset does not exist
  | no datasets available
$ zfs holds -H -r w2z/p@s
exit code: 0
stdout:
  | w2z/p/c@s	keep	Thu Oct 15 22:26 2026
```

**cr.47 (e) answer: PARTIAL.** `zfs destroy -r <filesystem>` over a tree with a held child snapshot destroys everything
it can and then fails: the sibling before the held child (`w2z/p/a`, `w2z/p/a/g` and their snapshots), the held child's
own child (`w2z/p/c/g`, `@s`), the sibling AFTER it (`w2z/p/z`, `@s`) and the parent's own `w2z/p@s` were all gone; only
the held snapshot, its filesystem and the parent survived, and the command exited 1. The failure does not stop the
sweep, so the order of children does not limit the damage. `zfs destroy -rnv` cannot be used as the pre-check: it exits
0 and lists the held snapshot as "would destroy". The pre-read the story proposes (`zfs holds` across the sweep, here
`zfs holds -H -r <fs>@<each snapshot>`, or per snapshot) is needed.

**cr.47 (c) answer: ATOMIC.** The recursive snapshot verbs were all-or-none in every case: `zfs destroy -r <fs>@s` with
a held child snapshot (c1) and with a child snapshot under a running `zfs send` (c4) destroyed nothing; `zfs rename -r`
(c2, c3) renamed all six in both cases, because neither a hold nor a running send stops a rename (and the send completed
and received under the old name). For the (c) ruling: "a send in flight is protected by ZFS's own busy refusal on the
snapshot it reads" holds for DESTROY (c4, c5: "dataset is busy"), not for RENAME, which succeeds under a running send.

**Verdict: PROVEN** (captures made; (e) partial, (c) atomic).

---

## Row 7 — cr.25b leftovers

| Spec | Wave 3b | Re-run before the fix | Class | Fix | After |
|---|---|---|---|---|---|
| vdev-consumers 225 (c) | cache + spare not wiped (D5) | same: `…HOT9-part3 carries no ZFS label` → 4 × zfs_member | (a) — nf.2 D5 keeps the cache and spare leaves by design | test (c) re-cut to D5's contract (more than one line, as wave 3b said): the confirm lists exactly the data/log/special/dedup leaves under "Disks to wipe" and names the cache and spare `is not wiped`; the job's `wiped` = sdb1, sdb2, sdb5, sdb6, `skipped` = sdb3, sdb4, `preserved` = [{disk sdb, reason shared}]; those four partitions carry no `zfs_member`, the other two keep theirs; the disk row leaves the pool (`poolName` null, `vdevRole` null) and reads `status: "other"`. The header comment says the same. | file **3/3 passed** on five runs (`out/r7-vdev-consumers-fix-run1..5.log`; runs 4 and 5 on the committed text); eslint clean |
| cloud-tasks-api 640–642 | `errors` empty under the 12 s budget (D9 race) | **9 passed** unchanged (`out/r7-cloud-tasks-api-run1.log`, 4.7 min) | was (a)+(c) against the 12 s synchronous preview; cr.48 made the preview a `read.*` job with a 600 s ceiling (the spec already polls it with `readJob`), so rclone's own retries finish and `errors` / `truncated: false` hold | none needed | **9 passed** on two more runs (`-run2.log`, `-run3.log`) |
| smbsvc-api 5 (AHR half) | `ahrpv` pin | not run | — | the spec creates AHR pool `ahrpv`; blocked by the stale mdadm.conf names (brief) | — |
| ahr-cache-review shape 3 | Destroy refuses a foreign PV | not run | — | the fixture's VG is `gtcache`; blocked by the stale mdadm.conf names (brief) | — |

The vdev-consumers runs before and during the fix are kept (`out/r7-vdev-consumers-before.log`, `-fix-run0.log` — the
confirm names kernel partitions because the fixture builds the pool from kernel names, (b) in my first draft —
`-fix-run0b.log` — the skipped entries carry `leaf`, not `device`, (b) again).

**Verdict:** vdev-consumers 225 fixed (more than one line, as briefed) and green five times; cloud-tasks-api 640–642 green
three times with no change (cr.48 removed the race); smbsvc-api 5 and ahr-cache-review 3 not run — blocked by the
mdadm.conf names (`ahrpv`, `gtcache`) the brief rules out. The edited spec passes eslint and the root typecheck.

---

## Findings

No product defect (D12+) was found in this pass. Two findings for the operator, and the brief-vs-EPICS notes above:

| # | Kind | What | Evidence | Where |
|---|---|---|---|---|
| F1 | node fact → design question | A LOCKED encrypted ZFS dataset (key not loaded) anywhere on the node makes `zfs userspace`/`groupspace` exit 255 "cannot get used/quota for <ds>: permission denied", so every automatic uid/gid pick refuses 409 `id-check-unreadable` until its key is loaded. An explicit id still works and the sentence says so. Working as cr.29 ruled (unreadable refuses); with encryption on the 0.4.x slate (issue #69) a node that boots with a locked dataset cannot add a share user without typing an id. | row 5 item 1a/1b | `services/identity-ids.ts:275-290` (`zfsOwners` treats any non-zero exit as unreadable) |
| F2 | ZFS fact → cr.47 (c) wording | A running `zfs send` does not stop `zfs rename -r` of the snapshot it reads (it does stop a destroy). The send completes and the receiver gets the old name. If (c) moves snapshot rename to a SHARED lock on the strength of "ZFS's own busy refusal", that refusal does not exist for rename. | row 6 (c3), r6b | EPICS cr.47 (c) |
| N1 | note | During a gateway restart under load, one request in 2813 got Fastify's own 503 body (`return503OnClosing`) instead of the ANAS envelope; the window is ~0.2 s of 502/503, never 401. | row 20 run 2 | gateway `server.ts` (Fastify defaults) |

---

## Node state at the start and the end of the pass

`out/node-state-start.log`, `out/node-state-end.log` (`docs/probes/wave2-node/node-state.sh`).

| Item | Start | End |
|---|---|---|
| ADOCK | CT 9900 `ingress-default` stopped, protection 1, onboot 0, tags `adock;adock-ingress;adock-net-default`, the same description; adock/adockd active; `/adock/` 401 | same (row 15 also: `/adock/installed` 200 with a root cookie) |
| `ls /anas /adock` | No such file or directory (both) | same |
| `pct list` | 9900 stopped `ingress-default` | same |
| `zpool list` | gtbackup, gtiscsi ONLINE (pvfix/sysfix absent — the pvepool fixture's loops did not survive the shut-off VM) | same (w2id, w2z, gtvdev created and destroyed) |
| `/etc/mdadm/mdadm.conf` | sha256 `b86d1eddd7fc3619…4c646fa1`, 2 ARRAY lines (`gtcache-r1`, `ahrpv-r1`) | identical — not edited; no AHR pool created |
| `/etc/lvm/archive` | 56 files | 56 |
| failed units | `zfs-import@anasactimport`, `zfs-import@anascomp` | same (wave 3b's `anas-cloud-gtcancel` was cleared by the reboot) |
| `/etc/fstab`, `/etc/exports`, `smb.conf` | `b3c85fb4`, `f1e3ca20`, `46779719` | same |
| `/etc/pve/user.cfg` | `ed65c582` (root@pam only) | `ed65c582` (the seven @pve users and `anas-g` removed) |
| `AnyEvent.pm` | `0aad1102` | same (the hook was already present) |
| AnasProxy.pm (`/usr/share/anas/perl`) | 9350 bytes, wave 3b's | 25493 bytes, `c6beac85a012f590` = the host's |
| `index.html.tpl` | `58b75a9a` | `d563d1a2` (bundle token re-stamped by the deploy) |
| `/run/anas/proxy.key` | absent (pre-cr.27 build) | root:www-data 0640, 32 bytes (rotated by rows 12 and 20) |
| share-band accounts | debian (1000) | debian (1000) — every `w2u*`/`w2g*`/`w2ui*`, and the cloud fixture's `rclonegt`, removed |
| VGs / md / dm / loops / nft tables / NFS mounts / hot disks | none | none (hot disk 9 attached and detached by the vdev fixture; nft `inet w2bh` removed) |
| `/etc/anas/rclone.conf` | 0 bytes | 0 bytes (the cloud fixture captured and restored it) |
| backup repos / tasks / schedules / cloud remotes / tasks | `pbsgt` / none / none / none / none | same |
| packages | no targetcli-fb, strace, lsof, pv | same |
| `w2*` objects | — | none (`/var/tmp/w2` removed; no pool, dataset, unit, remote, repo, task, account or process left — `out/node-state-end-extra.log`) |
| anasd / anas / pveproxy | pids 1304 / 1308 / 1412 after boot | anasd 2532 (deploy), anas 28450 (row 20 restart), pveproxy master 1412 (reloaded once, by the installer); NRestarts 0 each; `/v1/health` abandonedCommands `[]` |
| PBS VM anas-pbs | shut off | booted for row 3's read-only listing, shut down again at the end |
| stunt node VM | shut off | left running with this build deployed |

## Summary

| Row | Verdict | One line |
|---|---|---|
| R0 deploy | PROVEN | `455ff82` deployed; 2192 dist files identical host vs node; AnasProxy.pm identical |
| 1 cr.27 | PROVEN (§8 rows 1–15, 17; review rows 18–21); row 16 not run | PVE's own verifiers decide: each user's 200/401/403 as the table says, every refusal logged; propagate-0 and group grants work; a disabled user is refused on the next request; the loopback port and `:85` refuse; `prove` 176 + 57 tests on the node, the 57 against the real PVE modules; key readable by www-data only; a gateway restart under load gives ~0.2 s of 502/503 and no 401; `_respond_502` logs; the upgrade install reloads pveproxy only when the module changed |
| 2 cr.28 | PROVEN; udev half partial | Audit-only POST over the socket 403 with an audit `job.refused`; both privileges 202; a `read.*` job and its cancel accepted on Sys.Audit, refused through `/anas`; a direct run's cancel on Sys.Audit 403; schedule runner and Run-Now units run; the udev script's identity submits (its event job needs an AHR pool) |
| 3 cr.48 | PROVEN | preview, remote test, catalog listing: 202 `read.*`, polled, `job.result`; Cancel with no confirm empties the child's process group; the preview survived 17 s; the three dialogs proven in the browser |
| 4 cr.49 | PROVEN | three Run-Nows: three supervisors and three direct runs all running at once, each direct run started the ms it was submitted (twice) |
| 5 cr.29/29b/29c/29d | PROVEN | picked id + `explicit:false`; held id 409; same-number confirm on both doors; `primaryGroup`; like-named group delete; Advanced sections and band-only lists in the browser; a locked encrypted dataset blocks every automatic pick (F1) |
| 6 cr.47 probe | DONE | (e) `zfs destroy -r <fs>` over a held child snapshot is PARTIAL; (c) recursive snapshot destroy and rename are ATOMIC; rename is not stopped by a hold or a running send (F2) |
| 7 cr.25b | RUN, classified | vdev-consumers (c) re-cut to nf.2 D5, 5 × green; cloud-tasks-api green ×3 unchanged (cr.48); smbsvc-api 5, ahr-cache-review 3 blocked by the mdadm.conf names |
| 8 node state | CLEAN | mdadm.conf, LVM archive, failed units, ADOCK, fstab/exports/smb.conf, user.cfg as at the start |
