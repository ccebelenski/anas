# The internal API (anas to anasd)

## Internal API Design (anas ↔ anasd)

### Protocol: REST over Unix Socket

anasd runs a Fastify HTTP server bound to `/run/anas/anasd.sock`. The anas gateway communicates with it using standard HTTP semantics over the Unix socket. This gives us:

- **Formal, well-understood semantics** — standard HTTP methods, status codes, content types
- **Debuggability** — `curl --unix-socket /run/anas/anasd.sock http://localhost/v1/pools`
- **Auth propagation** — every request carries the authenticated user's identity
- **Mature tooling** — standard HTTP client libraries, no custom protocol parser
- **Shared schemas** — Zod schemas define request/response types, shared between anas and anasd

### API Versioning

All anasd routes are prefixed with `/v1/`. This allows future breaking changes without disrupting running systems during upgrades.

**Version-skew visibility (12.1):** every gateway response carries `X-Anas-Version` (the responding gateway's own semver; never overwritten by a forwarded peer's copy), the daemon's `/v1/health` body carries its version, and the installer stamps the UI bundle with `ANAS.BUILD_VERSION`. The UI's per-view health probe compares all three and docks an advisory warning banner on any difference — warn, never fail: `/v1/` stays additive, so skew is an upgrade nudge, not an error.

### Authentication Propagation & Audit Trail

Every request from anas to anasd carries the authenticated user's identity via headers:

```
X-Anas-User: alice@pve
X-Anas-User-UID: -1
X-Anas-Privileges: Sys.Audit,Sys.Modify
X-Anas-Request-ID: 550e8400-e29b-41d4-a716-446655440000
```

Since cr.27 `X-Anas-User` is the full PVE user id with its realm, and `X-Anas-User-UID` is the Linux uid only
for a `@pam` user (-1 for any other realm: `alice@pve` is not the local `alice`). `X-Anas-Privileges` is what
PVE granted on `/`, as pveproxy signed it; the job-queue backstop (cr.28) refuses a submit it does not cover
(`Sys.Modify`; `Sys.Audit` for a `read.*` job and for cancelling one). It is required: a request without it, or
with an unreadable one, is refused, so the root socket clients that submit work (the systemd task runners, the
udev cache-event script) send `Sys.Audit,Sys.Modify` themselves. Only work no request started (the boot work,
a job's own body) is not checked.

anasd trusts these headers because the Unix socket restricts access to local processes. This gives us:

- **Full traceability** — every privileged operation is tied to a user, even in anasd's logs
- **Audit logging** — anasd logs `who did what, when` for every mutating operation via journald
- **Request correlation** — `X-Anas-Request-ID` links the browser request → anas gateway → anasd operation for end-to-end tracing

### Resource Model

URLs identify resources (nouns). HTTP methods are the verbs. URL hierarchy implies containment.

#### Filesystem browse (read-only UI support; designed 2026-07-20)

One generic endpoint backing directory pickers and gentle path validation across features (backup archive paths first; Epic 17 targets and share-create later). Read-only, absolute paths only, never follows into anything mutable — it lists, it never touches.

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/fs/browse?path=<abs>` | `{ path, exists, type: dir\|file\|other\|missing, dirs: [child dir names] }` — dirs listed only when type=dir | `200` |

#### Jobs

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/jobs` | List jobs (filterable by status) | `200` |
| `GET` | `/v1/jobs/:id` | Job detail & status | `200` |
| `POST` | `/v1/jobs/:id/cancel` | **Cancel a running job (rclone.5), confirm-gated.** The first call answers `409` + `X-Anas-Confirm-Code` with the headline "<subject> has been running for <elapsed> — <progress>; cancelling stops it here" (the subject is the job's own, e.g. "Cloud sync task 'photos'"; any other cancellable job is named by its operation) and the job's consequence sentence as `warnings`; the replay with the code submits a `job.cancel` CONTROL job (runs at once, outside the concurrency limit) that runs the target's cancel hook once. A job that registered no hook answers `409 NOT_CANCELLABLE`, a finished one `409` naming its final state — both before any code is minted. A hook that cannot stop the work fails the cancel job with the reason and the job runs on. Registered today by the cloud sync and backup DIRECT run jobs (SIGINT to rclone / proxmox-backup-client, a second SIGINT after 10 s, fail after 10 s more — never SIGKILL) | `202` with job / `404` / `409` |

#### Status (singleton, read-only)

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/status` | System overview (pool health, share counts, disk warnings, active jobs). Each section is read by its own collector under its own wall budget; a section whose read failed, timed out or overran is the empty shape, listed in `unavailable` with a card naming the read, never an observation. The pools, disks, shares, replication, backup, cloud and schedules collectors report a partial read: what they read is kept and the section is listed in `unavailable` with the reason. On a node where ZFS is not available the summary carries `zfsUnavailable` and `pools: []` | `200` |

#### Route index (generated 2026-10-14 from the route registrations)

Routes not carried by the resource tables above, as a route registration exists. Paths are `/v1/...` as seen through the gateway; the daemon registers them without the `/v1` prefix. File names are under `packages/daemon/src/routes/`. Method + path + file only — no description invented here; the tables above stay the spec where they cover a route.

| Method | Path | Registered in |
|--------|------|---------------|
| `GET` | `/v1/health` | health.ts |
| `GET` | `/v1/telemetry` | dashboard.ts |
| `GET` | `/v1/pools/import` | pools.ts |
| `PUT` | `/v1/pools/:name/mountpoint` | pools.ts |
| `POST` | `/v1/pools/:name/trim` | pools.ts |
| `POST` | `/v1/pools/:name/upgrade` | pools.ts |
| `GET` | `/v1/pools/:name/expansion` | pools.ts |
| `POST` | `/v1/pools/:name/attach` | pools.ts |
| `GET` | `/v1/ahr` | ahr.ts |
| `GET` | `/v1/ahr/:name` | ahr.ts |
| `POST` | `/v1/ahr/layout/preview` | ahr.ts |
| `POST` | `/v1/ahr` | ahr-mutate.ts |
| `PUT` | `/v1/ahr/:name/mountpoint` | ahr-mutate.ts |
| `POST` | `/v1/ahr/:name/remount` | ahr-mutate.ts |
| `DELETE` | `/v1/ahr/:name` | ahr-mutate.ts |
| `POST` | `/v1/ahr/:name/scrub` | ahr-mutate.ts |
| `POST` | `/v1/ahr/:name/repair` | ahr-mutate.ts |
| `POST` | `/v1/ahr/:name/parity-rewrite` | ahr-mutate.ts |
| `POST` | `/v1/ahr/:name/mirror-reconcile` | ahr-mutate.ts |
| `POST` | `/v1/ahr/:name/expand/plan` | ahr-expand.ts |
| `POST` | `/v1/ahr/:name/expand` | ahr-expand.ts |
| `POST` | `/v1/ahr/:name/expand/resume` | ahr-expand.ts |
| `POST` | `/v1/ahr/:name/expand/abandon` | ahr-expand.ts |
| `POST` | `/v1/ahr/:name/disk/:oldId/replace` | ahr-expand.ts |
| `POST` | `/v1/ahr/:name/disk/:id/readd` | ahr-expand.ts |
| `GET` | `/v1/ahr/:name/snapshots` | ahr-snapshots.ts |
| `POST` | `/v1/ahr/:name/snapshots` | ahr-snapshots.ts |
| `DELETE` | `/v1/ahr/:name/snapshots/:snap` | ahr-snapshots.ts |
| `POST` | `/v1/ahr/:name/snapshots/:snap/rollback` | ahr-snapshots.ts |
| `POST` | `/v1/ahr/:name/spare` | ahr-spare.ts |
| `DELETE` | `/v1/ahr/:name/spare/:id` | ahr-spare.ts |
| `POST` | `/v1/ahr/:name/cache` | ahr-cache.ts |
| `DELETE` | `/v1/ahr/:name/cache` | ahr-cache.ts |
| `POST` | `/v1/ahr/:name/cache/event` | ahr-cache.ts |
| `GET` | `/v1/ahr/:name/access` | ahr-access.ts |
| `PUT` | `/v1/ahr/:name/access` | ahr-access.ts |
| `GET` | `/v1/replication/remotes` | replication-remotes.ts |
| `POST` | `/v1/replication/remotes` | replication-remotes.ts |
| `PUT` | `/v1/replication/remotes/:name` | replication-remotes.ts |
| `DELETE` | `/v1/replication/remotes/:name` | replication-remotes.ts |
| `POST` | `/v1/replication/remotes/keypair` | replication-remotes.ts (cr.62: creates the cluster key; the GET above only reads it) |
| `POST` | `/v1/replication/remotes/test` | replication-remotes.ts |
| `POST` | `/v1/replication/remotes/:name/test` | replication-remotes.ts |
| `GET` | `/v1/replication/locations` | replication-remotes.ts |
| `GET` | `/v1/replication/remotes/:name/pools` | replication-remotes.ts |
| `GET` | `/v1/replication/peers/:name/pools` | replication-remotes.ts |
| `GET` | `/v1/replication/tasks` | replication-tasks.ts |
| `POST` | `/v1/replication/tasks` | replication-tasks.ts |
| `PUT` | `/v1/replication/tasks/:name` | replication-tasks.ts |
| `DELETE` | `/v1/replication/tasks/:name` | replication-tasks.ts |
| `POST` | `/v1/replication/tasks/:name/run` | replication-tasks.ts |
| `GET` | `/v1/schedules` | schedules.ts |
| `POST` | `/v1/schedules` | schedules.ts |
| `GET` | `/v1/schedules/:id` | schedules.ts |
| `PUT` | `/v1/schedules/:id` | schedules.ts |
| `DELETE` | `/v1/schedules/:id` | schedules.ts |
| `POST` | `/v1/schedules/:id/run` | schedules.ts |
| `GET` | `/v1/scrub` | scrub.ts |
| `PUT` | `/v1/scrub/zfs/:pool` | scrub.ts |
| `PUT` | `/v1/scrub/ahr/:pool` | scrub.ts |

### Resource Identifiers

| Resource | Identifier | Stability |
|----------|-----------|-----------|
| Pool | name (`tank`) | Stable — user-chosen |
| Dataset | path within pool (`media/movies`) | Stable — hierarchical name |
| Snapshot | name (`tuesday`) | Stable — immutable once created |
| SMB share | section name (`media`) | Stable — key in smb.conf |
| NFS export | URL-encoded path (`%2Ftank%2Fmedia`) | Stable — path is the identity |
| Disk | by-id (`ata-WDC_WD40EFRX_12345`) | Stable — tied to hardware serial |
| User | UID (numeric) | Stable |
| Group | GID (numeric) | Stable |
| Job | UUID | Stable — generated by anasd |
| iSCSI target | URL-encoded IQN | Stable — LIO has no rename; a rename is delete + create |
| iSCSI LUN | index `n` within the target's TPG | Stable while mapped |

### Safety Semantics

All safety enforcement uses `409 Conflict`. Two levels are distinguished by the presence of a confirmation code header:

#### Level 1: Blocked (409, no confirmation code)

Operations that must not be possible. No override.

- Destroy root pool / root dataset
- Use boot disk for storage
- Delete logged-in user
- Remove only copy of non-redundant data

```
DELETE /v1/pools/rpool → 409 Conflict

{
  "error": {
    "code": "PROTECTED_RESOURCE",
    "message": "Cannot destroy the root pool"
  }
}
```

No `X-Anas-Confirm-Code` header — there is no override path.

#### Level 2: Confirmation Required (409, with confirmation code)

Operations that are valid but have consequences. Requires acknowledgment.

- Destroy pool with active shares or connected users
- Destroy dataset with children
- Remove share with active connections
- Export pool with active shares
- Rollback snapshot (destroys newer data)
- Repair an AHR file's named blocks from parity (writes reconstructed data through md; `AHR-DESIGN.md` §4)
- Cancel a running cloud sync or backup run (`POST /v1/jobs/:id/cancel`, rclone.5 — the headline names the run, how long it has gone and how far it got; the consequence sentence says what the stop leaves behind)
- Apply permissions to existing files (`applyToExisting` on any `…/access` PUT, and the SMB share grant's `grantAccess.applyToExisting` — operator ruling 2026-10-11; the headline names the path, the warnings what the walk reaches; see "Layered access / ACLs")

```
DELETE /v1/pools/tank → 409 Conflict
  X-Anas-Confirm-Code: a1b2c3d4
  X-Anas-Confirm-Expires: 2026-03-14T10:05:00Z

{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "This operation has consequences",
    "warnings": [
      "3 SMB shares on this pool will become unavailable",
      "2 active SMB connections will be terminated",
      "5 datasets will be destroyed"
    ]
  }
}
```

To proceed, resend with the confirmation code:

```
DELETE /v1/pools/tank
  X-Anas-Confirm: a1b2c3d4

→ 202 Accepted { "job": { ... } }
```

A client that doesn't understand the confirmation system just sees 409 and stops — standard REST behavior. A client that does (our frontend) checks for `X-Anas-Confirm-Code`, shows the warnings, and resends with the code. Progressive enhancement on a standard status code.

Confirmation codes are:
- Generated by anasd
- Tied to the specific operation (resource + method)
- Time-limited (default 5 minutes)
- Single-use (consumed on acceptance)
- Verified server-side (no cheating)

### Response Conventions

#### Synchronous responses (reads)

```json
// GET /v1/pools — 200 OK
{
  "data": [
    { "name": "tank", "state": "ONLINE", "size": 1099511627776, ... }
  ]
}
```

#### Asynchronous responses (mutations)

All mutating operations return `202 Accepted` with a job reference:

```json
// POST /v1/pools — 202 Accepted
{
  "job": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "queued",
    "operation": "pool.create",
    "createdAt": "2026-03-14T10:00:00Z",
    "createdBy": "admin"
  }
}
```

#### Job status response

```json
// GET /v1/jobs/:id — 200 OK
{
  "job": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "running", // queued | running | completed | failed | cancelled
    "operation": "pool.create",
    "progress": "creating mirror-0...",
    "createdAt": "2026-03-14T10:00:00Z",
    "createdBy": "admin",
    "startedAt": "2026-03-14T10:00:01Z",
    "completedAt": null,
    "result": null,
    "error": null
  }
}
```

#### Error responses

```json
// 400 Bad Request — validation failure
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid pool name: must be alphanumeric",
    "details": { "field": "name", "value": "tank/bad" }
  }
}

// 404 Not Found — resource doesn't exist
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Pool 'noexist' not found"
  }
}

// 409 Conflict — blocked or confirmation required (see Safety Semantics)
// No X-Anas-Confirm-Code header → Level 1 block, no override
// With X-Anas-Confirm-Code header → Level 2, resend with code to proceed
```

**Executor primitives:** `exec` (argv, captured output; since rclone.5 an optional `onSpawn` hands the caller a `SpawnedChild` — pid, `kill(signal)`, `exited()`, an `exit` promise — so a job's cancel hook can signal the tool it is running), `pipeline`, and — since backup2.7 — `execToStream` (spawn with stdout written to a caller-owned fd, `fsync` on finish): the PBS client refuses every existing restore target, so a block image can only be restored by streaming its stdout into a device the daemon opened itself.

### Job Lifecycle

```
QUEUED → RUNNING → COMPLETED
                 → FAILED
                 → CANCELLED
```

- **QUEUED** — Accepted, waiting for execution slot
- **RUNNING** — Currently executing, may have progress updates
- **COMPLETED** — Finished successfully, `result` field populated
- **FAILED** — Finished with error, `error` field populated
- **CANCELLED** (rclone.5, additive on the shared `JobStatus` enum) — stopped on purpose: either its own cancel hook ran on a confirmed `POST /v1/jobs/:id/cancel`, or its body reported that the work it watched was cancelled (a UI Run-Now supervisor whose unit ended with the runner's cancel exit). `result` = `{ status: 'cancelled', reason: 'cancelled by <user> at <time>' }`, `error` stays null; audited as `job.cancelled` naming the user who cancelled and the submitter. A job body registers its hook through the context the queue passes beside `updateProgress` (`ctx.onCancel(hook, { subject, consequence })`); a job that never registers one is not cancellable.

### Fast vs. slow operations

Both go through the same REST API and job queue. The distinction is in how the **gateway** and **UI panels** handle them:

- **Fast reads** (GET requests): anasd responds synchronously. No job created. The gateway returns the result directly to the browser.
- **Mutations** (POST/PUT/DELETE): Always return `202` with a job. The frontend either polls briefly (fast ops complete in <1s) or shows a progress indicator (slow ops like scrub).

---

## Public API (browser ↔ anas gateway)

The gateway exposes anasd's resource model with the **node as a path parameter**, following PVE's own convention (`/api2/json/nodes/<node>/...`), served through PVE's `:8006` under the `/anas` prefix (see [`PROXY-TRANSPORT-DESIGN.md`](../PROXY-TRANSPORT-DESIGN.md), story 12.2):

```
https://<ui-host>:8006/anas/api/nodes/<node>/v1/pools
https://<ui-host>:8006/anas/api/nodes/<node>/v1/pools/:name/scrub
https://<ui-host>:8006/anas/api/nodes/<node>/v1/jobs/:id
```

- **The browser only ever talks to the PVE `:8006` on the host serving the UI.** ANAS is same-origin under `/anas`, so `PVEAuthCookie` flows automatically — no CORS, no cert exception. pveproxy proxies `/anas` to the gateway on `127.0.0.1:3000`, which strips the prefix.
- **Node routing:** if `<node>` is the local node, the gateway forwards to the local anasd socket (`/v1/...`) — on a single-node install this branch is the whole story. Otherwise it forwards the request to `https://<node>:8006/anas/api/nodes/<node>/v1/...`, resolving the peer's address from PVE cluster membership (`/etc/pve/.members`, not DNS) and passing the user's ticket and `CSRFPreventionToken`; the peer's pveproxy authenticates and authorizes the request again with PVE's own code (`AnasProxy.pm`, cr.27) exactly as for a direct request — a peer whose forwarding node sent no token answers that the forwarding node's ANAS is older — and the TLS hop is verified against the cluster CA (`/etc/pve/pve-root-ca.pem`), or, for a peer serving a custom or ACME certificate, by its SHA-256 matching the certificate pmxcfs holds for that node (`/etc/pve/nodes/<node>/pveproxy-ssl.pem`, read on every forward); the peer is judged before a byte of the request is written. A node without ANAS returns a clean `ANAS_NOT_INSTALLED` signal. No new trust infrastructure — this is PVE's own fabric (Principle 15).
- anasd's `/v1/` API is unchanged — socket-only (Principle 9), reached exclusively through a gateway.

---
