# ANAS 0.4.4 wave 2 — authorization, CSRF and the uid-reuse guard (design pass)

**Status:** design only, 2026-10-15, at main `67e7a9e`. Nothing here is built. The coordinator inks the
rulings and cuts the stories; section 9 lists the proposed ones (cr.25 onwards). Inputs: the 2026-10-14
code review (Amplifier note, H1, M6 #25), EPICS §2 ("Authorization follows PVE", "Shares & identities"),
PRINCIPLES §3/§10/§11/§14, DESIGN (authentication, gateway, transport, identity rows), ADOCK story 15.3.

**Evidence tags.** `[P0n]` = a read-only capture from the stunt node, checked in under
`docs/probes/wave2/0n-*.txt` (PVE 9.2.21, libpve-access-control 9.1.2, libpve-http-server-perl 6.0.5,
proxmox-widget-toolkit 5.2.10, passwd 4.17.4, OpenZFS 2.4.4). PVE source lines are cited as
`File.pm:line` on those versions and are quoted in the probe files. `[C]` = this repository at `67e7a9e`,
re-read for this pass. **[U]** = not verified; the reason is given where it appears. Nothing was written,
installed or restarted on the node; no PVE user, token or ACL was created (the live smoke in section 8
needs them and belongs to a node pass).

---

## 0. Summary

| Piece | Recommendation |
|---|---|
| ACL path | `/`, exactly as PVE's own ZFS/LVM/directory disk API: `Sys.Audit` on `/` to read, `Sys.Modify` on `/` to change. Among the built-in roles only `Administrator` carries `Sys.Modify` [P02]. |
| Where | **Inside pveproxy, by PVE's own code.** `AnasProxy.pm` calls the same `auth_handler` pveproxy calls for `/api2` (ticket, user enabled, TFA state, CSRF) and the same `$rpcenv->check` it uses for permissions, then hands the gateway a signed statement: who the user is and which of the two privileges PVE grants on `/`. The gateway applies the one rule (GET/HEAD → `Sys.Audit`, everything else → `Sys.Modify`), answers the 403, and passes the full user id (with realm) to the daemon. No network call, no cache, works the same on a standalone node and in a cluster. |
| Rule | Method-based, no exceptions, no table to maintain. 160 daemon routes: 54 reads, 106 changes (section 4). No GET was found that changes system state. |
| Daemon backstop | The job queue refuses a job whose requester lacks `Sys.Modify` (all mutations are jobs, Principle 4), so a future GET that submits a job cannot slip past the method rule. |
| CSRF | Verified by PVE's own `verify_csrf_prevention_token`, called inside `auth_handler`, for every method except GET (PVE's own condition). The UI reads `Proxmox.CSRFPreventionToken` on each call (PVE refreshes it on ticket renewal) and sends it on every request; the gateway forwards it on cross-node hops. The daemon accepts JSON bodies only (415 otherwise). |
| API tokens | Not accepted today (the gateway reads only `PVEAuthCookie`). Keep it that way in 0.4.4 and say so in the refusal; the design leaves a ten-line door. |
| uid reuse | **Delete keeps the number** (a tombstone: the account is renamed `anas-deleted-<uid>`, locked, expired, stripped of groups and SMB entry), so `useradd`'s own allocator can never hand it out again — the only stateless rule that also covers exported pools, offline disks, backups and replicas. Plus an explicit `-u`/`-g` at create that skips every id still visible in ZFS's own per-uid accounting, the managed roots' ACLs, the Samba passdb and `/etc/exports`, for ids freed before this ships or by hand. **Needs an operator ruling** (section 10, Q1). |
| Order | UI and clients send the token first (harmless), then the proxy/gateway enforcement as ONE merge, then the daemon backstop; the 415 rule and the identity stories are independent. |

---

## 1. Facts this design stands on

**F1. PVE authenticates only inside its `/api2` branch; `/anas` arrives with `$auth = {}`.**
`authenticate_and_handle_request` reads the cookie, the `CSRFPreventionToken` header and the
`Authorization` header and calls `$self->auth_handler(...)` only inside `elsif ($path =~ m/^\Q$base_uri\E/)`
(`AnyEvent.pm:1590`, call at `:1622`); then `handle_request` runs the `/api2` dispatch (`:1226`) and only
after it the spliced ANAS hook (`:1229-1238`) and ADOCK's (`:1239-1248`) [P01]. So neither the ticket nor
the CSRF token is checked by PVE for `/anas/*` today, which is review H1. The access log shows it: `/anas`
lines carry user `-`, `/api2` lines carry `root@pam` [P01, tail of access.log].

**F2. pveproxy itself runs the permission check, as `www-data`, before it proxies to pvedaemon.**
`PVE::HTTPServer::rest_handler` calls `$rpcenv->check_api2_permissions(...)` (`HTTPServer.pm:174`) and
only then proxies protected calls to pvedaemon (`:193-194`); pveproxy workers run as `www-data`
[P01]. `www-data` can read everything the check needs: `/etc/pve/user.cfg`, `/etc/pve/authkey.pub` and the
CSRF secret `/etc/pve/pve-www.key` are `root:www-data 0640`; the private key `priv/authkey.key` is not
readable [P03].

**F3. The whole chain works in-process as `www-data`, in about a millisecond.** A script piped on stdin
and run as `www-data` [P04]: `verify_ticket` 0.8-1.1 ms (RSA), `check_user_enabled` ok, `check(root@pam, /,
Sys.Modify)` allowed in 0.005 ms, a user without ACL refused, `verify_csrf_prevention_token` 0.008 ms and
refusing another user's token and garbage. `init_request` costs 8-10 ms on a fresh environment and 0.06-0.3
ms when `user.cfg`'s version is unchanged (`RPCEnvironment.pm:596-640`: it re-reads `user.cfg` only when
pmxcfs reports a new version, so a revoked ACL takes effect on the next request).

**F4. A valid signature is not a valid user.** In the same probe a ticket minted for a non-existent user
passed `verify_ticket`; only `check_user_enabled` refused it [P04, earlier run]. ANAS's gateway verifies
signature and age only (`packages/gateway/src/auth/providers/pve.ts:50-74` [C]), so a PVE user who is
disabled, expired or deleted keeps full ANAS access until the ticket's two hours run out.

**F5. ANAS drops the realm.** The gateway's ticket regex keeps only the part before `@`
(`pve.ts:7`) and resolves a uid with `id -u <name>` (`:158-171`) [C]: `alice@pve` is audited as `alice`
and given the uid of an unrelated local `alice` (review M6 #45).

**F6. PVE's privileges for its own storage verbs** [P02]: `Disks/ZFS.pm` index and detail
`['perm','/',['Sys.Audit']]`, create and delete `['perm','/',['Sys.Modify']]`; `Disks/LVM.pm`,
`LVMThin.pm`, `Directory.pm` the same; `Disks.pm` list `or('/' Sys.Audit, '/nodes/{node}' Sys.Audit)`,
smart `/` Sys.Audit, initgpt `/` Sys.Modify; `wipe_disk` declares no permissions block, which
`check_api2_permissions` turns into root@pam only (`RPCEnvironment.pm:549-566`). Node services, network and
APT use `/nodes/{node}`; `storage.cfg` edits and storage scans use `/storage` + `Datastore.Allocate`.
Built-in roles: `Sys.Audit` in Administrator, PVEAdmin, PVEAuditor, PVESysAdmin; `Sys.Modify` in
**Administrator only** [P02].

**F7. A privilege is granted when its key is defined, whatever its value.** `permissions()` returns
`privilege → propagate flag`; PVE's own comment says "to determine whether a privilege is set, check for
definedness" (`RPCEnvironment.pm:121-131`) and `check()` tests `defined` (`:291-305`). The REST
`GET /access/permissions` returns the same map, so a grant made with `--propagate 0` reads as `0` [P02].

**F8. The standalone node has no `nodelist`.** `/etc/pve/.members` on the stunt node is
`{"nodename":"anas-pve","version":0}` [P05] — the shape that made ADOCK 15.3 answer 502 to everyone.

**F9. PVE's CSRF token** [P03]: `"<8 hex timestamp>:" . base64(HMAC-SHA256("<ts>:<userid>", secret))`
where `secret = HMAC-SHA256-base64 of the contents of /etc/pve/pve-www.key` (legacy 27-character SHA-1
form still accepted, `AccessControl.pm:343-361`, `Ticket.pm:19-50`). It is bound to the **user id and the
timestamp only**, not to the ticket; valid from 5 minutes in the future to 2 hours old. `pve-www.key` lives
in pmxcfs, so a token is valid on every node of the cluster. `auth_handler` checks it for every method
except GET, and only when the server's euid is not 0 (`HTTPServer.pm:126-130`). The PVE UI holds it in
the global `Proxmox.CSRFPreventionToken` (index page `[% token %]`, refreshed by `setAuthData` on every
ticket renewal) and adds it to every `Ext.Ajax` request in a `beforerequest` hook (`proxmoxlib.js:29-41,
328-346`).

**F10. The hook also runs inside pvedaemon.** `GET http://127.0.0.1:85/anas/installed` answers ANAS's
JSON through `pve-api-daemon/3.0` [P07]: the spliced block runs in any server built on
`PVE::APIServer::AnyEvent` that reaches `handle_request`. pvedaemon is root and `trusted_env`, where
`auth_handler` skips the CSRF check (F9). spiceproxy branches off before `handle_request` (`AnyEvent.pm:1578`).

**F11. The gateway is reachable by any local uid.** It listens on `127.0.0.1:3000` [P05]; the stunt node
already has a second login account (`debian`, uid 1000, bash). A PAM-realm PVE user is usually also a Linux
login. Whatever the gateway trusts must therefore be something only pveproxy (or root) can produce.

**F12. A changed `AnasProxy.pm` is not picked up by running workers.** The hook `require`s the module by
path (cached per process); `install.sh` reinstalls the file (`install.sh:211`) but restarts pveproxy only
when it splices the hook, and returns early when the marker is already there (`:219-222`) [C]. Workers
exit after 1000 requests (`pveproxy.pm:102`) [P01], so on an idle node an old module can serve for days.

**F13. Every daemon route is reached either through the gateway or over the root-only socket.** The
socket is `root:root 0600` [P05] (`packages/daemon/src/index.ts:44-55` [C]); the timer runner
(`runner-poll.ts:57-59`, identity `root@pam`) and the udev cache-event script use it directly. Neither is
affected by a check in pveproxy.

**F14. Identity allocation facts** [P06]: `UID_MIN 1000`, `UID_MAX 60000`, same for GIDs;
`useradd -D` gives `GROUP=100`; ANAS creates users with `useradd -N -M -s nologin` and no `-u`
(`share-identity.ts:540, 582`), groups with `groupadd <name>` and no `-g` (`:780`), and deletes with
`userdel`/`groupdel` (`:950, :1033`) [C]. `useradd` offers `-u`, `-K KEY=VALUE`, `-o`; nothing remembers a
deleted id. `zfs userspace -Hpn` answered in 6-12 ms on a pool with `feature@userobj_accounting` active;
it accepts a filesystem, a snapshot or a path.

---

## 2. Authorization

### A1. Which ACL path, which privilege

**Decision:** reads need `Sys.Audit` on `/`, changes need `Sys.Modify` on `/`; nothing else is consulted.

- **Why `/`:** ANAS's verbs are PVE's disk verbs extended (pools, datasets, md/btrfs pools, shares on
  them). PVE checks its ZFS, LVM, LVM-thin and directory create/delete against `/` (F6), so a user who can
  create a ZFS pool in PVE can create one in ANAS and nobody else can. `Disks.pm` list also accepts
  `Sys.Audit` on `/nodes/{node}`; ANAS does not, so that a per-node grant never opens a read in ANAS that the
  ZFS panel next to it refuses (ZFS index is `/` only).
- **Alternative `/nodes/{node}`:** would allow per-node delegation, which PVE does not offer for these
  verbs. Rejected: it invents a permission PVE does not have.
- **Alternative per-route privileges (ADOCK's table):** ADOCK needs it because its verbs map to
  `VM.Allocate`, `Datastore.AllocateSpace`, `VM.PowerMgmt`. ANAS's ruling is two privileges by method, so a
  table would only restate the method.
- **What it means for operators:** `PVEAuditor`, `PVESysAdmin` and `PVEAdmin` users can see ANAS and change
  nothing; `Administrator` (or a custom role with `Sys.Modify`) on `/` can change. This matches PVE: a
  `PVEAdmin` cannot create a ZFS pool either. root@pam passes every check (`RPCEnvironment.pm:556`).
- **PVE's root-only wipe:** PVE reserves its standalone `wipedisk` for root@pam (F6). ANAS has no
  standalone wipe; its wipes happen inside create/destroy/attach flows, which PVE gates with `Sys.Modify`.
  No extra rule.

### A2. Where the check is made

| | (a) inside `AnasProxy.pm`, in pveproxy | (b) gateway → PVE API over loopback (ADOCK) | (c) gateway reads `user.cfg` itself |
|---|---|---|---|
| Verified user | PVE's own `auth_handler`: ticket, user enabled/expiry, TFA half-tickets, realm kept (F1, F3) | the API answers for the ticket; the gateway still needs its own ticket verification for GETs and identity (today's has F4/F5) | gateway's own RSA verification (F4/F5 remain) |
| CSRF state | the header is in the request; PVE's verifier runs (F9) | header forwarded; gateway must **reimplement** PVE's HMAC with `pve-www.key` (legacy SHA-1 branch, age window) — no PVE endpoint verifies a token without performing a mutation | same reimplementation |
| Privilege answer | `$rpcenv->check($user, '/', [$priv], 1)` — PVE's own compile of roles, groups, propagate, NoAccess, pools, token privsep (F7) | `GET /api2/json/access/permissions?path=/` — PVE's answer, but over HTTPS | a reimplementation of `compile_acl_path` and `roles()` — the undifferentiated code PRINCIPLES §15 forbids, and it drifts with every PVE release |
| Cost per request | ~1 ms RSA + sub-ms rest, synchronous in the worker, the same work pveproxy does for every `/api2` call (F3) | one TLS round trip to pveproxy per request, or a cache (ADOCK: 60 s per ticket = 60 s revocation lag) | a file read + ACL compile per request or a cache |
| Standalone / cluster | identical: `user.cfg`, `authkey.pub`, `pve-www.key` are pmxcfs files on every node | must dial `127.0.0.1:8006`; ADOCK dialled the membership IP and 502'd for everyone on a standalone node (F8) | identical |
| PVE API down | not involved; if pmxcfs is down `init_request` fails → 503 with the reason (and PVE's own UI is down too) | pveproxy down → `/anas` is down anyway; a pvedaemon/pveproxy hiccup → fail closed 502 | not involved |
| Refusal logging | syslog from the worker (journal unit `pveproxy`), and the access log gains the user id (`$reqstate->{log}{userid}`) | gateway log | gateway log |
| Trust to the gateway | needs a hand-off the gateway can verify (F11) — A2.1 | none extra | none extra |

**Decision: (a), with the policy in the gateway.** pveproxy is where PVE itself answers both questions
(F2), it has the user, the CSRF header and PVE's verifiers in hand, it costs what one PVE API call costs,
and it has no network path to get wrong — the failure that killed ADOCK 15.3 cannot happen. It also closes
F4 and F5 for free, because the user comes from PVE's `auth_handler` instead of ANAS's regex.

The split keeps each language doing what only it can: **Perl asks PVE** (who is it, did CSRF pass, which
of `Sys.Audit`/`Sys.Modify` does PVE grant on `/`); **TypeScript decides** (the method rule, the 403
sentence, the shared `ErrorCode`, unit tests in CI). The rule exists once.

**Calling `auth_handler` rather than its parts.** `AnasProxy` calls `$self->auth_handler($method, $path,
$ticket, $csrf, undef, $peer_host)` — the method pveproxy itself calls at `AnyEvent.pm:1622`. When PVE
changes how a ticket is verified (TFA, new ticket kinds, key rotation clamps), ANAS changes with it. For
`/anas/...` paths none of its URI special cases match (`HTTPServer.pm:70-76`, upload regex `:115`), so it
performs: `init_request`, `verify_ticket` + `check_user_enabled`, the TFA refusal, `set_user`, and the
CSRF check for non-GET. The API-token argument is passed as `undef` (A5). This is an internal PVE
interface, as is the hook's anchor today; the apt re-apply hook already re-runs the installer after PVE
upgrades, and every failure of the call is a logged refusal (section 5), never a pass.

**ADOCK's version, and what this changes.** ADOCK's gateway calls `/access/permissions` without a path and
tests `perms[path][priv] === 1` (`adock/packages/gateway/src/authz.ts:177`). Besides the membership-IP
dial, that comparison refuses a grant made with `--propagate 0`, whose value is `0` (F7). GETs need only
the ticket there; ANAS's ruling requires `Sys.Audit`. ADOCK keeps its own ticket verifier and has no
CSRF check yet. ANAS copies the ruling's shape (PVE decides, one rule, 403 names privilege and path, fail
closed, logged) and none of the mechanism.

### A2.1 The hand-off from pveproxy to the gateway

The gateway must only believe statements pveproxy made (F11). **Decision: an HMAC-signed header.**

- At startup the gateway creates 32 random bytes, writes them atomically to `/run/anas/proxy.key`
  (`root:www-data 0640`; `/run/anas` is `0755` [P05]) and keeps them in memory. A restart rotates it. It is a
  runtime credential like the socket, not state about what ANAS manages (Principle 11).
- `AnasProxy` reads the key (cached by device/inode/mtime), removes any client-supplied `X-Anas-Auth`, and
  adds `X-Anas-Auth: v1;user=<userid>;privs=<Sys.Audit,Sys.Modify|Sys.Audit|>;ts=<epoch>;mac=<hex>` where the
  MAC is HMAC-SHA256 over `v1 \n userid \n privs \n ts \n METHOD \n path?query` (the path as forwarded, i.e.
  without `/anas`). `Digest::SHA` is already loaded by PVE (F9).
- The gateway checks the MAC in constant time, `|now − ts| ≤ 30 s`, and that method and path match the
  request it received; then applies the rule. A missing, stale, mismatched or forged header is a 401 with
  the reason logged (section 5).
- **Alternative: a unix socket `root:www-data 0660` instead of TCP**, so the kernel restricts who can reach
  the gateway and a plain header suffices. It also removes the port setting (issue #2). Not chosen for a
  point release: it changes the transport (PROXY-TRANSPORT-DESIGN, both installers, `AnyEvent::HTTP`'s
  connect override **[U]** — documented in AnyEvent::HTTP from memory, not tried). Worth a later story.
- **Alternative: the gateway keeps verifying the ticket and trusts a plain privilege header.** Rejected: a
  local user holding any low-privilege ticket could add the header (F11).

The gateway's own RSA ticket verification leaves the request path (single source of truth: PVE's
verifier); `PveAuthProvider.isAvailable()` stays as the dev-auth guard.

### A2.2 Refusing outside pveproxy

`AnasProxy::handle` refuses with 404 + a syslog line ("ANAS is served through pveproxy on :8006 only")
when `$self->{trusted_env}` is set or `$> == 0`, i.e. inside pvedaemon (F10), where `auth_handler` would
skip CSRF. The presence probe `/anas/installed` is refused there too; nothing in ANAS uses `:85`.

### A3. Which routes are reads and which are changes

**Decision: method-based, no exceptions.** GET and HEAD need `Sys.Audit`; POST, PUT, DELETE, PATCH need
`Sys.Modify`. The full table is section 4; what the review asked to look for:

- **GETs that change state:** none found. A scan of every GET handler body in `routes/*.ts` for job
  submission, config writes, `known_hosts`, mkdir/unlink/rename found nothing (grep-level, not a proof; the
  daemon backstop in A3.1 is what makes it safe against a future one). Six GETs reach out of the node with
  stored credentials or root's key — replication remote/peer pool lists (ssh, constant `zpool list`), PBS
  snapshot and group lists — and `GET /fs/browse` lists directory names anywhere on the host. They read, so
  they stay `Sys.Audit` under the ruling. PVE's storage *scans* need `Datastore.Allocate` (F6), but those
  take caller-supplied targets and credentials; ANAS's take only stored ones.
- **POSTs that only read:** `ahr/layout/preview`, `ahr/:name/expand/plan`, `backup/tasks/preview-nested`,
  `backup/tasks/:name/prune-preview`, `backup/restore/browse` (file names inside a backup), `cloud/tasks/preview`,
  and the test endpoints. They stay `Sys.Modify`: each sits in a create/change dialog the `Sys.Audit` user
  cannot complete anyway, several act outbound with secrets, and `mounts/test` mounts, `replication/remotes/test?pin`
  writes `known_hosts`. An exception list would be a second rule to keep true.
- **Gateway routes:** `GET /installed` stays unauthenticated (the only exemption); `GET /api/health` needs
  `Sys.Audit`.

### A3.1 Daemon backstop: jobs need `Sys.Modify`

All mutations are jobs (Principle 4), so `jobQueue.submit` is the one place every change passes. The
gateway sends `x-anas-privileges` (the signed set) with every forwarded request; `RequestHeaders` reads it
as optional; `submit` refuses (403 `FORBIDDEN`, logged) when the header is present and lacks `Sys.Modify`.
An absent header means a root socket client (runner, udev script — F13), which Principle 9 already trusts.
This catches a GET that submits a job, and any gateway policy bug, without a second copy of the method rule.
*(As built, cr.28: the header is REQUIRED — absent or unreadable is refused, fail closed — and the runner and
the udev script send `Sys.Audit,Sys.Modify`; the queue reads the request's privileges from an async-local
store the daemon's hooks fill, not from the submitter; a `read.*` job and its cancel need `Sys.Audit`.)*

### A4. Dev provider and the test suites

- **Dev loop** (`ANAS_AUTH_PROVIDER=dev`, no pveproxy): unchanged — the gateway skips the hand-off and
  grants both privileges; it still refuses to arm on a real node (`auth/index.ts:23-38`).
- **Integration specs** run through `:8006/anas` with a real root@pam login, so they meet the real check.
  UI specs get the token from the PVE index page like a browser does. API specs build 56 request contexts in
  31 files with the cookie only [C]; they move to one fixture helper that sets the cookie AND
  `CSRFPreventionToken` (`extraHTTPHeaders`) from the same `/access/ticket` reply (cr.25b).
- **Capture rule (EPICS §2 (l)):** no test fake answers with a string its author typed.
  - The Perl side is split into pure helpers (route the request, build/verify the assertion, map an
    `auth_handler` error to a refusal) and a thin PVE binding. CI tests the helpers with a fake `check`
    that answers from **captured** `pvesh get /access/permissions --userid <u> --path / --output-format json`
    replies, using PVE's definedness rule (F7) — the propagate-0 capture is the case that catches an
    ADOCK-style `=== 1`.
  - The PVE binding is tested **on the node** against a captured `user.cfg`, through PVE's own regression
    hook `init_request(userconfig => <file>)` (`RPCEnvironment.pm:596-625`), with real tickets and CSRF
    tokens minted at test time (they expire, so they cannot be fixtures). Run by `prove` on the stunt node.
  - The gateway's HMAC is ANAS's own format; its tests sign with a test key.
  - Captured shapes checked in as fixtures: a ticket line and a CSRF token line with the signature
    redacted, the `.members` file of a standalone node [P05], the permission replies, `user.cfg`.

### A5. PVE API tokens

**Today:** not accepted. The gateway reads only `PVEAuthCookie` (`server.ts:86`) [C]; an
`Authorization: PVEAPIToken=…` request is a 401 "Access ANAS through the Proxmox UI".

**Decision for 0.4.4:** keep it closed — the API serves ANAS's UI and tests (memory: API optimised for the
UI), a point release adds no workflow. `AnasProxy` answers a request that carries an API token with a 401
that says so ("PVE API tokens are not accepted by ANAS"), logged. **Later, if wanted:** pass the token to
`auth_handler` (PVE verifies it, skips CSRF as PVE does for tokens, and `$rpcenv->check` already intersects
privilege-separated token rights, `RPCEnvironment.pm` `permissions`). That is the whole change.

---

## 3. CSRF

**Who verifies:** PVE, inside `auth_handler`, with `verify_csrf_prevention_token` and the secret derived
from `/etc/pve/pve-www.key` (F9). No reimplementation in TypeScript: the HMAC is short, but the legacy
SHA-1 branch, the age window and the secret derivation are PVE's to change.

**Which methods:** every method except GET, as PVE (`$method ne 'GET'`); HEAD therefore needs it, which no
ANAS client sends. **Token binding:** user id and timestamp, not the ticket; lifetime 2 h, 5 min clock
skew; cluster-valid. A token minted for root@pam is refused for alice@pve [P04].

**How the UI sends it:** `10-api.js` `doFetch` (`:48-59`) adds `CSRFPreventionToken:
Proxmox.CSRFPreventionToken` on every request, read **at call time** from the PVE global (PVE replaces it on
every ticket renewal, F9; a cached copy would expire after 2 h). When the global is absent the header is
omitted and the request fails with PVE's sentence, never with a script error. `ANAS.api` is the only path:
the two `Ext.Ajax` calls in `70-shares.js:170` and `75-iscsi.js:793` go to `/api2` and already get the
token from PVE's own hook.

**Cross-node:** the gateway's peer forward copies `cookie`, `content-type`, `x-anas-confirm`
(`proxy.ts:287-291`) and must add `csrfpreventiontoken`; the peer's pveproxy then authenticates and checks
the token again for the node that does the work. A peer on an older ANAS whose gateway does not forward the
token answers 401 to cross-node mutations; the refusal says so when the request carries
`x-anas-forwarded` ("forwarded without a CSRF token — the forwarding node's ANAS is older than this one").
Mixed versions during a rolling upgrade fail closed, with that sentence.

**The daemon refuses non-JSON bodies.** Today Fastify's default `text/plain` parser is still registered
(`server.ts` creates `Fastify()` with defaults [C]), so a plain form can drive body-less POSTs (review H1).
Rule (an `onRequest` hook): for POST/PUT/DELETE/PATCH, a `Content-Type` that is present and not
`application/json` is a **415** naming the type, with or without a body, and a body without a
`Content-Type` is a 415; the `text/plain` parser is removed. In-tree clients already comply: the UI sets
the type only with a body, the gateway the same (`proxy.ts:130-133`), the runner always sends JSON
(`runner-poll.ts:57`), the cache-event script sends JSON. This is defence in depth: the CSRF token is the
fix.

---

## 4. Route → privilege table

Extracted 2026-10-15 at `67e7a9e` from every `server.<method>(` registration in
`packages/daemon/src/routes/*.ts` (regex over the source, with the template-literal paths read whole) plus
the gateway's own routes. Paths are as the daemon registers them under its `/v1` prefix. The DESIGN route
index lists `GET /v1/iscsi/targets/:iqn/luns/:lun`, which no route registers (already noted by cr.10).

| Method | Path (behind `/anas/api/nodes/<node>`) | Needs on `/` | Registered at | Note |
|---|---|---|---|---|
| `GET` | `/anas/installed` (gateway) | nothing (unauthenticated) | `packages/gateway/src/server.ts:70` | the only exemption; AnasProxy forwards it without authenticating |
| `GET` | `/anas/api/health` (gateway) | Sys.Audit | `packages/gateway/src/server.ts:101` | gateway health |
| `GET` | `/v1/ahr/:name/access` | Sys.Audit | `ahr-access.ts:76` |  |
| `PUT` | `/v1/ahr/:name/access` | Sys.Modify | `ahr-access.ts:89` |  |
| `POST` | `/v1/ahr/:name/cache` | Sys.Modify | `ahr-cache.ts:115` |  |
| `DELETE` | `/v1/ahr/:name/cache` | Sys.Modify | `ahr-cache.ts:215` |  |
| `POST` | `/v1/ahr/:name/cache/event` | Sys.Modify | `ahr-cache.ts:295` | normally reached by the udev script over the root socket, never through the gateway |
| `POST` | `/v1/ahr/:name/expand/plan` | Sys.Modify | `ahr-expand.ts:244` | reads (plan only); Modify by the method rule |
| `POST` | `/v1/ahr/:name/expand` | Sys.Modify | `ahr-expand.ts:276` |  |
| `POST` | `/v1/ahr/:name/expand/resume` | Sys.Modify | `ahr-expand.ts:343` |  |
| `POST` | `/v1/ahr/:name/expand/abandon` | Sys.Modify | `ahr-expand.ts:406` |  |
| `POST` | `/v1/ahr/:name/disk/:oldId/replace` | Sys.Modify | `ahr-expand.ts:448` |  |
| `POST` | `/v1/ahr/:name/disk/:id/readd` | Sys.Modify | `ahr-expand.ts:522` |  |
| `POST` | `/v1/ahr` | Sys.Modify | `ahr-mutate.ts:472` |  |
| `PUT` | `/v1/ahr/:name/mountpoint` | Sys.Modify | `ahr-mutate.ts:626` |  |
| `POST` | `/v1/ahr/:name/remount` | Sys.Modify | `ahr-mutate.ts:730` |  |
| `DELETE` | `/v1/ahr/:name` | Sys.Modify | `ahr-mutate.ts:803` |  |
| `POST` | `/v1/ahr/:name/scrub` | Sys.Modify | `ahr-mutate.ts:944` |  |
| `POST` | `/v1/ahr/:name/repair` | Sys.Modify | `ahr-mutate.ts:1025` |  |
| `POST` | `/v1/ahr/:name/parity-rewrite` | Sys.Modify | `ahr-mutate.ts:1200` |  |
| `POST` | `/v1/ahr/:name/mirror-reconcile` | Sys.Modify | `ahr-mutate.ts:1348` |  |
| `GET` | `/v1/ahr/:name/snapshots` | Sys.Audit | `ahr-snapshots.ts:133` |  |
| `POST` | `/v1/ahr/:name/snapshots` | Sys.Modify | `ahr-snapshots.ts:143` |  |
| `DELETE` | `/v1/ahr/:name/snapshots/:snap` | Sys.Modify | `ahr-snapshots.ts:176` |  |
| `POST` | `/v1/ahr/:name/snapshots/:snap/rollback` | Sys.Modify | `ahr-snapshots.ts:215` |  |
| `POST` | `/v1/ahr/:name/spare` | Sys.Modify | `ahr-spare.ts:73` |  |
| `DELETE` | `/v1/ahr/:name/spare/:id` | Sys.Modify | `ahr-spare.ts:160` |  |
| `GET` | `/v1/ahr` | Sys.Audit | `ahr.ts:88` |  |
| `GET` | `/v1/ahr/:name` | Sys.Audit | `ahr.ts:94` |  |
| `POST` | `/v1/ahr/layout/preview` | Sys.Modify | `ahr.ts:109` | reads (pure layout computation); Modify by the method rule |
| `GET` | `/v1/backup/repos` | Sys.Audit | `backup.ts:338` |  |
| `POST` | `/v1/backup/repos` | Sys.Modify | `backup.ts:348` |  |
| `PUT` | `/v1/backup/repos/:name` | Sys.Modify | `backup.ts:395` |  |
| `DELETE` | `/v1/backup/repos/:name` | Sys.Modify | `backup.ts:471` |  |
| `POST` | `/v1/backup/repos/test` | Sys.Modify | `backup.ts:536` | diagnosis with caller-supplied credentials (outbound) |
| `GET` | `/v1/backup/tasks` | Sys.Audit | `backup.ts:823` |  |
| `POST` | `/v1/backup/tasks/preview-nested` | Sys.Modify | `backup.ts:870` | reads (nested-filesystem scan) |
| `GET` | `/v1/backup/lun-sources` | Sys.Audit | `backup.ts:945` |  |
| `GET` | `/v1/backup/tasks/:name` | Sys.Audit | `backup.ts:1009` |  |
| `POST` | `/v1/backup/tasks` | Sys.Modify | `backup.ts:1072` |  |
| `PUT` | `/v1/backup/tasks/:name` | Sys.Modify | `backup.ts:1117` |  |
| `DELETE` | `/v1/backup/tasks/:name` | Sys.Modify | `backup.ts:1162` |  |
| `POST` | `/v1/backup/tasks/:name/run` | Sys.Modify | `backup.ts:1200` |  |
| `POST` | `/v1/backup/tasks/:name/prune-preview` | Sys.Modify | `backup.ts:1382` | reads (PBS dry run with the stored secret) |
| `GET` | `/v1/backup/tasks/:name/snapshots` | Sys.Audit | `backup.ts:1522` | outbound: PBS listing with the stored repo secret |
| `GET` | `/v1/backup/repos/:name/groups` | Sys.Audit | `backup.ts:1568` | outbound: PBS listing with the stored repo secret |
| `POST` | `/v1/backup/restore/browse` | Sys.Modify | `backup.ts:1611` | reads backup CONTENT (file names inside a PBS snapshot) |
| `POST` | `/v1/backup/restore` | Sys.Modify | `backup.ts:1643` |  |
| `GET` | `/v1/cloud/providers` | Sys.Audit | `cloud.ts:315` |  |
| `GET` | `/v1/cloud/remotes` | Sys.Audit | `cloud.ts:323` |  |
| `POST` | `/v1/cloud/remotes` | Sys.Modify | `cloud.ts:340` |  |
| `PUT` | `/v1/cloud/remotes/:name` | Sys.Modify | `cloud.ts:390` |  |
| `DELETE` | `/v1/cloud/remotes/:name` | Sys.Modify | `cloud.ts:485` |  |
| `POST` | `/v1/cloud/remotes/test` | Sys.Modify | `cloud.ts:543` | diagnosis; runs rclone with caller-supplied or stored secrets |
| `GET` | `/v1/cloud/tasks` | Sys.Audit | `cloud.ts:667` |  |
| `POST` | `/v1/cloud/tasks` | Sys.Modify | `cloud.ts:698` |  |
| `POST` | `/v1/cloud/tasks/preview` | Sys.Modify | `cloud.ts:736` | rclone dry run against the remote (outbound, stored secrets) |
| `GET` | `/v1/cloud/tasks/:name` | Sys.Audit | `cloud.ts:803` |  |
| `PUT` | `/v1/cloud/tasks/:name` | Sys.Modify | `cloud.ts:852` |  |
| `DELETE` | `/v1/cloud/tasks/:name` | Sys.Modify | `cloud.ts:893` |  |
| `POST` | `/v1/cloud/tasks/:name/run` | Sys.Modify | `cloud.ts:928` |  |
| `GET` | `/v1/status` | Sys.Audit | `dashboard.ts:124` |  |
| `GET` | `/v1/telemetry` | Sys.Audit | `dashboard.ts:352` |  |
| `GET` | `/v1/pools/:name/datasets` | Sys.Audit | `datasets.ts:733` |  |
| `GET` | `/v1/pools/:name/datasets/*` | Sys.Audit | `datasets.ts:807` |  |
| `POST` | `/v1/pools/:name/datasets` | Sys.Modify | `datasets.ts:893` |  |
| `POST` | `/v1/pools/:name/datasets/*` | Sys.Modify | `datasets.ts:964` | one registration, several verbs by suffix (replicate, replicate/plan, snapshot rollback, clone, …) |
| `PUT` | `/v1/pools/:name/datasets/*` | Sys.Modify | `datasets.ts:1011` |  |
| `DELETE` | `/v1/pools/:name/datasets/*` | Sys.Modify | `datasets.ts:1290` |  |
| `GET` | `/v1/disks` | Sys.Audit | `disks.ts:444` |  |
| `GET` | `/v1/disks/:id` | Sys.Audit | `disks.ts:449` |  |
| `GET` | `/v1/disks/:id/smart` | Sys.Audit | `disks.ts:462` | runs smartctl (may wake a spun-down disk) |
| `GET` | `/v1/fs/browse` | Sys.Audit | `fs.ts:17` | lists directory names anywhere on the host (as root) |
| `GET` | `/v1/health` | Sys.Audit | `health.ts:5` | the panels' install probe (`20-notinstalled.js:135`): a 403 must not read as "not installed" |
| `POST` | `/v1/iscsi/targets` | Sys.Modify | `iscsi-mutate.ts:248` |  |
| `PUT` | `/v1/iscsi/targets/:iqn` | Sys.Modify | `iscsi-mutate.ts:314` |  |
| `POST` | `/v1/iscsi/targets/:iqn/state` | Sys.Modify | `iscsi-mutate.ts:465` |  |
| `DELETE` | `/v1/iscsi/targets/:iqn` | Sys.Modify | `iscsi-mutate.ts:516` |  |
| `POST` | `/v1/iscsi/targets/:iqn/luns` | Sys.Modify | `iscsi-mutate.ts:583` |  |
| `PUT` | `/v1/iscsi/targets/:iqn/luns/:n` | Sys.Modify | `iscsi-mutate.ts:698` |  |
| `DELETE` | `/v1/iscsi/targets/:iqn/luns/:n` | Sys.Modify | `iscsi-mutate.ts:926` |  |
| `POST` | `/v1/iscsi/health/repair` | Sys.Modify | `iscsi-mutate.ts:1083` |  |
| `GET` | `/v1/iscsi/claims` | Sys.Audit | `iscsi-mutate.ts:1140` |  |
| `GET` | `/v1/iscsi/targets` | Sys.Audit | `iscsi.ts:41` |  |
| `GET` | `/v1/iscsi/sessions` | Sys.Audit | `iscsi.ts:60` |  |
| `GET` | `/v1/iscsi/health` | Sys.Audit | `iscsi.ts:76` |  |
| `GET` | `/v1/iscsi/targets/:iqn` | Sys.Audit | `iscsi.ts:85` |  |
| `GET` | `/v1/jobs` | Sys.Audit | `jobs.ts:62` | every user's jobs, with createdBy |
| `GET` | `/v1/jobs/:id` | Sys.Audit | `jobs.ts:84` |  |
| `POST` | `/v1/jobs/:id/cancel` | Sys.Modify | `jobs.ts:116` | confirm-gated control job |
| `GET` | `/v1/mounts` | Sys.Audit | `mounts.ts:190` |  |
| `GET` | `/v1/mounts/:mountpoint` | Sys.Audit | `mounts.ts:207` |  |
| `POST` | `/v1/mounts` | Sys.Modify | `mounts.ts:220` |  |
| `PUT` | `/v1/mounts/:mountpoint` | Sys.Modify | `mounts.ts:355` |  |
| `POST` | `/v1/mounts/:mountpoint/state` | Sys.Modify | `mounts.ts:474` |  |
| `DELETE` | `/v1/mounts/:mountpoint` | Sys.Modify | `mounts.ts:621` |  |
| `POST` | `/v1/mounts/test` | Sys.Modify | `mounts.ts:733` | probe MOUNT (a transient system change) |
| `GET` | `/v1/pools` | Sys.Audit | `pools.ts:848` |  |
| `GET` | `/v1/pools/:name` | Sys.Audit | `pools.ts:943` |  |
| `POST` | `/v1/pools/:name/scrub` | Sys.Modify | `pools.ts:1017` |  |
| `POST` | `/v1/pools/:name/trim` | Sys.Modify | `pools.ts:1065` |  |
| `POST` | `/v1/pools/:name/upgrade` | Sys.Modify | `pools.ts:1112` |  |
| `PUT` | `/v1/pools/:name` | Sys.Modify | `pools.ts:1167` |  |
| `PUT` | `/v1/pools/:name/mountpoint` | Sys.Modify | `pools.ts:1239` |  |
| `POST` | `/v1/pools` | Sys.Modify | `pools.ts:1360` |  |
| `GET` | `/v1/pools/import` | Sys.Audit | `pools.ts:1485` | `zpool import` scan (read-only) |
| `POST` | `/v1/pools/import` | Sys.Modify | `pools.ts:1495` |  |
| `POST` | `/v1/pools/:name/vdevs` | Sys.Modify | `pools.ts:1591` |  |
| `POST` | `/v1/pools/:name/vdevs/remove` | Sys.Modify | `pools.ts:1698` |  |
| `GET` | `/v1/pools/:name/expansion` | Sys.Audit | `pools.ts:1804` |  |
| `POST` | `/v1/pools/:name/attach` | Sys.Modify | `pools.ts:1847` |  |
| `POST` | `/v1/pools/:name/export` | Sys.Modify | `pools.ts:2046` |  |
| `DELETE` | `/v1/pools/:name` | Sys.Modify | `pools.ts:2190` |  |
| `GET` | `/v1/replication/remotes` | Sys.Audit | `replication-remotes.ts:79` |  |
| `POST` | `/v1/replication/remotes` | Sys.Modify | `replication-remotes.ts:88` |  |
| `PUT` | `/v1/replication/remotes/:name` | Sys.Modify | `replication-remotes.ts:123` |  |
| `DELETE` | `/v1/replication/remotes/:name` | Sys.Modify | `replication-remotes.ts:169` |  |
| `POST` | `/v1/replication/remotes/test` | Sys.Modify | `replication-remotes.ts:365` | `?pin=true` WRITES known_hosts |
| `POST` | `/v1/replication/remotes/:name/test` | Sys.Modify | `replication-remotes.ts:385` | `?pin` / `?retrust` WRITE known_hosts |
| `GET` | `/v1/replication/locations` | Sys.Audit | `replication-remotes.ts:416` |  |
| `GET` | `/v1/replication/remotes/:name/pools` | Sys.Audit | `replication-remotes.ts:422` | outbound: ssh as root with the cluster key, constant `zpool list` |
| `GET` | `/v1/replication/peers/:name/pools` | Sys.Audit | `replication-remotes.ts:439` | outbound: ssh as root to a cluster peer, constant `zpool list` |
| `GET` | `/v1/replication/tasks` | Sys.Audit | `replication-tasks.ts:162` |  |
| `POST` | `/v1/replication/tasks` | Sys.Modify | `replication-tasks.ts:167` |  |
| `PUT` | `/v1/replication/tasks/:name` | Sys.Modify | `replication-tasks.ts:208` |  |
| `DELETE` | `/v1/replication/tasks/:name` | Sys.Modify | `replication-tasks.ts:281` |  |
| `POST` | `/v1/replication/tasks/:name/run` | Sys.Modify | `replication-tasks.ts:313` |  |
| `GET` | `/v1/schedules` | Sys.Audit | `schedules.ts:278` |  |
| `POST` | `/v1/schedules` | Sys.Modify | `schedules.ts:283` |  |
| `GET` | `/v1/schedules/:id` | Sys.Audit | `schedules.ts:319` |  |
| `PUT` | `/v1/schedules/:id` | Sys.Modify | `schedules.ts:334` |  |
| `DELETE` | `/v1/schedules/:id` | Sys.Modify | `schedules.ts:412` |  |
| `POST` | `/v1/schedules/:id/run` | Sys.Modify | `schedules.ts:445` |  |
| `GET` | `/v1/scrub` | Sys.Audit | `scrub.ts:111` |  |
| `PUT` | `/v1/scrub/zfs/:pool` | Sys.Modify | `scrub.ts:140` |  |
| `PUT` | `/v1/scrub/ahr/:pool` | Sys.Modify | `scrub.ts:176` |  |
| `GET` | `/v1/identity/users` | Sys.Audit | `share-identity.ts:420` |  |
| `GET` | `/v1/identity/groups` | Sys.Audit | `share-identity.ts:435` |  |
| `GET` | `/v1/identity/users/:name` | Sys.Audit | `share-identity.ts:455` |  |
| `POST` | `/v1/identity/users` | Sys.Modify | `share-identity.ts:479` |  |
| `POST` | `/v1/identity/users/:name/smb-password` | Sys.Modify | `share-identity.ts:614` |  |
| `PUT` | `/v1/identity/users/:name` | Sys.Modify | `share-identity.ts:685` |  |
| `POST` | `/v1/identity/groups` | Sys.Modify | `share-identity.ts:759` |  |
| `PUT` | `/v1/identity/groups/:name/members` | Sys.Modify | `share-identity.ts:792` |  |
| `DELETE` | `/v1/identity/users/:name` | Sys.Modify | `share-identity.ts:869` |  |
| `DELETE` | `/v1/identity/groups/:name` | Sys.Modify | `share-identity.ts:966` |  |
| `GET` | `/v1/shares/nfs` | Sys.Audit | `shares-nfs.ts:105` |  |
| `GET` | `/v1/shares/nfs/:path` | Sys.Audit | `shares-nfs.ts:116` |  |
| `POST` | `/v1/shares/nfs` | Sys.Modify | `shares-nfs.ts:133` |  |
| `GET` | `/v1/shares/nfs/:path/access` | Sys.Audit | `shares-nfs.ts:207` |  |
| `PUT` | `/v1/shares/nfs/:path/access` | Sys.Modify | `shares-nfs.ts:214` |  |
| `PUT` | `/v1/shares/nfs/:path` | Sys.Modify | `shares-nfs.ts:222` |  |
| `DELETE` | `/v1/shares/nfs/:path` | Sys.Modify | `shares-nfs.ts:267` |  |
| `GET` | `/v1/shares/smb` | Sys.Audit | `shares-smb.ts:316` |  |
| `GET` | `/v1/shares/smb/global` | Sys.Audit | `shares-smb.ts:329` |  |
| `PUT` | `/v1/shares/smb/global` | Sys.Modify | `shares-smb.ts:335` |  |
| `GET` | `/v1/shares/smb/:name` | Sys.Audit | `shares-smb.ts:401` |  |
| `GET` | `/v1/shares/smb/:name/access` | Sys.Audit | `shares-smb.ts:448` |  |
| `PUT` | `/v1/shares/smb/:name/access` | Sys.Modify | `shares-smb.ts:455` |  |
| `POST` | `/v1/shares/smb` | Sys.Modify | `shares-smb.ts:463` |  |
| `PUT` | `/v1/shares/smb/:name` | Sys.Modify | `shares-smb.ts:533` |  |
| `DELETE` | `/v1/shares/smb/:name` | Sys.Modify | `shares-smb.ts:630` |  |

Totals: 160 daemon registrations (GET 54, POST 62, PUT 24, DELETE 20): 54 need `Sys.Audit`, 106 need
`Sys.Modify`; plus the gateway's two own routes. Because the rule is the method, a new route needs no
table row; the doc table is regenerated by the same extraction when DESIGN's route index is.

---

## 5. Failure modes and their logged reasons

Every refusal logs one line with the reason. Perl side: `PVE::SafeSyslog::syslog('warning', 'anas-proxy:
refused <METHOD> <path> from <peer>: <reason>')` (journal unit `pveproxy`), and `$reqstate->{log}{userid}`
is set whenever the user is known, so `/var/log/pveproxy/access.log` names the user on `/anas` lines as it
does on `/api2` (F1). Gateway side: `request.log.warn('[authz] …')` (journal unit `anas`). Bodies are the
ANAS envelope `{error:{code,message}}` so the UI shows the sentence and the cross-node classifier reads
them as ANAS answers (`proxy.ts:54-89`).

| # | Where | Condition | Answer | Logged reason |
|---|---|---|---|---|
| 1 | AnasProxy | running in pvedaemon / any root or trusted server (F10) | 404 `NOT_FOUND` "ANAS is served through pveproxy on :8006 only" | `served outside pveproxy (euid 0 / trusted_env)` |
| 2 | AnasProxy | no `PVEAuthCookie` (or Authorization fallback) | 401 `UNAUTHORIZED` "Access ANAS through the Proxmox UI", PVE's 3 s delay | `no ticket` |
| 3 | AnasProxy | `Authorization: PVEAPIToken=…` | 401 `UNAUTHORIZED` "PVE API tokens are not accepted by ANAS" | `API token presented` |
| 4 | AnasProxy | `auth_handler` dies: bad/expired ticket, disabled/expired/deleted user, TFA not completed | 401 `UNAUTHORIZED` with PVE's message ("Authentication failed!"), 3 s delay | PVE's own `authentication failure: <err>` warning plus ours |
| 5 | AnasProxy | non-GET with missing/invalid/foreign CSRF token | 401 `UNAUTHORIZED` "Permission denied - invalid csrf token" (PVE's wording and status); with `x-anas-forwarded`: "… forwarded without a CSRF token: the forwarding node's ANAS is older than this one" | `invalid csrf token` (+ `forwarded`) |
| 6 | AnasProxy | `init_request` fails (pmxcfs down, `user.cfg` unreadable) | 503 `UNAVAILABLE` "PVE access control unavailable: <err>" | the error |
| 7 | AnasProxy | `/run/anas/proxy.key` missing/unreadable (gateway not started) | 502 `UPSTREAM_UNREACHABLE` "ANAS gateway not ready (no proxy key)" | `proxy key unreadable: <errno>` |
| 8 | AnasProxy | any other die inside the handler | 500 "ANAS proxy error" (the hook's existing eval) | the error (new: today the hook drops it) |
| 9 | gateway | no `X-Anas-Auth` (direct loopback caller, or an old AnasProxy still loaded — F12) | 401 `UNAUTHORIZED` "This request did not come through pveproxy" | `no proxy assertion` |
| 10 | gateway | bad MAC / version / `ts` outside ±30 s / method or path mismatch | 401 `UNAUTHORIZED` (same sentence) | which check failed |
| 11 | gateway | GET/HEAD without `Sys.Audit`, other method without `Sys.Modify` | 403 `FORBIDDEN` "Permission check failed (/, Sys.Modify): alice@pve does not have it. ANAS asks the privilege PVE asks for its own disk and ZFS operations." | user, method, path, missing privilege |
| 12 | gateway | key file cannot be written at startup | the gateway refuses to start (systemd shows it) | `cannot write /run/anas/proxy.key: …` |
| 13 | daemon | job submitted with `x-anas-privileges` lacking `Sys.Modify` (A3.1) | 403 `FORBIDDEN` naming the route | route, user, operation |
| 14 | daemon | mutation with a non-JSON `Content-Type`, or a body without one | 415 `UNSUPPORTED_MEDIA_TYPE` naming the type | method, path, type |
| 15 | UI | 403 on the install probe (`/v1/health`) | a panel "You need Sys.Audit on / to view ANAS on this node" — **not** the not-installed panel (today any probe failure renders "ANAS is not installed", `20-notinstalled.js:177-183`) | console warn |
| 16 | UI | 403 on a mutation | the refusal sentence in the alert; no retry | — |

`FORBIDDEN` and `UNSUPPORTED_MEDIA_TYPE` join the shared `ErrorCode` enum (`shared/schemas/api.ts:13`).

---

## 6. uid and gid reuse

### C1. What happens today

`useradd` without `-u` gives the highest uid in `[UID_MIN, UID_MAX]` + 1; `groupadd` the same for gids
(F14). ANAS deletes with `userdel` without `-r`, by design (files keep their numbers). Deleting the
highest-numbered share user therefore hands its number to the next user ANAS creates, with every file it
owns and every `u:<uid>` ACL entry that names it (review M6 #25). A deleted number below the top is not
reused until the band is full. The same holds for groups.

### C2. Where a deleted id still has meaning

On live, imported filesystems (file ownership and ACL entries); in ZFS snapshots (a rollback brings the
files back); on exported pools and unplugged disks; in PBS backups, cloud copies and replicas on other
hosts (a restore writes the numbers back); in NFS clients' view (sec=sys trusts numbers); in orphan Samba
passdb entries and `/etc/exports` `anonuid=`. A scan can only ever see the first two and the last two.

### C3. Options

| | Rule | Covers | Cost | Fails how |
|---|---|---|---|---|
| (1) full scan | at create, walk every managed path, skip any uid that owns a file or appears in an ACL | live filesystems only | O(inodes): a cold multi-million-file share takes minutes to an hour **[U]** (no measurement at scale) | a bounded walk proves nothing about the part it did not reach; fail closed then means "no share users on a large NAS" |
| (2) cheap exact sources | skip any uid in ZFS's own per-uid accounting (`zfs userspace`/`groupspace` on every filesystem and snapshot), the ACL entries at the managed roots, passdb, `/etc/exports` | ZFS ownership exactly (incl. snapshots); ACLs ANAS wrote (they sit at the roots and are copied down); passdb/exports | 6-12 ms per dataset or snapshot (F14; one datapoint, an empty dataset — **[U]** at scale) | btrfs (AHR) and plain directories have no per-uid accounting (from memory: btrfs qgroups are per-subvolume, ext4 quota is opt-in — **[U]**); hand-made ACLs below the roots; exported pools; backups |
| (3) **tombstone** | delete keeps the account as `anas-deleted-<uid>`: locked, expired, nologin, no supplementary groups, no SMB entry; `useradd` never reuses an id that exists | everything in C2, forever, by construction — the number is never free | one `usermod` at delete; nothing at create | the operator sees one extra locked line in `/etc/passwd` per deleted user |

**Recommendation: (3) as the guarantee, (2) as the create-time backstop.**

- (3) is the only stateless rule that holds for data ANAS cannot see. The record is the system's own
  account database, the same one `useradd` consults (Principle 11); `ls -l` on an orphaned file shows
  `anas-deleted-1005` instead of a bare number, which is the "unresolved owners are flagged, not hidden"
  ruling made literal. It changes what delete leaves behind, so it needs the operator's ruling (section 10,
  Q1): the account named `alice` is gone and the name is free; the number stays reserved.
- (2) covers ids already freed — by ANAS's delete since identity.1 shipped, or by hand — on the
  filesystems ZFS accounts for. It is cheap and exact for what it covers; it is not the guarantee.
- A bounded full walk (1) is not acceptable as a guarantee and not worth its cost next to (3).
- `login.defs`/`useradd` offer only the band and per-call overrides (`-u`, `-K UID_MIN=`); nothing remembers
  a deleted id (F14). An explicit `-u` is still worth passing: ANAS computes the candidate from `getent`
  (every NSS source) so a directory-provided uid in the band is never collided with — whether `useradd`'s
  own search consults NSS or only `/etc/passwd` is **[U]**.

### C4. The rules, concretely

**Delete user** (confirm-gated as today): re-read and re-gate (ruling (j)); drop the SMB entry (as
today); then one `usermod -L -e 1 -s /usr/sbin/nologin -G '' -c 'ANAS: deleted share user <name>
<YYYY-MM-DD>' -l anas-deleted-<uid> <name>`. One command, so there is no half-renamed state; its failure is
the job's failure with `usermod`'s stderr. Whether `-G ''` empties the supplementary list on shadow 4.17
is **[U]** — prove it in the node smoke. Confirm warnings say: the account and SMB access are removed; the
number stays reserved as `anas-deleted-<uid>`; and, from `zfs userspace` (cheap), "uid 1005 owns 12.3 GiB
on tank/media, tank/docs; ownership on non-ZFS filesystems is not counted".

**Delete group:** `groupmod -n anas-deleted-g<gid> <name>`, then `gpasswd -M '' anas-deleted-g<gid>`
(two commands: the job reports which one failed; a renamed group that kept members is still inert because
the name is reserved and the members keep only what the gid already gave them). The existing refusals
stay (primary group in use, share references).

**Recognising a tombstone:** name matches `^anas-deleted-g?\d+$` and (users) shell is nologin and the
account is expired. Listings leave them out; owner/ACL displays render them "deleted user (uid N)";
every identity mutation refuses them (409 "the number of a deleted account is kept reserved; ANAS does not
change it"); `NewIdentityName` refuses the `anas-deleted-` prefix at create (the `anas-` snapshot-prefix
precedent, cr.20). Purging one is the operator's `userdel` outside ANAS, which frees the number — stated
once in the docs, not guarded (no babysitting).

**Create user / group:** candidate = highest uid (gid) in `[1000, 60000)` among `getent passwd`
(`getent group`), tombstones included, + 1; while the candidate is in R, add one; refuse with a guiding 409
when the band is exhausted. *(This text was written against the half-open band; cr.29c moved the fencepost
to `[1000, 60000]` inclusive. What is settled: `SHARE_ID_MIN`/`SHARE_ID_MAX` in
`packages/shared/src/schemas/identity.ts` and the `isShareRelevant` / `isMutableShareId` reads in
`packages/daemon/src/parsers/getent.ts`.)* R = the numeric ids from `zfs userspace -Hpn -o name -t posixuser` (groups:
`groupspace … -t posixgroup`) over every filesystem dataset and snapshot of every imported pool; `getfacl
-n -p` (access and default entries) of every SMB share path, NFS export path, ZFS filesystem mountpoint and
AHR data mount; the uids of `pdbedit -L` entries; `anonuid=`/`anongid=` in `/etc/exports`. Then `useradd
-u <n>` (`groupadd -g <n>`). **Any source that cannot be read refuses the create** with the source named
(guards fail loud, ruling (c)); a suspended pool's `zfs userspace` is bounded by the executor timeout (wave
3, M1). The job shows "checking which ids are still in use on N datasets and snapshots".

**Groups are handled the same way**, with the one difference that share users have no private group
(`-N`, primary group 100 [P06]), so gid reuse only matters for groups created through ANAS.

**Delete and references (#25, the rest):** with tombstones an ACL entry for a deleted uid is inert, so
ACL references are warnings (name the roots), not a hard 409 — DESIGN's row (`DESIGN.md:398`) says hard
409 for "share/ACL" while the code checks only `valid users` (`share-identity.ts:329-346`); the row should
say what the code does after cr.30. Name references in smb.conf are a hard 409 as today, extended to every
user-list parameter: `valid users`, `invalid users`, `read list`, `write list`, `admin users`, `force user`,
`force group`, with the `@`, `+` and `&` group forms.

**Cost summary:** delete +1 command; create = one `zfs userspace`/`groupspace` per dataset and snapshot
(expected seconds on a node with thousands of snapshots — **[U]**, to be measured in the smoke), a
`getfacl` per root, one `pdbedit`, one read of `/etc/exports`.

---

## 7. Test strategy

- **Captures to check in** (taken by the node pass that creates the test users, section 8): `user.cfg`
  with the test users and ACLs (no secrets; passwords live in `priv/shadow.cfg`); `pvesh get
  /access/permissions --userid <u> --path / --output-format json` per user; a ticket line and a CSRF token
  line with signatures redacted; `.members` of the standalone node [P05]; `zfs userspace -Hpn` and
  `groupspace` lines from a dataset with two owners [P06 has one]; `getfacl -n -p` of a root with a named
  user; `pdbedit -L` with an orphan entry; an `/etc/exports` line with `anonuid=`.
- **CI (no PVE modules):** `AnasProxy.t` over the pure helpers with the captured permission replies (root,
  Administrator, PVEAuditor, no ACL, group grant, propagate 0, `/nodes/<n>`-only); gateway tests for the
  assertion (good, bad MAC, stale, method/path mismatch, missing, dev provider), the policy rows, the key
  file mode, `x-anas-user` carrying the realm and the uid only for `@pam`; daemon tests for the job-queue
  backstop and the 415 rule; identity tests driven by the captured `zfs userspace`, `getfacl`, `pdbedit`,
  `getent` lines; `proxy-install.test.sh` gains "module changed → pveproxy reload requested; unchanged → not".
- **On the node (`prove` as `www-data` against the captured `user.cfg` via `init_request(userconfig =>
  …)`):** the PVE binding with fresh tickets and tokens per test user, including a disabled user and a
  foreign CSRF token.
- **Mutation checks, each proven to fail the suite once:** treat POST as a read in the gateway rule; pass
  `undef` as the CSRF token to `auth_handler` (on-node test); drop the gateway's MAC comparison; replace
  definedness with `== 1` (the propagate-0 case); let `submit` accept an Audit-only requester; restore the
  `text/plain` parser; make create skip the backstop (the "hand-deleted top uid with files" case); make
  delete call `userdel` (tombstone tests).
- **The UI:** a harness test for `doFetch` with a fake `Proxmox` global (token sent; global absent →
  header omitted, no throw); a harness test that a 403 health probe renders the privilege panel, not
  not-installed.

---

## 8. Live smoke plan (stunt node; run by a node pass, as root@pam and as unprivileged `@pve` users)

**Setup (writes on the node — for the node pass, not this design pass):**

```
pveum user add anas-audit@pve  --password <pw>; pveum acl modify / --users anas-audit@pve --roles PVEAuditor
pveum user add anas-admin@pve  --password <pw>; pveum acl modify / --users anas-admin@pve --roles Administrator
pveum user add anas-none@pve   --password <pw>
pveum user add anas-np@pve     --password <pw>; pveum acl modify / --users anas-np@pve --roles Administrator --propagate 0
pveum user add anas-node@pve   --password <pw>; pveum acl modify /nodes/anas-pve --users anas-node@pve --roles Administrator
pveum group add anas-g; pveum user add anas-gm@pve --password <pw> --groups anas-g; pveum acl modify / --groups anas-g --roles PVEAuditor
pveum user add anas-off@pve    --password <pw>; pveum acl modify / --users anas-off@pve --roles Administrator
#   (disabled mid-test, row 8: pveum user modify anas-off@pve --enable 0)
```
Tickets and tokens from `POST /api2/json/access/ticket`. Capture the fixtures listed in section 7 first.

**cr.25 (token sent, nothing enforced):** every ANAS request in a Playwright trace carries
`CSRFPreventionToken`; a cross-node request on a two-node setup forwards it **[owed: the stunt node is
standalone]**; the whole integration suite is green against the not-yet-enforcing proxy.

**cr.26 (415):** over the socket and through `/anas`: `text/plain` body to `POST /pools/<p>/scrub` → 415
and no job; `application/x-www-form-urlencoded` with an empty body → 415; JSON → as today; body-less POST
without a type → as today; a timer-fired schedule run and the cache-event script still work.

**cr.27 (enforcement), each row with the response line and the journal line:**

| # | Who | Request | Expected |
|---|---|---|---|
| 1 | root@pam | GET `/v1/pools`; POST scrub with token | 200; 202 |
| 2 | root@pam | POST scrub without token; with anas-admin's token | 401 "invalid csrf token" both |
| 3 | anas-audit | GET `/v1/pools`; POST scrub with its own token | 200; 403 "Permission check failed (/, Sys.Modify)" |
| 4 | anas-none | GET `/v1/health`; the ANAS panel in the browser | 403 Sys.Audit; the privilege panel, not "not installed" |
| 5 | anas-np (propagate 0) | GET and POST | allowed (definedness) |
| 6 | anas-node | GET; and PVE's own `POST /api2/json/nodes/anas-pve/disks/zfs` for comparison | ANAS 403 on `/` exactly where PVE's ZFS create refuses |
| 7 | anas-gm (group grant) | GET; POST | 200; 403 |
| 8 | anas-off | GET with a live ticket, then `--enable 0`, GET again | 200, then 401 on the very next request (no cache) |
| 9 | anyone | `curl http://127.0.0.1:3000/api/nodes/anas-pve/v1/pools` with a valid cookie; with a forged `X-Anas-Auth` | 401 "did not come through pveproxy" both |
| 10 | anyone | `http://127.0.0.1:85/anas/installed` | 404, logged |
| 11 | anyone | `/anas/installed` without a cookie | 200 (presence probe unchanged) |
| 12 | root@pam | `systemctl stop anas`, then a request; start it again | 502 "gateway not ready", then 200 with a new key |
| 13 | — | `access.log` | `/anas` lines carry the user id |
| 14 | — | latency of `GET /v1/pools` through `/anas` before and after (`curl -w %{time_total}`, 20 runs) | added ≤ 2 ms median |
| 15 | — | ADOCK's `/adock` on the same node | unchanged |
| 16 | root@pam | full integration suite | green |
| 17 | root@pam | upgrade install over the previous build with no other change | pveproxy reloaded by the installer; row 1 passes without a manual restart (F12) |

**cr.28:** a test-only build where a GET route submits a job: anas-audit → 403 from the daemon, logged.

**cr.29/cr.30 (identity; a two-plus-command sequence, so success AND each failure step on the node):**
create `u1`, `u2`; give `u2` files on a ZFS dataset and a named ACL at a share root; delete `u2` →
`getent passwd anas-deleted-<uid>` shows nologin, locked, expired, no groups; `smbclient -U u2` fails;
create `u3` → a different uid; `ls -ln` and `ls -l` on `u2`'s files; the Users list hides the tombstone;
the ACL dialog shows "deleted user (uid N)". Backstop: `userdel` a top user that owns files on a ZFS
dataset by hand, then create through ANAS → its uid is skipped. Measure create time with the topology zoo
and a few thousand snapshots. Delete refusals: a user named in `write list` / `force user` / `+group`.

---

## 9. Proposed stories and ordering

Ordering rule: nothing may require what a previous merge does not yet send. cr.25 merges and is deployed
before cr.27; cr.27 is one merge across Perl, gateway and UI; cr.28 after cr.27; cr.26 and cr.29/cr.30 are
independent of the auth chain. The scoped review of these paths is gated on the operator (amended ruling
(g): the release touches authorization and a destructive identity path).

**cr.25a — The UI and the gateway send PVE's CSRF token (no enforcement).** `10-api.js` `doFetch` sends
`CSRFPreventionToken` from `window.Proxmox.CSRFPreventionToken`, read per call, omitted when absent;
`proxy.ts` `forwardToNode` forwards `csrfpreventiontoken`. Files: `packages/pve-integration/src/10-api.js`,
`packages/gateway/src/proxy.ts`, a harness test, `gateway.test.ts`. Acceptance: harness (token sent /
global absent), gateway forward test, both mutation-checked; node: header visible on a mutation. Deps:
none. Lane: **Opus** (request path; about half an hour).

**cr.25b — API specs send the token.** One fixture helper returns a request context with the cookie and
`CSRFPreventionToken` from the same login; the 56 `newContext(` calls in 31 spec files use it. Files:
`tests/integration/fixtures/{auth,cloud-api,target}.ts` + the 31 specs. Acceptance: `grep -c newContext(`
outside the helper is 0; `playwright --list` and eslint clean; the coordinator runs the suite on the node.
Deps: cr.25a. Lane: **Haiku or Qwen** (mechanical, grep gate; no node access).

**cr.26 — The daemon accepts JSON bodies only (review H1, third bullet).** Remove the `text/plain` parser;
the 415 hook of section 3; `UNSUPPORTED_MEDIA_TYPE` in `ErrorCode`. Files: `packages/daemon/src/server.ts`,
`packages/shared/src/schemas/api.ts`, tests. Acceptance: the four request shapes of section 8; the runner and
cache-event paths pinned by tests; mutation check (restore the parser → a test fails). Deps: none. Lane:
**Qwen** (single module, request shapes listed in the brief).

**cr.27 — PVE decides who and what inside pveproxy; the gateway enforces Sys.Audit/Sys.Modify (ruling;
review H1 + Amplifier + M6 #45).** AnasProxy: A2, A2.1, A2.2, A5 and the logging of section 5 (rows 1-8),
pure helpers split out; gateway: the assertion provider, the key file, the rule and 403 (rows 9-12), full
user id and `@pam`-only uid, `x-anas-privileges`, its own RSA verifier off the request path; shared:
`FORBIDDEN`; UI: the 403 privilege panel instead of not-installed, the refusal sentence on mutations;
`install.sh`: reload pveproxy when `AnasProxy.pm` changed (F12); DESIGN "Authorization" and
PROXY-TRANSPORT-DESIGN updated. Files: `packages/pve-integration/perl/AnasProxy.pm` + `t/`,
`packages/pve-integration/install.sh` + `test/proxy-install.test.sh`, `packages/gateway/src/{server,proxy}.ts`,
`packages/gateway/src/auth/*`, `packages/shared/src/schemas/api.ts`,
`packages/pve-integration/src/{10-api,20-notinstalled}.js`, docs. Acceptance: section 7's CI and on-node
tests and mutation checks; section 8 rows 1-17 on the node before merge (EPICS §2: live smoke as root@pam
and an unprivileged `@pve` user gates the merge). Deps: cr.25a deployed, cr.25b merged. Lane: **Opus**,
with the node smoke by the Opus node pass; cross-model review after (brief the reviewer to construct the
forged header and the foreign token and send them).

**cr.28 — The job queue refuses work without Sys.Modify (Principle 4 backstop).** A3.1. Files:
`packages/shared/src/schemas/api.ts` (`RequestHeaders`), `packages/daemon/src/routes/identity.ts`,
`packages/daemon/src/jobs/queue.ts`, tests. Acceptance: Audit-only requester refused at `submit`; absent
header (socket client) allowed; mutation-checked. Deps: cr.27. Lane: **Qwen** (one module, exact rule in the
brief) or folded into cr.27 if the Opus job has room.

**cr.29 — A deleted share user's or group's number is never handed out again (§2 ruling; review M6 #25).**
Section 6 C4: tombstone delete for users and groups, tombstone recognition (lists, displays, mutation
refusals, name reservation), explicit `-u`/`-g` from the backstop rule with fail-closed sources, delete
warnings with ZFS usage, DESIGN identity rows. Files: `packages/daemon/src/routes/share-identity.ts`,
`packages/daemon/src/parsers/getent.ts`, a new parser for `zfs userspace` output (or the existing zfs
parsers), `packages/shared/src/schemas/identity.ts`, the identity UI file(s) that render owners,
`docs/DESIGN.md`. Acceptance: tests from the captures of section 7; mutation checks (delete via `userdel`,
create without the backstop); the node sequence of section 8 including each failure step. Deps: the
operator's ruling Q1; none in code. Lane: **Opus** (destructive identity path).

**cr.30 — Delete refuses every smb.conf name reference (review M6 #25, the rest).** The parameter list of
section 6 C4 with the `@`/`+`/`&` forms; ACL-root references become confirm warnings. Files:
`packages/daemon/src/routes/share-identity.ts`, `packages/daemon/src/parsers/smb-conf.ts` (read side),
tests from a captured smb.conf carrying each parameter. Acceptance: one refusal test per parameter and form;
untouched `valid users` behaviour. Deps: after cr.29 (same file). Lane: **Qwen** with the captured smb.conf
fixture.

---

## 10. Open questions for the operator

1. **Tombstones (C3).** May delete leave the account as a locked, expired, nologin `anas-deleted-<uid>`
   (and `anas-deleted-g<gid>` for groups) so the number is never reused? The alternative is the create-time
   scan alone, which cannot see exported pools, non-ZFS file ownership below the roots, or backups and
   replicas.
2. **The hand-off (A2.1).** HMAC-signed header over the existing loopback TCP (recommended for 0.4.4), or
   move the gateway to a `root:www-data` unix socket now (simpler trust, removes the port setting, bigger
   transport change)?

---

## 11. Noticed outside this task

- **ADOCK** (`~/projects/adock`): `authz.ts:177` tests `=== 1`, so a grant made with `--propagate 0` is
  refused (F7); the provider has no `check_user_enabled` equivalent, so a disabled user's ticket keeps
  working (F4); its hook also runs inside pvedaemon on `:85` (F10); no CSRF check yet (its own review lists
  it). Worth a note to that project.
- **F12 is a standing hazard today**, not only for cr.27: any ANAS upgrade that changes `AnasProxy.pm`
  (e.g. the gateway port logic) is served by the old module until pveproxy's workers recycle.
- `docs/DESIGN.md:857-860` still says "Auth is binary" and "no permission matrix … future discussion";
  the Authorization section needs
  the ruling's text (CLAUDE.md and PRINCIPLES §10 already carry it).
- `DESIGN.md:398` says user delete is a hard 409 when "a share/ACL references it"; the code checks only
  smb.conf `valid users` (`share-identity.ts:329-346`).
- `login.defs` `UID_MAX` is 60000 inclusive [P06]; ANAS's share band is `[1000, 60000)`
  (`getent.ts:38, 51`), so a uid of exactly 60000 that `useradd` may assign is treated as a system account
  by ANAS. Harmless with an explicit `-u` (cr.29), worth knowing.
  *(As written this row held until cr.29c, which moved the fencepost: 60000 is a share id, not a system
  account. What is settled: `SHARE_ID_MIN`/`SHARE_ID_MAX` in `packages/shared/src/schemas/identity.ts`
  and the band reads in `packages/daemon/src/parsers/getent.ts`.)*
- The gateway's ticket check accepts tickets up to 2 h old whatever the key's rotation age; PVE clamps the
  window after a key rotation (`AccessControl.pm` `get_ticket_age_range`). Moot once cr.27 takes PVE's
  verifier.

## 12. Unverified claims, collected

- `AnyEvent::HTTP` connecting to a unix socket via its `tcp_connect` override (A2.1 alternative).
- Full-tree scan cost on a large share; `zfs userspace` cost per snapshot at scale (C3, C4).
- btrfs and ext4 offering no per-uid accounting usable here (C3).
- Whether `useradd`'s own uid search consults NSS beyond `/etc/passwd` (C3).
- `usermod -G ''` clearing all supplementary groups on shadow 4.17 (C4).
- Cross-node behaviour of every row (the stunt node is standalone; F9's cluster validity of the CSRF token
  is from PVE's source — `pve-www.key` is a pmxcfs file — not from a cluster run).
- That no GET changes state (A3): grep-level, made safe by cr.28 rather than proven.
