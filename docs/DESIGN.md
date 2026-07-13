# ANAS — A NAS

## Overview

ANAS is a lightweight storage management GUI for Proxmox (and potentially other Linux platforms). It provides a modern web interface for managing ZFS pools/datasets, SMB shares, NFS exports, and share security — the storage management features that Proxmox's native UI doesn't cover well.

Think TrueNAS, but purpose-built to complement Proxmox rather than replace it.

## V1 Scope

### In scope
- ZFS pool creation, management, and monitoring (status, scrub, properties)
- ZFS dataset creation and management (quotas, compression, snapshots)
- SMB share configuration and management
- NFS export configuration and management
- Share security and permissions (users, groups, ACLs)
- PAM-based authentication (system users)
- Job queue for long-running operations with status tracking

### Out of scope (V1)
- Container/VM management (Proxmox handles this)
- Proxmox API integration
- Multi-node / cluster management
- Application management
- SMART monitoring and alerting
- Scheduled tasks (scrub scheduling, snapshot policies)
- SSE/WebSocket real-time updates (polling is fine for V1)

---

## Architecture

### Two-process model

```
┌─────────────────────────────────────────────┐
│                  Browser                     │
└──────────────────┬──────────────────────────┘
                   │ HTTPS (port 3000)
                   │ Cookie-based session auth
                   ▼
┌─────────────────────────────────────────────┐
│              anas (Nuxt 3)                   │
│                                              │
│  - SSR frontend (Vue 3)                      │
│  - Nitro API routes (/api/*)                 │
│  - PAM authentication & sessions             │
│  - Input validation (Zod schemas)            │
│  - Authorization enforcement                 │
│  - Proxies to anasd with user identity       │
│  - No system command execution               │
│                                              │
│  Runs as: root                               │
│  Managed by: anas.service                    │
└──────────────────┬──────────────────────────┘
                   │ REST (HTTP) over Unix socket
                   │ /run/anas/anasd.sock
                   │ X-Anas-User / X-Anas-Request-ID headers
                   ▼
┌─────────────────────────────────────────────┐
│              anasd (Fastify daemon)          │
│                                              │
│  - REST API (/v1/*) on Unix socket           │
│  - Job queue (in-memory)                     │
│  - Command whitelist & execution             │
│  - Input validation (shared Zod schemas)     │
│  - Audit logging (user + operation + result) │
│  - Job status tracking & history             │
│                                              │
│  Runs as: root                               │
│  Managed by: anasd.service                   │
└─────────────────────────────────────────────┘
```

### Why two processes?

Both processes run as root (like Proxmox). The separation is architectural, not privilege-based:

1. **Clean API boundary** — The web app never executes system commands. All operations go through anasd's REST API, which only accepts structured, whitelisted operations. This is the security contract.
2. **Non-blocking UI** — Long operations (pool creation, scrub, resilver) run in the background via the job queue. The UI submits jobs and polls for status.
3. **End-to-end traceability** — Every operation carries the authenticated user's identity from browser → Nuxt → anasd. anasd logs who did what, when, via journald. Critical for corporate/compliance environments.
4. **Centralized audit point** — All system mutations flow through one place with a formal REST API. Easy to audit, easy to log.
5. **Multi-node path** — anasd's REST interface can become a TCP/TLS interface for remote node management in a future version. Same API, different transport.

### Why NOT two processes? (acknowledged tradeoffs)

- Slightly more complex deployment (two systemd units)
- IPC overhead (negligible for this use case)
- Mitigated by: single npm package installs both, single setup command configures both

---

## Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Frontend framework | Vue 3 | Reactive, good ecosystem, SSR-ready |
| Meta-framework | Nuxt 3 | SSR, file-based routing, Nitro server routes, single project |
| UI components | PrimeVue (tree-shaken) | Best data tables and tree views, dark mode, Nuxt module |
| Styling | PrimeVue theming (Lara Dark) | Single design system, no Tailwind |
| State management | Pinia | Nuxt-native, simple |
| Config format | YAML (`/etc/anas/config.yaml`) | Human-readable, supports comments |
| Auth | Pluggable: PVE ticket (primary), PAM (fallback), Dev (testing) | Proxmox SSO when available, standalone capable |
| Daemon runtime | Node.js (TypeScript) | Same language as web app, shared schemas, single npm package |
| Daemon framework | Fastify | Lightweight, schema validation built-in, Unix socket support |
| IPC | REST (HTTP) over Unix domain socket | Formal semantics, curl-debuggable, auth propagation |
| Project structure | Monorepo (packages/) | shared schemas imported by both anas and anasd |
| Schema validation | Zod (shared between anas and anasd) | Single source of truth for request/response types |
| Command execution | `child_process.execFile` | No shell interpretation, no injection |
| Process management | systemd | Standard, reliable, already on Proxmox |

---

## Internal API Design (anas ↔ anasd)

### Protocol: REST over Unix Socket

anasd runs a Fastify HTTP server bound to `/run/anas/anasd.sock`. Nuxt's server routes communicate with it using standard HTTP semantics over the Unix socket. This gives us:

- **Formal, well-understood semantics** — standard HTTP methods, status codes, content types
- **Debuggability** — `curl --unix-socket /run/anas/anasd.sock http://localhost/v1/pools`
- **Auth propagation** — every request carries the authenticated user's identity
- **Mature tooling** — standard HTTP client libraries, no custom protocol parser
- **Shared schemas** — Zod schemas define request/response types, shared between anas and anasd

### API Versioning

All anasd routes are prefixed with `/v1/`. This allows future breaking changes without disrupting running systems during upgrades.

### Authentication Propagation & Audit Trail

Every request from anas to anasd carries the authenticated user's identity via headers:

```
X-Anas-User: admin
X-Anas-User-UID: 1000
X-Anas-Request-ID: 550e8400-e29b-41d4-a716-446655440000
```

anasd trusts these headers because the Unix socket restricts access to local processes. This gives us:

- **Full traceability** — every privileged operation is tied to a user, even in anasd's logs
- **Audit logging** — anasd logs `who did what, when` for every mutating operation via journald
- **Request correlation** — `X-Anas-Request-ID` links the browser request → Nuxt API route → anasd operation for end-to-end tracing

### Resource Model

URLs identify resources (nouns). HTTP methods are the verbs. URL hierarchy implies containment.

#### ZFS Pools

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/pools` | List all pools | `200` |
| `POST` | `/v1/pools` | Create a pool | `202` with job |
| `GET` | `/v1/pools/:name` | Pool detail (status, vdevs, properties) | `200` |
| `PUT` | `/v1/pools/:name` | Update pool properties | `202` with job |
| `DELETE` | `/v1/pools/:name` | Destroy a pool | `202`/`409` |
| `POST` | `/v1/pools/:name/scrub` | Start a scrub | `202` with job |
| `POST` | `/v1/pools/:name/export` | Export a pool | `202`/`449` |
| `POST` | `/v1/pools/import` | Import a pool (on collection — pool isn't ours yet) | `202` with job |

#### ZFS Datasets (nested under pools)

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/pools/:name/datasets` | List/tree of datasets in pool | `200` |
| `POST` | `/v1/pools/:name/datasets` | Create a dataset | `202` with job |
| `GET` | `/v1/pools/:name/datasets/*path` | Dataset detail, properties, associated shares | `200` |
| `PUT` | `/v1/pools/:name/datasets/*path` | Update dataset properties | `202` with job |
| `DELETE` | `/v1/pools/:name/datasets/*path` | Destroy a dataset | `202`/`409` |

#### ZFS Snapshots (nested under datasets)

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/pools/:name/datasets/*path/snapshots` | List snapshots | `200` |
| `POST` | `/v1/pools/:name/datasets/*path/snapshots` | Create a snapshot | `202` with job |
| `GET` | `/v1/pools/:name/datasets/*path/snapshots/:snap` | Snapshot detail | `200` |
| `PUT` | `/v1/pools/:name/datasets/*path/snapshots/:snap` | Rename a snapshot | `202` with job |
| `DELETE` | `/v1/pools/:name/datasets/*path/snapshots/:snap` | Destroy a snapshot | `202` with job |
| `POST` | `/v1/pools/:name/datasets/*path/snapshots/:snap/rollback` | Rollback to snapshot | `202`/`449` |

#### SMB Shares

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/shares/smb` | List all SMB shares (including non-ANAS) | `200` |
| `POST` | `/v1/shares/smb` | Create a share | `202` with job |
| `GET` | `/v1/shares/smb/global` | SMB global config | `200` |
| `PUT` | `/v1/shares/smb/global` | Update global config | `202` with job |
| `GET` | `/v1/shares/smb/:name` | Share detail (config + active connections) | `200` |
| `PUT` | `/v1/shares/smb/:name` | Update share config | `202` with job |
| `DELETE` | `/v1/shares/smb/:name` | Remove a share | `202`/`449` |

#### NFS Exports

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/shares/nfs` | List all NFS exports (including non-ANAS) | `200` |
| `POST` | `/v1/shares/nfs` | Create an export | `202` with job |
| `GET` | `/v1/shares/nfs/:path` | Export detail (path is URL-encoded) | `200` |
| `PUT` | `/v1/shares/nfs/:path` | Update export config | `202` with job |
| `DELETE` | `/v1/shares/nfs/:path` | Remove an export | `202`/`449` |

#### Disks (read-only, filtered to relevant storage devices)

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/disks` | List storage disks (filtered, no LVM/loop/boot) | `200` |
| `GET` | `/v1/disks/:id` | Disk detail (id = by-id identifier) | `200` |
| `GET` | `/v1/disks/:id/smart` | SMART health data | `200` |

#### Users & Groups (filtered to relevant accounts)

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/users` | List users (UID >= UID_MIN, no service accounts) | `200` |
| `POST` | `/v1/users` | Create a user | `202` with job |
| `GET` | `/v1/users/:uid` | User detail | `200` |
| `PUT` | `/v1/users/:uid` | Modify a user | `202` with job |
| `PUT` | `/v1/users/:uid/smbpassword` | Set/update SMB password | `202` with job |
| `GET` | `/v1/groups` | List groups | `200` |
| `POST` | `/v1/groups` | Create a group | `202` with job |
| `GET` | `/v1/groups/:gid` | Group detail | `200` |
| `PUT` | `/v1/groups/:gid` | Modify a group (members) | `202` with job |

#### Jobs

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/jobs` | List jobs (filterable by status) | `200` |
| `GET` | `/v1/jobs/:id` | Job detail & status | `200` |

#### Status (singleton, read-only)

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/status` | System overview (pool health, share counts, disk warnings, active jobs) | `200` |

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
    "status": "running", // queued | running | completed | failed
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

### Job Lifecycle

```
QUEUED → RUNNING → COMPLETED
                 → FAILED
```

- **QUEUED** — Accepted, waiting for execution slot
- **RUNNING** — Currently executing, may have progress updates
- **COMPLETED** — Finished successfully, `result` field populated
- **FAILED** — Finished with error, `error` field populated

### Fast vs. slow operations

Both go through the same REST API and job queue. The distinction is in how the **Nuxt API layer** and **frontend** handle them:

- **Fast reads** (GET requests): anasd responds synchronously. No job created. Nuxt returns the result directly to the browser.
- **Mutations** (POST/PUT/DELETE): Always return `202` with a job. The frontend either polls briefly (fast ops complete in <1s) or shows a progress indicator (slow ops like scrub).

---

## anasd Command Whitelist

anasd does NOT accept arbitrary commands. It maps structured operations to specific executables:

### ZFS Operations
| Operation | Command |
|-----------|---------|
| `zpool.list` | `zpool list -Hp` |
| `zpool.status` | `zpool status -p` |
| `zpool.create` | `zpool create [opts] <name> <vdevs...>` |
| `zpool.destroy` | `zpool destroy <name>` |
| `zpool.scrub` | `zpool scrub <name>` |
| `zpool.import` | `zpool import [opts]` |
| `zpool.export` | `zpool export <name>` |
| `zfs.list` | `zfs list -Hp -t all` |
| `zfs.create` | `zfs create [opts] <dataset>` |
| `zfs.destroy` | `zfs destroy <dataset>` |
| `zfs.set` | `zfs set <prop>=<val> <dataset>` |
| `zfs.get` | `zfs get <props> <dataset>` |
| `zfs.snapshot` | `zfs snapshot <dataset>@<name>` |
| `zfs.rollback` | `zfs rollback <snapshot>` |

### SMB Operations
| Operation | Command |
|-----------|---------|
| `smb.config.get` | Read smb.conf (or `net conf list`) |
| `smb.config.set` | Write smb.conf section |
| `smb.share.add` | Add share to smb.conf |
| `smb.share.remove` | Remove share from smb.conf |
| `smb.service.restart` | `systemctl restart smbd` |
| `smb.status` | `smbstatus` |

### NFS Operations
| Operation | Command |
|-----------|---------|
| `nfs.exports.get` | Read /etc/exports |
| `nfs.exports.set` | Write /etc/exports |
| `nfs.export.add` | Add export entry |
| `nfs.export.remove` | Remove export entry |
| `nfs.reload` | `exportfs -ra` |

### System Operations
| Operation | Command |
|-----------|---------|
| `system.disks` | `lsblk -Jb` |
| `system.disk.smart` | `smartctl -a <device>` |
| `user.list` | Parse /etc/passwd |
| `user.add` | `useradd` |
| `user.modify` | `usermod` |
| `group.list` | Parse /etc/group |
| `group.add` | `groupadd` |
| `group.modify` | `groupmod` |
| `smbpasswd.set` | `smbpasswd -a <user>` |

### Parameter validation

Every operation has a schema defining valid parameters. anasd validates before execution:

- Pool names: alphanumeric + underscore/hyphen, no path separators
- Device paths: must start with `/dev/`, must exist as block device
- Dataset names: valid ZFS path characters only
- Property values: validated against known ZFS property types
- Share names: alphanumeric + underscore/hyphen
- Paths: must be absolute, no traversal (`..`)

---

## Authentication & Authorization

### Authentication

ANAS is always accessed through Proxmox UI — Proxmox owns the session.

| Provider | When | How |
|----------|------|-----|
| `PveAuthProvider` | Production (default) | Verifies PVEAuthCookie signature locally (RSA-SHA1 against `/etc/pve/authkey.pub`) — no network calls |
| `DevAuthProvider` | Development & testing | Accepts everything, returns mock user |

- **No login page** — users are already authenticated via Proxmox
- **No JWT / session store** — PVEAuthCookie is the credential, validated on each request
- **No PAM fallback** — standalone access outside Proxmox is not a supported path
- **Session expiry & logout** — managed by Proxmox
- **Auth middleware** (Nuxt server): validates PVEAuthCookie → populates `event.context.user` with `{ name, uid }` → rejects with 401 if invalid
- **Dev mode** (`ANAS_AUTH_PROVIDER=dev`): skips cookie validation, sets a mock user on every request

Proxmox integration:
- Users logged into Proxmox UI are already authenticated to ANAS via PVEAuthCookie — but the cookie is `Secure` and host-scoped, so ANAS must serve HTTPS (with the host's PVE certs), and cross-node access requires the ticket handoff described in **PVE UI Integration** below
- The PVE web UI gains an ANAS section via an injected integration script (see **PVE UI Integration**). PVE 9 has no official UI extension hook — the previously assumed `/usr/share/pve-manager/js/custom.js` mechanism does not exist

Both services run as root — no dedicated service user.

### Authorization
- If you're authenticated, you can do everything. Auth is binary: logged in or not.
- No roles, no groups, no permission matrix. This is a tool, not a meta-system.
- User identity is still propagated to anasd for audit logging.
- If finer-grained access is ever needed, it's a future discussion — not a V1 concern.

---

## Frontend Structure

### UI Model: Routed Views + Floating Panels

ANAS has two navigation layers:

1. **Top-level views are routed pages** — every view (dashboard, pools, disks, and later datasets/shares/jobs) has a stable, deep-linkable URL. This is what lets the PVE UI embed individual ANAS views (see **PVE UI Integration**), and it's the pattern every future epic's views must follow.
2. **Within a view, details and actions are floating panels** — clean bordered overlays (pool detail, SMART data, confirmations) that stack, drag, and dismiss with Escape/click-outside. This mirrors PVE's own grid→floating-window interaction and lets the user cross-reference without losing context.

**Display modes:**
- **Standalone** (direct browser access): ANAS shows its own sidebar for navigating between views.
- **Embedded** (`?embedded=1`, inside the PVE UI): ANAS chrome (sidebar, header) is hidden — navigation belongs to the PVE resource tree. The flag persists across in-app navigation. Views render content-only, filling the frame.

**Key principles:**
- **Views are routes** — deep-linkable, embeddable, bookmarkable.
- **Panels are self-contained** — each fetches its own data on open. No shared state to maintain.
- **Dismiss with Escape or click-outside** — clean restore, no leftover state.
- **Panels can stack** — pool detail on top of pool list, SMART on top of disks.

```
components/
├── FloatingPanel.vue               # Base: overlay box with title, close, Escape/click-outside dismiss
├── storage/
│   ├── PoolList.vue                # Pure presentation: DataTable of PoolSummary[]
│   └── PoolListPanel.vue           # Self-contained: opens FloatingPanel, fetches pools, renders PoolList
├── shares/                         # (future) SMB/NFS list components and panels
├── users/                          # (future) User/group components and panels
└── jobs/                           # (future) Job list components and panels
```

```
pages/
├── index.vue                       # Dashboard view (route: /)
├── auth/
│   └── handoff.vue                 # PVE ticket handoff page — unauthenticated, see PVE UI Integration
└── storage/
    ├── pools.vue                   # Pools view (route: /storage/pools)
    └── disks.vue                   # Disks view (route: /storage/disks)
```

### Nuxt Server API Routes (proxy to anasd)

```
server/api/
├── pools.get.ts                    # GET /api/pools → anasd /v1/pools
└── ...                             # Additional proxy routes added per feature
```

---

## PVE UI Integration

ANAS appears as a native-feeling section in the Proxmox web UI, modeled on how PVE presents **Ceph**: a collapsible group in the **node** menu whose items render in the content area. Node-level placement matches PVE's mental model (storage is node-scoped) and scales to clusters.

```
Node "pve1"
├─ Summary / Shell / System / Disks ...   (PVE's own)
└─ ANAS                                   (collapsible section, injected)
   ├─ Dashboard        → iframe /?embedded=1
   ├─ Storage
   │  ├─ Pools         → iframe /storage/pools?embedded=1
   │  └─ Disks         → iframe /storage/disks?embedded=1
   ├─ Shares (SMB/NFS) → added with Epics 6–7
   └─ Jobs             → added with Epic 9
```

### Mechanism

PVE 9 has **no official UI extension hook**. Verified facts (PVE 9.2, stunt node):
- pveproxy serves unowned files dropped into `/usr/share/pve-manager/js/` (dpkg never removes files it doesn't own — survives upgrades)
- The PVE UI page sends no CSP or X-Frame-Options headers — same-origin injected scripts and cross-port iframes work
- `PVEAuthCookie` is set by PVE's own JS with `Secure` + `SameSite=Lax`, is **not** HttpOnly (readable by page JS), and tickets are **cluster-valid** (any node verifies against the shared authkey)

Integration therefore consists of:
1. **`/usr/share/pve-manager/js/anas.js`** — our ExtJS integration script, served at `/pve2/js/anas.js`. Our file, upgrade-safe.
2. **One `<script>` line inserted into `/usr/share/pve-manager/index.html.tpl`** (after `pvemanagerlib.js`). This is the single fragile point: pve-manager upgrades overwrite the template. Mitigations: the insert is idempotent (presence-checked, no marker comments), an apt `DPkg::Post-Invoke` hook re-applies it after upgrades, `anas doctor` detects and repairs it, and uninstall restores the pristine template.
3. **Fail-open script**: `anas.js` wraps everything in try/catch and feature-detects the ExtJS internals it touches. Worst-case failure is "no ANAS section appears" — never a broken PVE UI.

### Ticket handoff (cross-node auth)

The cookie is host-scoped: logged into node A's UI, the browser has no cookie for node B's ANAS. The integration script hands the (cluster-valid) ticket to the target node's ANAS via postMessage:

1. Menu item renders an iframe: `https://<node>:3000/auth/handoff?to=/storage/pools`
2. The handoff page (**served without auth** — it renders no data, only performs the handshake) posts `{ type: 'anas:handoff:ready' }` to `window.parent`, targetOrigin `https://<pve-host>:8006`
3. The parent script replies `{ type: 'anas:handoff:ticket', ticket: <PVEAuthCookie value> }`, targetOrigin `https://<node>:3000`
4. The handoff page **verifies `event.origin`** is the expected PVE UI origin, sets `PVEAuthCookie` on its own origin (`Secure; SameSite=Lax; path=/`), and `location.replace()`s to `to` + `?embedded=1`
5. `to` must be a same-origin relative path (validated — no open redirect). If no ticket arrives within a timeout, the page shows "Log into Proxmox first."

ANAS validates the handed-off cookie on every request exactly as it does today (local RSA-SHA1) — the handoff adds **no new server-side auth paths**.

Node addressing (v1): when the selected tree node is the one serving the PVE UI (`Proxmox.NodeName`), the iframe uses `window.location.hostname` — this preserves IP-based access, where the node name may not resolve from the admin's browser. For other cluster nodes, the node name is used (standard PVE cluster `/etc/hosts`/DNS assumption). Port is 3000; overrides come with `/etc/anas/config.yaml` (story 10.5).

### Forward compatibility

- **Epic 12 (central multi-node ANAS)**: the injected script doesn't care whether it loads N per-node ANAS instances or one central one — only the iframe URL changes.
- **Upstream extension point**: if PVE ever ships an official UI hook, the tpl insert is replaced by the sanctioned mechanism; everything else stays.

---

## Deployment & Installation

### Target install experience

```bash
npm install -g anas
sudo anas setup          # Creates 'anas' user, systemd units, socket dir
sudo systemctl enable --now anasd anas
```

### What `anas setup` does
1. Creates `/run/anas/` directory (via tmpfiles.d)
2. Installs `anasd.service` and `anas.service` systemd units
3. Generates `/etc/anas/config.yaml` with defaults
4. Configures TLS (detects Proxmox certs, falls back to self-signed generation)

### systemd units

**anasd.service**
```ini
[Unit]
Description=ANAS Storage Management Daemon
After=zfs.target

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/anasd/index.js
User=root
RuntimeDirectory=anas

[Install]
WantedBy=multi-user.target
```

**anas.service**
```ini
[Unit]
Description=ANAS Web Interface
After=anasd.service
Requires=anasd.service

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/anas/.output/server/index.mjs
User=root
Environment=NODE_ENV=production
Environment=NUXT_PORT=3000

[Install]
WantedBy=multi-user.target
```

---

## Security Considerations

### Attack surface minimization
- Nuxt never executes system commands — all mutations go through anasd's REST API
- anasd only accepts structured REST operations, never raw commands
- Unix socket (not TCP) — only local processes can reach anasd
- Both processes run as root (like Proxmox) — the API contract is the security boundary

### Input validation layers (defense in depth)
1. **Frontend** — client-side validation for UX (not security)
2. **Nuxt API routes** — server-side validation using Zod schemas
3. **anasd** — validates parameters using the same shared Zod schemas before execution

Shared schemas mean validation is defined once and enforced at both boundaries.

### Authentication & audit chain
```
Browser ──cookie──→ Nuxt ──X-Anas-User──→ anasd ──audit log──→ syslog/file
                           X-Anas-UID
                           X-Anas-Groups
                           X-Anas-Request-ID
```
- User identity propagated on every request to anasd
- anasd logs every mutating operation with user, operation, params, and result
- Request ID enables end-to-end correlation across both services
- anasd trusts identity headers because the Unix socket is access-controlled

### Command injection prevention
- `execFile` (not `exec`) — no shell interpretation
- Arguments passed as arrays, never interpolated into strings
- Parameter values validated against strict patterns (Zod schemas)
- anasd command whitelist — only known operations can be executed

### Session security
- httpOnly, secure cookies
- CSRF protection via Nuxt middleware
- Session timeout (configurable, default 30 min)

---

## Implementation Plan

### Phase 1: Foundation
1. Initialize Nuxt 3 project with TypeScript
2. Initialize anasd as Fastify server on Unix socket
3. Define shared Zod schemas package (request/response types)
4. Implement REST client in Nuxt for anasd communication (with auth header propagation)
5. Build job queue in anasd (submit, status, lifecycle)
6. Implement PAM authentication in Nuxt
7. Build basic layout shell (sidebar nav, header, content area)
8. Create the `anas setup` CLI command
9. Audit logging infrastructure in anasd

### Phase 2: ZFS Management
1. Pool listing and status display
2. Pool creation wizard (disk selection, vdev layout, properties)
3. Dataset listing (tree view)
4. Dataset creation and property management
5. Snapshot creation, listing, and rollback
6. Pool scrub initiation and progress tracking

### Phase 3: Share Management
1. SMB share listing and creation
2. SMB share configuration (permissions, guest access, etc.)
3. NFS export listing and creation
4. NFS export configuration (client restrictions, options)
5. Service status and restart controls

### Phase 4: Users & Security
1. System user listing
2. User creation (for share access)
3. Group management
4. SMB password management
5. Share permission assignment (map users/groups to shares)

### Phase 5: Polish & Deployment
1. Dashboard with pool health overview
2. Job history view
3. Error handling and user feedback
4. `npm pack` / publish workflow
5. Setup command and systemd integration
6. Documentation

---

## Resolved Design Decisions

### 1. UI Component Library: PrimeVue

PrimeVue with tree-shaking (import only what we use). Key components:
- **DataTable** — pool lists, dataset lists, share lists, user lists, job history
- **TreeTable** — ZFS dataset hierarchy (pool → dataset → child → snapshot)
- **Stepper / form components** — pool creation wizard, share configuration
- **Dark mode** — Lara Dark theme, professional look for sysadmin context

Use PrimeVue's built-in theming system. Do not add Tailwind — one design system, not two.

Nuxt integration via `@primevue/nuxt-module`.

### 2. Configuration File: `/etc/anas/config.yaml`

YAML format (readable, supports comments, sysadmin-friendly). Generated by `anas setup` with sensible defaults.

Contents:
- Listen port (default: 3000)
- TLS certificate and key paths
- Session timeout (default: 30 min)
- Log level
- Socket path (default: `/run/anas/anasd.sock`)

### 3. TLS: Proxmox Certificates with Self-Signed Fallback

TLS certificate resolution order:
1. Explicit paths in `/etc/anas/config.yaml` (user override)
2. Proxmox node certificates (`/etc/pve/local/pve-ssl.pem`, `/etc/pve/local/pve-ssl.key`) — piggyback on existing trusted certs
3. Self-signed certificate generated by `anas setup` into `/etc/anas/tls/`

This means on a standard Proxmox install, ANAS uses the same certificate as the Proxmox UI with no extra configuration. Users who have set up trusted certs for Proxmox get that for free.

### 4. Job Persistence: In-Memory + journald Audit Logging

Job queue is in-memory. Jobs are lost on restart — this is acceptable because:
- The system state (ZFS, smb.conf, /etc/exports) is the source of truth, not the job queue
- Users can resubmit any operation
- Job history is a convenience, not critical data

**Audit logging goes to journald** from day one. Every mutating operation logs to the systemd journal with structured fields:
- User, operation, parameters, result, timestamp
- Queryable via `journalctl -u anasd` with standard tooling
- Survives restarts, managed by system log rotation
- No custom log files to manage

**Proxmox notification system** — investigate for V1 or early V2. Proxmox has a flexible notification framework (email, Gotify, etc.) that users already configure. Surfacing events like "scrub completed," "pool degraded," or "disk error" through it would be valuable and avoids building our own notification system.

### 5. Config File Management: Surgical, Non-Destructive Editing

**ANAS is a guest on the system, not the owner.** We do not own smb.conf or /etc/exports. We do not overwrite them. We do not use marker comments.

The approach:
- **Parse** the full config file, understanding its complete structure
- **Identify** the sections/entries that ANAS manages
- **Make surgical changes** — add, modify, or remove only the specific sections we're working with
- **Preserve everything else** — manual edits, comments, ordering, whitespace, unknown directives

This requires proper parsers for each config format:
- **smb.conf** — INI-like format. Parse all sections, modify only ANAS-managed shares, write back preserving unrelated sections verbatim.
- **/etc/exports** — line-based format. Parse all entries, modify only ANAS-managed exports, write back preserving unrelated entries verbatim.

ANAS is fully stateless regarding config management. It does not track which shares or exports it created. The config files are the source of truth. When a user wants to modify a share, ANAS reads the current config, understands the full structure, makes the targeted change, and writes it back. If someone has manually edited the config between operations, ANAS sees the current state — not stale cached state.

This means ANAS can manage any share or export, regardless of whether ANAS created it or someone added it manually. It's a tool, not an owner.

This is more complex to implement but essential to the Proxmox philosophy — the system was here before ANAS and will be here after.

### 6. Session Management: Proxmox owns the session (no ANAS session at all)

ANAS does not manage sessions. PVEAuthCookie is the only credential, validated on each request against the Proxmox API. Rationale:

- **ANAS is always accessed through Proxmox** — the user is already authenticated
- **No login page, no JWT, no PAM** — massive simplification with no loss of functionality
- **Guest philosophy** — we don't own what we don't need to own
- **Session expiry, logout** — Proxmox handles it; we just validate what we're given

---

## Remaining Open Questions

1. **Proxmox notification integration** — V1 scope. Need to research the Proxmox notification API/CLI for surfacing operation results, pool health events, etc.
2. **Config file parsers** — Need to identify or build robust parsers for smb.conf and /etc/exports that can round-trip (parse → modify → write) without losing comments, whitespace, or unknown directives.
