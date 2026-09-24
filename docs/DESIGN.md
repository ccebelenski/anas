# ANAS — A NAS

## Overview

ANAS is the storage layer Proxmox VE doesn't have. Proxmox manages the storage its guests consume; ANAS manages the storage a node *serves* — ZFS and ANAS Hybrid RAID pools, datasets and zvols, SMB shares, NFS exports, an iSCSI target, snapshots and schedules, replication, backup to Proxmox Backup Server with restore, client-side mounts, and disk health. It targets Proxmox VE (and potentially other Linux platforms).

It runs on the PVE node itself, presented as native ExtJS panels injected into the PVE web UI — the same model Proxmox uses for Ceph. There is no separate appliance, no separate web app, and no second login: PVE owns the session. ANAS complements Proxmox rather than replacing it, and stays a guest on the system it manages — PVE keeps identity, notifications, certificates, scheduling and its own storage territory.

## V1 Scope

### In scope
- ZFS pool creation, management, and monitoring (status, scrub, properties)
- ZFS dataset creation and management (quotas, compression, snapshots)
- SMB share configuration and management
- NFS export configuration and management
- Share security and permissions (users, groups, ACLs)
- PVE-session authentication (Proxmox owns the session)
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
│    Browser — PVE web UI (:8006)              │
│    ANAS views are native ExtJS panels        │
│    injected into pve-manager (Ceph model)    │
└──────────────────┬──────────────────────────┘
                   │ HTTPS to PVE's own :8006, path /anas/...
                   │ (pveproxy fail-open hook → loopback gateway;
                   │  same origin, no cert exception, no CORS)
                   │ PVEAuthCookie flows same-origin
                   │ /anas/api/nodes/<node>/v1/...
                   ▼
┌─────────────────────────────────────────────┐
│           anas (API gateway)                 │
│                                              │
│  - Binds 127.0.0.1:3000, plain HTTP (no TLS, │
│    no public origin — pveproxy terminates    │
│    TLS at :8006 and proxies /anas here)      │
│  - Verifies PVEAuthCookie (RSA-SHA1, local)  │
│  - Input validation (Zod schemas)            │
│  - Node routing: self → local anasd socket,  │
│    other → forwards to <node>:8006/anas       │
│    (ticket forwarded, cluster-CA TLS)        │
│  - No system command execution, no pages     │
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

### Transport: single surface through pveproxy `:8006/anas`

The gateway is **not** a public origin. It binds `127.0.0.1:3000` as a plain-HTTP
loopback service; ANAS's API reaches the browser through **PVE's own `:8006`
front door under the `/anas` path**, via a fail-open reverse-proxy hook in
pveproxy that forwards to the loopback gateway. There is no separate `:3000`
origin, no per-port certificate exception, and no CORS — same origin as the PVE
UI, so the `PVEAuthCookie` flows automatically. "If the PVE UI loads, ANAS
does." Cross-node forwarding targets `<node>:8006/anas`, with peers resolved via
PVE cluster membership (`/etc/pve/.members`), not DNS. The hook is one additive
block that runtime-requires an ANAS-owned Perl module, so a broken or missing
ANAS side degrades `/anas` only and never `:8006`. See
[`PROXY-TRANSPORT-DESIGN.md`](PROXY-TRANSPORT-DESIGN.md) for the authoritative
detail (story 12.2).

### Why two processes?

Both processes run as root (like Proxmox). The separation is architectural, not privilege-based:

1. **Clean API boundary** — The web app never executes system commands. All operations go through anasd's REST API, which only accepts structured, whitelisted operations. This is the security contract.
2. **Non-blocking UI** — Long operations (pool creation, scrub, resilver) run in the background via the job queue. The UI submits jobs and polls for status.
3. **End-to-end traceability** — Every operation carries the authenticated user's identity from browser → anas gateway → anasd. anasd logs who did what, when, via journald. Critical for corporate/compliance environments.
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
| UI | ExtJS panels injected into pve-manager (the Ceph model) | Native PVE look, theme, and interaction — no iframe, no style clash, users stay in the UI they know |
| API gateway (anas) | Fastify (TypeScript) | Same stack as anasd; auth verification, validation, node forwarding. Plain HTTP on loopback, fronted by pveproxy at `:8006/anas` (no TLS/CORS of its own) |
| Config format | YAML (`/etc/anas/config.yaml`) | Human-readable, supports comments |
| Auth | PVE ticket (verified locally against the replicated cluster authkey); Dev provider for testing | Proxmox owns the session; tickets are cluster-valid |
| Daemon runtime | Node.js (TypeScript) | Same language as gateway, shared schemas, single npm package |
| Daemon framework | Fastify | Lightweight, schema validation built-in, Unix socket support |
| IPC | REST (HTTP) over Unix domain socket | Formal semantics, curl-debuggable, auth propagation |
| Project structure | Monorepo (packages/) | shared schemas imported by both anas and anasd |
| Schema validation | Zod (shared between anas and anasd) | Single source of truth for request/response types |
| Command execution | `child_process.execFile` | No shell interpretation, no injection |
| Process management | systemd | Standard, reliable, already on Proxmox |

---

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
X-Anas-User: admin
X-Anas-User-UID: 1000
X-Anas-Request-ID: 550e8400-e29b-41d4-a716-446655440000
```

anasd trusts these headers because the Unix socket restricts access to local processes. This gives us:

- **Full traceability** — every privileged operation is tied to a user, even in anasd's logs
- **Audit logging** — anasd logs `who did what, when` for every mutating operation via journald
- **Request correlation** — `X-Anas-Request-ID` links the browser request → anas gateway → anasd operation for end-to-end tracing

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
| `POST` | `/v1/pools/:name/export` | Export a pool | `202`/`409` |
| `POST` | `/v1/pools/:name/vdevs` | Add a vdev (`AddVdevRequest`: role data/log/cache/spare/special/dedup + type + whole disks) — `zpool add` (3.21/3.23) | `202` with job |
| `POST` | `/v1/pools/:name/vdevs/remove` | Remove a **cache, log or spare** vdev (`{ vdev }`: a leaf named by its device-path basename — `ata-SSD-part2`, `sdb3` — or a log `mirror-N`) — `zpool remove`, instant, no evacuation; `400` for data/special/dedup vdevs (evacuation is a different operation ANAS does not offer), a vdev the pool does not carry, a name that fits more than one leaf (a split by-id device), or a spare ZFS has put to work; plain job, no confirm code (vdevs.2, #66) | `202`/`400` |
| `POST` | `/v1/pools/import` | Import a pool (on collection — pool isn't ours yet) | `202` with job |

**Reshaping a pool's topology** — both vdev routes above stand behind ONE pre-flight: the system-pool `409` (the pool holding this node's boot filesystem, no bypass), then the PVE-ownership `400`. PVE owns the topology of the pools it manages, and adding a vdev reshapes a pool exactly as removing one does (pvepool.1).

#### ZFS Datasets (nested under pools)

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/pools/:name/datasets` | List/tree of datasets in pool | `200` |
| `POST` | `/v1/pools/:name/datasets` | Create a dataset | `202` with job |
| `GET` | `/v1/pools/:name/datasets/*path` | Dataset detail, properties, associated shares | `200` |
| `PUT` | `/v1/pools/:name/datasets/*path` | Update dataset properties | `202` with job |
| `DELETE` | `/v1/pools/:name/datasets/*path` | Destroy a dataset | `202`/`409` |

**Volumes (iscsi epic, 2026-08-25):** a dataset of `type: volume` is first-class in the same resource — `POST` accepts `{type: 'volume', volsize, volblocksize, sparse}`; `PUT` may grow `volsize` — carried under `properties` like every other ZFS property (`zfs set volsize=`) — (live under a LUN — the initiator rescans) but a shrink, a rename, or a rollback of a volume referenced by a LUN is refused (ZFS lets all three through silently). Volumes have no mountpoint and cannot be shared; PVE-owned `vm-*` zvols stay hands-off.

#### ZFS Snapshots (nested under datasets)

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/pools/:name/datasets/*path/snapshots` | List snapshots | `200` |
| `POST` | `/v1/pools/:name/datasets/*path/snapshots` | Create a snapshot | `202` with job |
| `GET` | `/v1/pools/:name/datasets/*path/snapshots/:snap` | Snapshot detail | `200` |
| `PUT` | `/v1/pools/:name/datasets/*path/snapshots/:snap` | Rename a snapshot | `202` with job |
| `DELETE` | `/v1/pools/:name/datasets/*path/snapshots/:snap` | Destroy a snapshot | `202` with job |
| `POST` | `/v1/pools/:name/datasets/*path/snapshots/:snap/rollback` | Rollback to snapshot | `202`/`409` |

#### SMB Shares

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/shares/smb` | List all SMB shares (including non-ANAS) | `200` |
| `POST` | `/v1/shares/smb` | Create a share | `202` with job |
| `GET` | `/v1/shares/smb/global` | SMB global config | `200` |
| `PUT` | `/v1/shares/smb/global` | Update global config | `202` with job |
| `GET` | `/v1/shares/smb/:name` | Share detail (config + active connections) | `200` |
| `PUT` | `/v1/shares/smb/:name` | Update share config | `202` with job |
| `DELETE` | `/v1/shares/smb/:name` | Remove a share | `202`/`409` |

#### NFS Exports

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/shares/nfs` | List all NFS exports (including non-ANAS) | `200` |
| `POST` | `/v1/shares/nfs` | Create an export | `202` with job |
| `GET` | `/v1/shares/nfs/:path` | Export detail (path is URL-encoded) | `200` |
| `PUT` | `/v1/shares/nfs/:path` | Update export config | `202` with job |
| `DELETE` | `/v1/shares/nfs/:path` | Remove an export | `202`/`409` |

#### Mounts (Epic 18 — external & local storage; designed 2026-07-18)

Identity is the URL-encoded mountpoint (the NFS-exports precedent). Pure management: ANAS writes fstab (surgical round-trip) and invokes `mount`/`umount`; the kernel, `mount.nfs`/`mount.cifs`, and systemd's fstab generator do the work. PVE-owned mounts (read-only `storage.cfg` parse) appear in the list tagged hands-off and reject mutations.

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/mounts` | Inventory: remote + local + PVE-tagged; configured (fstab) vs actual (findmnt) vs health per entry | `200` |
| `POST` | `/v1/mounts` | Create: write fstab (if persistent) + mount now | `202` with job |
| `GET` | `/v1/mounts/:mountpoint` | Detail: fstab line as written, effective options, health, capacity | `200` |
| `PUT` | `/v1/mounts/:mountpoint` | Edit options/credentials → fstab rewrite + remount | `202` with job |
| `DELETE` | `/v1/mounts/:mountpoint` | Unmount + drop fstab entry; busy → 409 listing holding processes, force/lazy behind confirm. Optional `?removeMountpointDir=true` (default false — an older client is unchanged) also removes the mountpoint DIRECTORY with **rmdir semantics only**: empty, never recursive, never a still-mounted path. A dir that stayed rides the completed job's `warnings[]` — never a failure | `202`/`409` |
| `POST` | `/v1/mounts/:mountpoint/state` | `{action: mount\|unmount\|disable\|enable}` — kernel-state and boot-config toggles WITHOUT deleting the entry. `unmount` = kernel now, returns at boot; `disable` = unmount + comment the fstab line as `#ANAS <original line verbatim>` (survives reboot as off, credentials kept, byte-identical restore on `enable`); busy-unmount → 409 as above. Added at Stage-2/3 reconciliation 2026-07-18 (operator: "deleting the mount entry and unmounting are two different things" + the `#ANAS` disable marker). Pools action-subresource idiom. | `202`/`409` |
| `POST` | `/v1/mounts/test` | Preflight diagnosis: the typed server/share is normalised first (empty CIFS share or unusable server → `400` with the guiding sentence, never a probe) → DNS → port (2049/445) → timeout-guarded probe mount (no-credentials CIFS probes as `guest`, so they never prompt) → unreachable / auth / not-found / protocol / **invalid** (EINVAL — malformed server or share, e.g. the kernel's "Malformed UNC in devname") / OK | `200`/`400` |

Key decisions: **status never touches a mountpoint synchronously** (dead NFS server hangs `stat()`; all liveness/capacity via `timeout`-guarded `stat -f` in a child process → ok/stale/unreachable/unmounted). CIFS credentials in per-mount 0600 root-only files under `/etc/anas/creds/` (local, not pmxcfs — mounts are per-node and boot must not depend on pmxcfs), write-only through the API. Defaults: boot mount with `nofail` forced; `x-systemd.automount` an exposed toggle; `nosuid,nodev` on remote mounts; NFS `vers=4.2`/`hard`, CIFS `vers=3.1.1` (1.0 behind a loud warning). Options are a structured known tier + verbatim passthrough for everything else. An **armed** row (an `x-systemd.automount` placeholder whose mount has idled away) takes its identity — type, remote, source, server/share — from the fstab entry, never from the `autofs`/`systemd-1` placeholder findmnt reports; only the STATE comes from the live table (issue #35). Dashboard warning category `mount`, failures only.

The edit (`PUT`) flow is **validate-then-commit and verify-delivered** (issues #24/#25, live on a real node): a rotated CIFS secret is written to a sibling `.<name>.validating` file and PROVEN by the same probe mount `/v1/mounts/test` uses before it replaces the live creds file — a rejected password commits nothing (creds file and fstab both untouched), where it used to be written first and only surface at the next automount cycle or reboot. The remount then refuses to mount over a REFUSED unmount (util-linux reports an already-mounted target as success): a busy mountpoint falls back to `mount -o remount` and the kernel mount table — not an exit code — decides whether the new options are live, failing the job with the holding processes named when they are not. `persistent` is edit-time IDENTITY (like type and server): it lives on create only — and because the server/export path are identity too, the dialog renders them read-only on an edit and the preflight test probes the STORED spec, never a value the save would drop (issue #38).

Request options carry a **clear contract** (issue #34): every value-bearing option in `MountRequestOptions` is `T | null`, where a value SETS, `null` CLEARS (the option leaves the entry), and an omitted field KEEPS what is stored. The UI therefore sends every option on every save — its value, or `null` when the field is blank — because "omitted" can only ever mean "keep", which is why a blanked field used to come back. Both write paths (create and edit) apply options through ONE helper, so the three cases cannot diverge, and a blank passthrough field clears the passthrough. The pre-fill is exact — an option the entry lacks shows blank — so an untouched save rewrites the fstab line byte-for-byte instead of writing dialog defaults the operator never chose.

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/disks` | List storage disks (filtered, no LVM/loop/boot) | `200` |
| `GET` | `/v1/disks/:id` | Disk detail (id = by-id identifier) | `200` |
| `GET` | `/v1/disks/:id/smart` | SMART health data | `200` |

> **Usage classification:** a disk's `status` names who owns it — `system`, `pool_member` (ZFS), `ahr_member` (issue #3), `ceph_osd` (issue #29), `available` (genuinely blank), `other`. Every membership value means IN USE; only `available` is ever offered for pool/array composition. Ceph OSDs are read structurally out of the lsblk tree ANAS already fetches — an LVM descendant whose fstype is `ceph_bluestore`, or whose LV sits under the `ceph--` VG naming convention (which also catches dedicated DB/WAL devices carrying no bluestore label) — so the classification needs no ceph tooling and costs nothing on a node without Ceph.

#### iSCSI — block storage (iscsi epic; designed 2026-08-25, ground truth `docs/ISCSI-GROUND-TRUTH.md`)

ANAS is the **target side only** — a generic iSCSI target on LIO (kernel target) driven by `targetcli-fb`; PVE and guests are ordinary initiators and `storage.cfg` is never written. Identity: a target is its URL-encoded IQN; a LUN is its index `n` within the target. Two backing kinds: `zvol` (ZFS) and `file` (a sparse raw image on a dataset or AHR pool — AHR's only kind). Read model = `saveconfig.json` (persisted) + configfs (live); writes = one `targetcli` command per invocation (stdin batching always exits 0 and autosaves half-applied state) behind a daemon mutex, then `saveconfig`.

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/iscsi/targets` | All targets on the node: ANAS-managed (ownership derived from the backing path + naming, never shadow state) and foreign ones tagged hands-off; per target: portals, LUN count, session count, enabled, health | `200` |
| `POST` | `/v1/iscsi/targets` | Create a target: user-facing name → stable ANAS-generated IQN (immutable after creation — a "rename" is a new target), portals (address picked from PVE's network config; IPv6 ULA ok, link-local refused by LIO), initiator ACLs, auth (`none` / CHAP / mutual CHAP; secrets write-only). The auto-added `0.0.0.0:3260` portal is removed; `demo_mode_discovery=0`, `generate_node_acls=0` | `202` with job |
| `GET` | `/v1/iscsi/targets/:iqn` | Detail: portals, LUNs (kind, backing, size, **serial**, attributes), ACLs (`credentialsSet`, never the secret), live sessions (from `acls/<iqn>/info`), restore holes (saveconfig ⟷ configfs diff) | `200` |
| `PUT` | `/v1/iscsi/targets/:iqn` | Edit portals / ACLs / auth (rotate secrets: written to configfs, never argv) | `202` with job |
| `DELETE` | `/v1/iscsi/targets/:iqn` | Delete an EMPTY, session-free target only (operator ruling 2026-08-26): live sessions → `409`, no bypass, listing the initiators ("log them out first"); any LUN still mapped → `409`, no bypass ("delete the LUNs first" — each LUN delete keeps its backing unless `destroyBacking`); no confirm code on this route any more | `202`/`409` |
| `POST` | `/v1/iscsi/targets/:iqn/state` | `{action: enable\|disable}` — TPG enable flag; `disable` is also the entry gate a LUN restore uses | `202` with job |
| `POST` | `/v1/iscsi/targets/:iqn/luns` | Add a LUN: `{name, kind: zvol\|file, backing}` — `zvol` names an existing ANAS-managed volume (PVE `vm-*` zvols never eligible); `file` names a dataset or AHR pool + `size` and creates the sparse image. `name` is the SCSI model string initiators see (validated). ANAS sets `emulate_tpu=1`, `emulate_tpws=1`, `max_unmap_lba_count`, fileio `write_back=0`; `block_size` chosen here (immutable once mapped); serial generated and stored | `202` with job |
| `GET` | `/v1/iscsi/targets/:iqn/luns/:n` | LUN detail incl. serial, attributes, connected initiators, backup/restore eligibility | `200` |
| `PUT` | `/v1/iscsi/targets/:iqn/luns/:n` | Resize (zvol: live grow — **allowed under a live session**, the initiator rescans, same rule as the Datasets door; file: delete + recreate replaying **serial and attributes** — refused under a session; shrink always refused), attribute changes (`write_back` behind a warning, refused under a session) | `202`/`409` |
| `DELETE` | `/v1/iscsi/targets/:iqn/luns/:n` | Unmap + delete backstore; `?destroyBacking=true` also destroys the zvol/image behind the confirm gate; a LUN in use by a live session → `409`, no bypass — per LUN, via each session's `mappedLuns` (operator ruling 2026-08-26) | `202`/`409` |
| `GET` | `/v1/iscsi/sessions` | Every live session on the node (initiator IQN, target, LUNs, addresses) — the cross-feature gates and the dashboard read this | `200` |
| `GET` | `/v1/iscsi/claims` | Every backing path currently mapped as a LUN (`{path, targetIqn, index, kind}`) — the ONE call Pools/Datasets/AHR/Mounts ask "is this held by a LUN?" (`iscsi.6`) | `200` |
| `GET` | `/v1/iscsi/health` | saveconfig ⟷ configfs diff (LUNs whose backing device was missing at restore, portals bound to addresses no interface carries, foreign changes, `targetsServingNothing` = targets restored with none of their saved LUNs, `stubLuns[]` = fileio placeholders the restore service created (quarantined on read), `disabledTargets[]`, `degraded`) — feeds the `iscsi` dashboard warning category | `200` |
| `POST` | `/v1/iscsi/health/repair` | Re-create the LUNs a boot restore dropped as a **surgical `targetcli` replay of the persisted record** (`wwn=` + attributes + the stored index + ACL re-grants) — NEVER `targetctl restore`, whose rtslib default `clear_existing=True` wipes every live target and session; `409` while any backing device is still absent (naming them); `saveconfig` only after a repair that left no holes | `202`/`409` |

`GET /v1/iscsi/targets` also carries `nodeInitiatorIqn` (this node's own initiator name from `/etc/iscsi/initiatorname.iscsi`, `null` when unknown — additive) so the ACL editor can offer **Add this node**; and because discovery is closed to unlisted initiators, **a create with an empty ACL list is refused with a guiding 400** (an edit that removes the last ACL is allowed but warns on the job) — an operator finding from the first real-node round. Every iSCSI read carries an **availability envelope** (`installed`, `configfsPresent`, `saveconfigPresent`, optional `reason`) around its payload — "LIO not installed" is a first-class, non-error state (fail-open ruling). `IscsiHealth` also carries `degraded` (true whenever the live tree lacks something the persisted config has — the guard that blocks any `saveconfig`) and `interfacesUnknown` (fail-open when `ip -j addr` fails). `GET /v1/iscsi/targets/:iqn` answers `404` for an unknown IQN and `400` for a string that is not an iSCSI name. **IQN convention** (shared `anasIqn`/`isAnasIqn`): authority = reverse(`anas.` + the node's FQDN-or-hostname) — `iqn.<yyyy-mm>.com.example.nas.anas:<name>` for `nas.example.com`, `iqn.<yyyy-mm>.nas.anas:<name>` for a domainless `nas` (live-proof F1: rtslib rejects any authority without a dot — `iqn.2026-08.anas:x` → `WWN not valid as: iqn`; the hostname label also keeps two domainless nodes from colliding). Recognised by the authority's last label being `anas`, deliberately date- and domain-agnostic so a stateless node never has to remember either; `IscsiIqn` refuses an authority with fewer than two labels, mirroring rtslib. A block backstore's size is not in configfs; it is read from `/sys/class/block/<kernel>/size` with the kernel name resolved at point of use and never stored.

**PVE footprint ownership (pvepool.1, designed 2026-09-21 — GitHub #61).** Story 3.25 tagged a whole ZFS pool as PVE's when any `zfspool` storage named it. PVE's real footprint is smaller and is read from `ZFSPoolPlugin.pm` (PVE 9.2.20, verified on the stunt node and pve5): the storage's configured `pool` path — which may be a nested dataset such as `rpool/data` — plus that path's DIRECT children whose names match `^(vm|base|subvol|basevol)-\d+-\S+$` (`zfs list -d1` + that regex is the whole inventory; `alloc_image` enforces the `vm-<vmid>-*` / `subvol-<vmid>-*` prefixes; status is `zfs get available,used <path>`; activation is a blanket `zfs mount -a`; `path()` derives `/dev/zvol/<path>/<name>` or `<mountpoint>/<name>`). Everything else on the pool is invisible to PVE. The relaxed rule: **ownership is per dataset, decided by ONE shared pure predicate, and pool-level actions on a PVE pool stay hands-off** (managing a PVE pool as a whole is a ruled no, #61).

- **Model.** `pveOwnership(refs: PveStorageRef[], dataset: string, system?: SystemPoolFacts): PveOwnership | null` in `@anas/shared`, where `PveOwnership = { storage: string, kind: 'storage-root' | 'guest-volume' | 'dir-storage' | 'system', reason: string }`. Owned when: (a) `dataset` IS a zfspool storage's configured path (`storage-root` — the pool root itself when `pool` is the bare pool name); (b) its parent is a storage path and its basename matches the guest regex (`guest-volume`); (c) it lies under the dataset a `dir` storage's `path` resolves onto (`dir-storage` — 3.25's deferred secondary signal, now in: PVE writes backups/ISOs/templates there; `parsePveStorageCfg` already resolves it via `matchMountpoint`); (d) system pool facts mark it (below). **Ownership is inherited by the whole subtree** of an owned dataset (a guest subvol's children, a dir storage's tree). Everything else — `rpool/ROOT`'s siblings aside — is ANAS-manageable, including new children of a storage root. The predicate is pure over `(refs, name)`; it never lists children, so daemon and UI compute identical answers from the same payload. It replaces the four daemon `isPveManagedPool` copies and six UI `isPveManaged` copies (single source of truth), and `PVE_GUEST_VOLUME_RE` in `iscsi-ownership.ts` is corrected to the plugin's regex (today it lacks `basevol-` and demands a `-disk-<n>` tail, so `subvol-100-foo` and every `basevol-*` slip through).
- **System pool (new hazard the relaxation opens).** On the default ZFS-root installer layout `local-zfs` is `rpool/data`, so a footprint-only rule would expose `rpool` (the root dataset), `rpool/ROOT` and `rpool/ROOT/pve-1` as manageable. `SystemPoolFacts` = `zpool get bootfs` per pool + the dataset `findmnt /` reports; on a pool with `bootfs` set or hosting `/`, the boot dataset, every ancestor up to and including the pool root, and the boot dataset's parent's WHOLE subtree (`rpool/ROOT/*`) are `system`-owned; **pool-level destructive ops on a system pool (destroy, export, change mount) are refused hard, no confirm bypass**; siblings such as `rpool/media` are ordinary datasets (a default install already keeps `rpool/ROOT` beside `rpool/data`). Neither test node boots from ZFS, so this gets a loop-pool ground truth with `bootfs` set.
- **Naming guard.** ANAS refuses to create, rename or clone a dataset whose basename matches the guest regex as a direct child of a storage path — PVE would inventory it as a guest disk on its next `list`. Validated in the dialog (field-level, before submit) and at the daemon (400, the backstop).
- **Consumers, re-examined.** *Pools* (grid, detail, `PUT /mountpoint`): unchanged — Export / Destroy / Add-vdev / Attach / Modify / Change-mount stay disabled on a PVE pool (badge tooltip names the storage AND now says datasets outside PVE's footprint are manageable). *Datasets*: per-node `pve?: PveOwnership` (additive, optional) on `DatasetNode`/`Dataset`; the storage root is view-only for props / share / snapshot / destroy (3.26's reasoning holds — a recursive root snapshot sweeps guest zvols) but **Create child is enabled on it**; guest volumes and dir-storage trees are view-only with Detail; every other node is fully manageable. *Snapshot schedules* (`routes/schedules.ts`): refuse only owned targets, not the pool; a recursive schedule on a storage root stays refused. *Replication target* (`replication-target.ts`, `routes/replication*.ts`): refuse only when the target dataset (or the child it would create) is owned or trips the naming guard. *iSCSI* (`iscsi-ownership.ts`, `iscsi-mutate.ts`): `foreign` / refusal only for owned backings (`backing-pve-guest-disk` keeps its text; `backing-pve-storage` becomes the storage-root / dir-storage case; the `pve-managed-pool` refusals go). *Backup consistency* (`backup-consistency.ts`): `live` downgrade only for owned sources; siblings get the normal snapshot; `lun-sources` hides only owned LUNs. *Mounts* and *file restore* are path-based already (`pveStorageFor`, `pveTerritoryReason`) — unchanged. **Version skew, fail-safe direction:** an old daemon omits the per-node `pve` field; a new UI that sees `pveStorages[]` non-empty on the pool AND no per-node field keeps the whole-pool rule — skew may only ever tighten, never loosen, a hands-off gate.
- **Workflow (equal weight — §2 rule).** *Where it lives:* Datasets menu, no new screen. *Happy path:* the tree shows the PVE pool with a badge "PVE storage root: local-zfs"; its guest volumes carry the PVE badge, greyed row, Detail only; a sibling such as `rpool/media` renders as any ANAS dataset. Create dataset → the pool picker now lists PVE pools → picking one shows an INFORMATIONAL note (blue, not a warning): "Guests on this pool share its I/O; PVE's free-space figure for `local-zfs` shrinks by what ANAS uses here." → name field validates the guest pattern live → job → on completion the tree reloads with the new node selected; on failure the tree reloads too and the toast carries the daemon's sentence. Share / Snapshot / Replication / Schedule / add-LUN pickers list the sibling datasets and omit owned ones. *Timeliness:* ownership is computed server-side per request from storage.cfg and the live dataset list, so a storage added in PVE's UI is reflected on the next tree load — no cache, no shadow state; the tree reloads after every job (success and failure, the 0.3.3 lesson). *Failure as the user meets it:* the naming guard fires in the dialog before submit, in red on the field, with the sentence "PVE would inventory `vm-100-disk-1` as a guest disk"; daemon refusals name the storage and the dataset ("`local-zfs` owns `rpool/data/vm-100-disk-0`"), never "this pool". *Proof:* Playwright spec over a stunt-node PVE pool (`pvesm add zfspool` — PVE's own tool — with a `vm-100-disk-0` zvol, a `subvol-101-disk-0`, a `basevol-102-disk-0` and an ANAS sibling): badges, disabled/enabled toolbar per node, create-with-note, naming-guard message, reload after success and after an injected failure. Live proof of every daemon refusal path and of the system-pool loop ground truth.

**Cross-feature gates (iscsi.6):** every list/detail row of Pools, Datasets, AHR pools and Mounts carries an additive `heldByLun` (`IscsiHeldByLun`: target, index, name, backing path, connected initiators, the one `detail` sentence) answered ONCE per request from `iscsiClaims()` (never per row; absent on an old daemon ⇒ no gating). Refused up front with a guiding 409 (no confirm bypass) while a LUN holds the object: volume rollback / volsize shrink / rename (seam — no endpoint exists yet), dataset destroy (incl. `-r` over a child zvol), snapshot rollback of a dataset holding an image, **ZFS pool destroy and export** (ZFS does not reliably refuse `zpool destroy` over a claimed zvol), AHR destroy / change-mount (AHR has no unmount verb), mount unmount / disable / remove. `busy-diagnosis` gains the LIO branch (`held by iSCSI LUN <n> '<name>' of target <iqn> (<path>)`, `fuser` not consulted); a busy zvol destroy quotes a dataset, which the path extractor now reads. `GET /v1/iscsi/targets/:iqn` carries `firewall` (`IscsiFirewallAdvisory`, read-only from `pve-firewall status` + `/etc/pve/firewall/*.fw`; advisory only on enabled + nothing admits 3260/tcp; never written). Disks: `Disk.handsOff`/`handsOffReason` (`iscsi-served-here` when an iSCSI-transport disk's serial matches a LUN this node serves), `zd*` excluded like loop/zram, and one shared `isComposableDisk()` predicate at every composer/spare/expand candidate site. **Backing tiers:** `IscsiLunKind` = `zvol | file | foreign | unresolved` — `unresolved` = a path that resolves onto no known storage NOW (pool exported, file absent); the ANAS IQN convention is authoritative for ownership `anas`, only a backing that POSITIVELY resolves onto PVE-managed or non-ANAS storage makes a target `foreign`, and a target with no LUNs is ANAS's (a fresh target could otherwise never receive its first LUN). **Boot ordering** ships as a drop-in `/etc/systemd/system/rtslib-fb-targetctl.service.d/anas-ordering.conf` (`Wants=`/`After=zfs-volumes.target zfs-volume-wait.service`, `After=zfs-mount.service zfs-import.target local-fs.target`; `Wants=` not `Requires=` so LIO still starts without ZFS; `After=` also orders the stop, so the target goes down before pools export). Honest limit: AHR pools mount from fstab with `nofail`, which drops the mount unit's `Before=local-fs.target`, and mount units are per-pool — no static `After=` can name them; the correct mechanism is `x-systemd.before=rtslib-fb-targetctl.service` on the AHR fstab line (a migration for existing pools — candidate, not built). `targetcli-fb` + `python3-rtslib-fb` are hard dependencies installed by `install.sh` (`--install-deps`); the rtslib postinst enables and starts `rtslib-fb-targetctl` itself; `uninstall.sh` removes only the drop-in — never the packages, `saveconfig.json`, or the live tree. `DashboardWarning.category` gains `iscsi`. **Stubs (live-proof F2, `iscsi.8`):** `targetctl restore` CREATES a missing fileio backing file at the persisted size when the mountpoint directory exists — a late or failed mount therefore yields an ACTIVATED LUN serving zeros with the right serial, not a hole. Health detects a stub (size 0 against the persisted size, or the containing mount is not the file's dataset/AHR pool) as `stubLuns[]` + `degraded`, ANAS quarantines it (unmap that LUN, delete the stub backstore and 0-byte file, keep the persisted record, never `saveconfig`) so it becomes an honest `missingLuns` hole for Repair; AHR fstab lines that carry a LUN get `x-systemd.before=rtslib-fb-targetctl.service`. A wildcard portal (`0.0.0.0` / `::`) is refused at the schema with a guiding message (threat model; GT-8) — relax deliberately if ever wanted. Key decisions: **serial + attributes are replayed on every backstore recreate** (boot restore, fileio resize, image restore) — initiators, ESXi, Windows and PVE's own volids identify a LUN by the serial, and LIO drops attributes on recreate. Backstores reference `/dev/zvol/<pool>/<vol>` (the `zd*` name changes across reboots). **Boot restore reports systemd success even when a LUN is missing**, so `/v1/iscsi/health` diffs rather than trusting the unit, and ANAS never runs `saveconfig` over a degraded restore. LIO's own 10 rotating `saveconfig` copies are the config backup; every mutation is a journald audit line. `rtslib-fb-targetctl` is ordered after `zfs-volumes.target` and AHR activation via a drop-in. Cross-feature gates (Pools/Datasets/AHR/Mounts): destroy/export of a claimed zvol already fails in ZFS (`busy-diagnosis` names the LUN from configfs — `fuser`/`lsof` see nothing); **rollback, rename, volsize shrink and removal of a backing file succeed silently in ZFS and are refused by ANAS** while a LUN references the object. The disk inventory excludes `zd*` and tags iSCSI-transport disks whose serial matches a LUN served by this node.

#### Backup — PBS file backup (Epic 16; designed 2026-07-18)

Mirrors the replication API shape. Repositories live in the cluster-wide CAS-versioned registry (`/etc/pve/anas/backup-repos.json`, pmxcfs) with per-repo secrets in `/etc/anas/creds/` (0600, write-only via API — token secret or password, user's choice). Tasks ARE systemd units (`anas-backup-<name>.service`/`.timer`) — no second config source. **Status is local-only** (persistent systemd state + journald + jobs): the only PBS-server contacts are backup runs, the explicit user-initiated repository test, and — since 16.11 — the post-backup retention prune plus its user-initiated dry-run preview. Never polling, never background.

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/backup/repos` | Registered PBS repositories (secrets never returned; `credentialsSet` only) | `200` |
| `POST` | `/v1/backup/repos` | Register a repository (CAS `version`; fingerprint confirmed explicitly) | `202` with job |
| `PUT` | `/v1/backup/repos/:name` | Update / rotate credentials (CAS) | `202` with job |
| `DELETE` | `/v1/backup/repos/:name` | Unregister (refuses while tasks reference it) | `202`/`409` |
| `POST` | `/v1/backup/repos/test` | User-initiated diagnosis: dns / tcp / tls-fingerprint / auth / datastore / namespace verdicts | `200` |
| `GET` | `/v1/backup/tasks` | Task grid: schedule, enabled, last result, next run, overdue (systemd state) | `200` |
| `GET` | `/v1/backup/tasks/:name` | Detail: full config, unit/timer as written, recent journald runs (labeled recent-only) | `200` |
| `POST` | `/v1/backup/tasks` | Create task (repo ref + namespace + backup-id + archives[{name,path,excludes[]}] + mode + optional retention + notify mode + schedule *or* cadence) | `202` with job |
| `PUT` | `/v1/backup/tasks/:name` | Update / enable / disable | `202` with job |
| `DELETE` | `/v1/backup/tasks/:name` | Remove task (units removed; PBS data untouched) | `202`/`409` |
| `POST` | `/v1/backup/tasks/:name/run` | Run now (job with progress from client output) | `202` with job |
| `POST` | `/v1/backup/tasks/:name/prune-preview` | Retention DRY RUN (`prune --dry-run --output-format json`): the wizard's Preview button. User-initiated, one-shot, non-mutating; body may carry the task inline so an unsaved task previews | `200` |

**Retention (16.11) is OPTIONAL and per task** — `{keepLast?,keepDaily?,keepWeekly?,keepMonthly?,keepYearly?}` (positive ints), stored in the task's unit JSON like every other field. Absent = **ANAS never invokes prune** (PBS-side retention stays the default posture; a keep-flag-less prune is a server-side keep-all no-op we do not even run). Present: after a **successful** run the same job executes `proxmox-backup-client prune host/<backup-id> [--ns] --keep-* … --output-format json` and reports kept/removed/protected counts; a failed run and a skip never prune. **A prune failure never fails the job** — the backup data is already safe, so the job completes carrying `warnings[]` (vzdump's own posture). Prune only marks; **GC stays PBS-side** and is never surfaced or triggered. This widens the sanctioned PBS-contact list by exactly two calls (the post-backup prune, the user-initiated preview) — the never-poll rule is untouched.

The fd cap (default 1024, per-task override) binds pbc via `prlimit --nofile=N:N` around the daemon's exec — pbc hoards file handles, worst in metadata change-detection mode; the unit's `LimitNOFILE=` only bounds the thin helper (pbc runs inside anasd, not the unit cgroup — live-proof finding). Dashboard warning category `backup`: failures and silently-overdue only.

**Run notifications (16.12).** A task carries `notify: always | on-failure` in the same unit JSON, **defaulting to `always`** — vzdump's own default, and the behaviour the six cron jobs this epic replaced had (they mailed every run's full output). Absent = `always`, so no task migrates. Emission is at the daemon's run job — the ONE point every real run reaches, scheduled fire and UI Run Now alike (both arrive through the task's own unit) — and maps: success → `info` (only in `always`), completed-with-warnings → `warning` (both modes), failure → `error` (both modes), **off-week skip → nothing, in either mode** (the cadence gate produced no run, and no cron mail either). The body is the point: task, `repo:datastore / namespace`, backup-id, the per-archive stats lines pbc printed, duration, prune counts when retention ran, warnings verbatim, and the error text on a failure. Delivery is PVE's (`PVE::Notify::notify`) through ANAS-shipped `anas-backup-{subject,body}.txt.hbs` templates, with `type=anas-backup` so operators can match backup events specifically; a notification failure **never** fails the run job (the AHR posture, unchanged). No poller, no PBS contact, and no overdue push — an overdue task has no run to notify from, so overdue stays exactly where it is: the dashboard warning category.

**Task cadence (16.10).** A task may carry a structured `cadence` alongside its `schedule`: `{ kind: weekly|biweekly|monthly|custom, days[] (Mon..Sun), time (HH:MM), parity? (even|odd) }`. When present the daemon **generates** `OnCalendar=` from it (the cadence is authoritative, and the generated expression is validated with `systemd-analyze calendar` like any other); when absent the raw `schedule` stands — which is what every pre-16.10 task carries, so nothing migrates. Weekly/monthly/custom are pure OnCalendar with `Persistent=true` as their missed-run heal; **biweekly** is the one case systemd's calendar cannot express, so it runs on a WEEKLY timer and the daemon gates each SCHEDULED fire on ISO-week parity (`date +%V` semantics, parity explicit config — never derived). An off-week fire completes as a first-class **skipped** run (the runner's `SuccessExitStatus=75`: systemd records success, `ExecMainStatus` says no backup was taken); a Run Now is never gated; and an off-week fire runs anyway when the last successful run is older than one full period (the heal — at most one shortened interval, the phase never flips). Overdue is measured against the cadence's own period, so a healthy off-week skip never reads as overdue.



**Phase 2 (backup2 epic; designed 2026-08-25, ground truth `docs/BACKUP-RESTORE-GROUND-TRUTH.md`).** Restore is two types by nature — **files are selective, block images are whole**. Every call below is a user-initiated PBS contact (sanctioned; the never-poll rule is unchanged). Archives gain `kind: pxar | img` and `includeNested: none | all | [paths]` (default `none`); snapshot-consistent runs expand one archive root per nested filesystem at run time.

**Task kind (backup2.9, 2026-08-27):** `BackupTask.kind: files | block` (absent ⇒ derived from the archives); a block task has exactly ONE `img` archive named `disk`, its `backup-id` is `lun-<unit serial>` (the PBS group is the LUN's durable identity), no excludes/nested/change-detection; file archive names are derived at creation from the path's last segment and never re-derived (metadata change-detection keys on the name). **Restore elsewhere (backup2.10):** `POST /v1/backup/restore` files may target any new directory; image restore gains `target: {mode: 'newLun', targetIqn, name, backing: {kind: zvol|file, dataset|pool}}` — create the backing at the manifest size, a backstore with a NEW serial, map, stream — the source LUN untouched. **Image archives (backup2.4, built 2026-08-25):** `kind: img` archives are passed as `<name>.img:<path>` (a block device or a regular file — no loop device); `excludes` and `includeNested` are refused on `img`, an `img` archive never expands, and `--change-detection-mode` is not emitted for an img-only task (a documented no-op for images — every run reads the full image, chunk-deduped). A zvol source in snapshot mode is published with `zfs set snapdev=visible` → `udevadm settle` → bounded wait for `/dev/zvol/<pool>/<vol>@<snap>` → backed up from that read-only node → restored with `zfs inherit snapdev` (or the exact prior value when it was `local`) in a `finally`; PVE guest volumes and volumes on PVE-managed pools are `live`/never offered. An `img` archive may record `lun: {targetIqn, index}` as display + restore truth (`backup2.7`). Shared: `BackupArchive.kind`/`lun`, `BackupLunSource`, `BackupArchiveConsistency.zvolDevice`.

**Restore reads (backup2.5, built 2026-08-25):** the two listing rows and the browse row answer `200` with a `verdict` (`ok` / `not-found` / `permission` / `unreachable` / `error`) for PBS-side outcomes, reserving 4xx for local faults (unknown task/repository, no stored credential) — the prune-preview / repo-Test pattern; they submit no audit job (pure reads). `GET /v1/fs/browse` gains an opt-in `&files=1` (the `files` array is present only when asked, so every pre-flag caller is byte-identical). `BackupBrowseEntry.mtimeZone: 'node-local'` marks that `catalog shell`'s `Modify:` is the node's wall time with no zone (the picker labels the column; nothing is converted). Shared: `BackupSnapshotFileKind` (`pxar | img | other` — a snapshot's stored files) is distinct from `BackupArchiveKind` (`pxar | img` — a task's archive). The picker is `ANAS.pathPicker` (`12-picker.js`; tree + breadcrumb + type-ahead; `live` and `archive` backends; `multiSelect` option) and `ANAS.snapshotPicker`.

**Snapshot-consistent runs (backup2.3, built 2026-08-25):** consistency is **derived per archive, no override field** — a ZFS dataset (or a subdirectory of one) and an AHR pool with the `@data`/`@snapshots` layout back up from a transient snapshot; remote mounts, foreign filesystems and flat AHR pools back up live, labeled. Transient snapshots are `anas-backup-<task>-<unix>` (ZFS `-r`; AHR one per nested subvolume with a `__<subvol>` tail), taken through the ONE shared `services/zfs-snapshot.ts` helper (also used by Datasets, Schedules and Replication), destroyed in a `finally`, swept at every run start (only the task's own prefix, only older than the run), **never held**, no property changes (`.zfs/snapshot` is reachable with `snapdir=hidden`). Archive roots become `<mountpoint>/.zfs/snapshot/<s>/<relative>` or `<top-level>/@snapshots/<s>/<relative>`; child filesystems covered by `includeNested` expand into archives named `<name>__<child path with / → _>` restricted to `[A-Za-z0-9_-]`; **the root archive name and `--backup-id` are invariant between live and snapshot mode** (metadata-mode continuity, GT-proven). A non-snapshottable mount nested under a snapshot root is skipped with a warning — a snapshot contains no live mounts, so there is nothing for `--include-dev` to name; back such a mount up as its own (live) archive. `isTransientBackupSnapshot()` (shared `snapshot-naming.ts`) is honoured by replication's base discovery and lag, and by Schedules retention. The run result carries `consistency[]`, `snapshots[]`, `expansion[]` (shared `BackupArchiveConsistency`, `BackupTransientSnapshot`, `BackupExpandedArchive`); `GET /v1/backup/tasks/:name`'s `nested[]` entries carry `consistency` too.

**Source guard (backup2.11, design 2026-09-24):** the run's FIRST step, before the boundary scan, any snapshot or `proxmox-backup-client`, is the ONE configured-but-unmounted check built in rclone.2 (`services/source-guard.ts`: `/etc/fstab` through Mounts' parser + `findmnt --json` from `/proc/self/mountinfo`, so it never hangs; fail-open when either table is unreadable; only fstab-configured mounts are detectable). The facts are read once per run and every archive path — `pxar` and `img` alike — is tested; a path on a mount the system is configured to have and does not currently have FAILS THE RUN with one sentence per offending archive (`archive '<name>': <path> is on <mountpoint> (<source>), which is configured in /etc/fstab but not mounted`), all of them listed so one fix round suffices. The whole run fails, not the one archive: a backup that quietly omits an archive and reports success is the 2026-08 incident's shape (an empty mountpoint directory backed up as a good snapshot), and PBS retention would then age the last real snapshot out behind it; an operator who wants the other archives to proceed splits the task. Nothing new carries the failure: the unit's own error line is what `failureDetailFromJournal` hands the row's Last run tooltip, `anas-backup` notifies on failure as for any failed run, the dashboard shows the `backup` warning. Save time is a WARNING, not a refusal: `preview-nested` (the same fstab + mount table it already reads) gains an additive `unmounted?: UnmountedMount` (`{ mountpoint, source, fstype, disabled? }` — the ONE shared shape the guard's own facts use; `disabled` marks a `#ANAS `-disabled fstab entry, which cloud's sentence renders and backup's does not) on each scan, and the wizard's per-row alert says the run will be refused until the mount is up — the fact is time-dependent (a task may legitimately be defined during an outage, and the timer fires later), so the run is the gate, as it is for cloud. TrueNAS cross-check: its backup, replication and cloud-sync sources are datasets or paths under `/mnt`; a dataset that failed to mount presents the same empty directory and TrueNAS applies no such guard — nothing to match, ours is the stricter behaviour and stays.

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/backup/tasks/:name/snapshots` | Points in time for the task's group (`snapshot list --output-format json`; ANAS composes `<type>/<id>/<RFC3339>` — the client's JSON has no `snapshot` field and is unsorted; `files[].size` is the restore space estimate) | `200` |
| `GET` | `/v1/backup/repos/:name/groups?ns=` | Task-less entry point: groups (and their snapshots on `?group=`) in a repository/namespace — archives whose task was renamed or deleted | `200` |
| `GET` | `/v1/backup/tasks/:name` (phase 2 addition) | Task detail gains, per archive, `nested[]` `{path, relativePath, kind, included, source, fstype, detail}` — the nested filesystems currently under the source and whether `includeNested` covers each; absent (not `[]`) when the scan could not run | `200` |
| `POST` | `/v1/backup/tasks/preview-nested` | `{path}` or `{archives[]}` → the nested-filesystem scan (hang-BOUNDED, not hang-proof: `find -prune` still `lstat`s a dead mountpoint, so a dead remote mount under the source is probed first and marks the scan `truncated` with the reason — live-proof F8) the wizard shows before save, **plus the derived `consistency` per archive** (`snapshot` / `live` + reason, backend, target) — one call, one mount table (user-initiated, no PBS contact; the save-time-verify pattern) | `200` |
| `GET` | `/v1/backup/lun-sources` | Backup-eligible iSCSI LUNs **of ANAS-owned targets only** (the image restore refuses foreign targets — picker and door agree; live-proof F7) from the read layer `{targetIqn, index, name, kind, path, serial, size, backingExists, consistency?}` — `foreign` and `unresolved` backings and PVE-owned volumes are never offered; a resolvable LUN whose device is absent right now is listed with `backingExists:false` (guide, don't hide) | `200` |
| `POST` | `/v1/backup/restore/browse` | `{repo, ns, snapshot, archive, path}` → one directory level of the archive via **`catalog shell` over a pipe** (invoked as `timeout <s> proxmox-backup-client catalog shell …`, TWICE per level — `ls` prints bare names only, so a batched `stat` of every child follows; ~83 ms for 500 entries; an `img` archive short-circuits with one whole-image pseudo-entry and no PBS contact) (never FUSE: a black-holed server leaves FUSE readers in D state that `timeout` cannot kill and `stat -f` calls the mount healthy). Hardlink groups are returned as one unit (the `stat` target form is ARCHIVE-ROOT-RELATIVE in every position — live-proof F6/E, supersedes the earlier sibling reading) | `200` |
| `POST` | `/v1/backup/restore` | Files: `{…, task?, selections[], target: {mode: inPlace\|newLocation, path?}, options: {ignoreOwnership, ignoreAcls, ignoreXattrs, ignorePermissions}, rate?}` — **ruling 2026-08-29: the beside-the-original mode is dropped — the destination is named by the operator, never invented** (`target` is required; a restore without one is refused at the boundary). `inPlace` = the archive's live HOME (the caller's `path`, else `task`'s archive of this name) — a MERGE, never a sync; an in-place TREE → `409` confirm, a single picked file is the checkbox's consent. `newLocation` = the operator's directory, `path` required: missing → created by the client (parents included, no flags — GT-15); an EXISTING directory → `409` + `X-Anas-Confirm-Code` and, on confirm, the SAME merge flags — never a silent merge; an existing non-directory is a plain 400. A pre-flight `catalog shell` batched `stat` over the selection yields hardlink partners (completed automatically), directory detection (the gate trigger) and sizes (space check = exact sum when no directory is picked, else `files[].size` as a stated upper bound); protected targets via `heldByLun()` + PVE territory; write test; after the client exits, `find -P <paths> -maxdepth 0` verifies every selection and a miss is completed-with-warnings; a killed/failed restore that CREATED its own directory carries a `.anas-restore-partial` marker (ours, not system state) whose `reason:` is the client's `Error:` line, else `killed (signal N)` / `exit N` — never a progress line — or is removed when empty; a MERGED-INTO directory (in-place, or a confirmed newLocation) is never labelled and never touched (`ExecResult.signal` carries a signal death; the executor used to collapse it to exit 1) → `restore --pattern` per selection (`/`-anchored, `\ * ? [ ]` escaped; hardlink groups together), `--allow-existing-dirs --overwrite` exactly when the target pre-existed (`inPlace` always, `newLocation` only after its confirm — the MERGE pair, GT-11); the job verifies the restored set against the catalog (a no-match pattern is a silent client success). Image: `{…, kind: image, lun}` → **the whole TARGET (its TPG) goes offline for the duration — LIO has no per-LUN enable; other LUNs on the target go with it and the confirm text says how many**; entry gate = a hard 409 on live sessions (disable alone does not stop an established session; the disable is what stops open-iscsi/Windows auto-reconnect landing mid-write — the pair is the safety property) + the confirm-code gate; manifest size must EQUAL the target size (the client writes until ENOSPC otherwise; both numbers in the refusal); image streamed via `restore … -` into a fd ANAS opens (`O_WRONLY` on a device, `w` on the same file path — inode kept, no backstore recreate) and `fsync`ed; serial + attributes read back unchanged; target re-enabled in a `finally` — EXCEPT after a mid-stream failure, where the half-written LUN stays disabled and an explicit `POST …/state {enable}` is the operator's acknowledgement. `map` + `dd` is the documented hands-on alternative, not a second code path | `202`/`409` with job |

#### Cloud sync — rclone (rclone.1–3; designed 2026-09-23, GitHub #57)

One-way `copy` or `sync` of a local path (a dataset mountpoint, a share path, any directory) to an rclone remote, on the schedule-unit pattern, with a job and a notification per run. rclone is used as it is: every backend it supports works, there is no cloud-vendor code in ANAS, and copying data back is the operator's own `rclone copy` on the node. Not built: two-way sync, a restore UI, retention or versioning on the remote (`--backup-dir`).

**Ground truth 2026-09-23 (stunt node, PVE 9.2.20 / Debian 13.7):** Debian trixie ships **rclone 1.60.1** (2022) as `rclone`, a Go binary with no dependencies, and that is the version ANAS is built against — a newer upstream `.deb` replaces the same `/usr/bin/rclone` and every interface used here predates 1.60 (`config providers`, `config dump`, `obscure -`, `lsjson`, `about --json`, `sync`/`copy` with `--use-json-log`). Facts that shaped the design: `rclone rc --loopback` gives every config verb as JSON, but the input can only arrive as an argv string (`--json -` and a piped stdin both fail), so a secret written through rclone's own verbs would ride argv — which the iSCSI ruling forbids; `rclone obscure -` reads the password from stdin; rclone's own rewrite of `rclone.conf` preserves comments and unusual values verbatim (`# anas:…` survived a `config/update`); `config/paths` does not exist in 1.60 (the human `rclone config paths` names `/root/.config/rclone/rclone.conf` for root); the anasd unit runs with **no `HOME`** in its environment, so rclone's default config resolution is undefined under the daemon and the path must be passed explicitly; passwords land in the file obscured (reversible, rclone's own model), while an S3 `secret_access_key` is stored plain because rclone 1.60 does not type it as a password; a `drive` remote created `nonInteractive` answers with a `State` question (`config_is_local`) instead of a remote — OAuth backends need a token from a browser machine; exit codes: `0` ok, `3` source or destination directory missing, `7` fatal (`--max-delete` reached), **`1` for every `NewFs` failure — unreachable, authentication and unknown-remote all exit 1**, so a verdict comes from the message, not the code; `--use-json-log` emits one object per event and a `stats` object at every `--stats` interval with `bytes`, `totalBytes`, `transfers`, `checks`, `deletes`, `errors`, `eta`, `speed`, `fatalError`; a `sync` from an empty source deletes the whole destination (dry run showed 4 files + 1 directory), which is the failure to guard.

**Remotes = ANAS's own `rclone.conf`.** ANAS keeps its remotes in **`/etc/anas/rclone.conf`** (mode 0600 root, beside the mount credentials; created when absent), passed on every invocation as `--config /etc/anas/rclone.conf --ask-password=false`. Root's own `~/.config/rclone/rclone.conf` is never read or written — **ruled 2026-09-23 (operator): a file root edits independently is not a store ANAS controls**; the operator's rclone habits stay theirs and ANAS's remotes are ANAS's. Per node, never pmxcfs (secrets, like mount credentials). A copy-back on the node therefore names the file: `rclone --config /etc/anas/rclone.conf copy <remote>:<path> <directory>`. A password-protected configuration is reported as a fact on the Remotes screen and refuses every mutation (`409 config-encrypted`) — ANAS neither prompts nor stores the passphrase. **Reads** go through `rclone config dump` (JSON): a remote is `{name, type, options: {non-secret key → value}, secretsSet: [keys]}` — a secret value is never returned. A key is a secret when the provider schema flags it `IsPassword`, or when its name ends in `pass`, `password`, `secret`, `token` or `key` (b2 `key`, s3 `secret_access_key`, `client_secret`, `token`, `sse_customer_key`; `access_key_id` and `key_file` are not) — and never when the option is a `bool` (`sftp.ask_password` matches the suffix but is a switch, not a credential) — rclone 1.60 has no `Sensitive` flag, so this generic name rule stands in for it. **Writes are ANAS's own surgical INI edit** of the section (add / replace / remove; every other byte of the file untouched, comments included), write-temp-then-rename 0600 under the per-file lock, then a gate — `rclone config dump` must parse the file and list the section — with a byte-identical rollback when it does not (the `testparm` pattern). Password-typed values are obscured through `rclone obscure -` on stdin; **no secret ever enters an argv** (the `iscsi-mutate.ts` argv guard is reused as the executor-side backstop). Type is immutable after creation (rclone's own posture; a retype is a new remote). Delete is a hard `409` while a task references the remote. **Test** (`POST /v1/cloud/remotes/test`) is the mounts / repo-Test shape: `timeout`-bounded `rclone lsjson <remote>:<path> --max-depth 1 --contimeout 10s --timeout 30s --retries 1 --low-level-retries 1` → `ok` / `unreachable` (`i/o timeout`, `connection refused`, `no such host`) / `auth` (`unable to authenticate`, `handshake failed`, `401`, `403`, `AccessDenied`, `InvalidAccessKeyId`, `SignatureDoesNotMatch`) / `not-found` (exit 3) / `error` with rclone's last line verbatim — the classifier is a heuristic over backend-specific text and `error` is the honest fallback. A Test of an UNSAVED dialog is served through an environment-defined remote (`RCLONE_CONFIG_ANASTEST_<KEY>`, obscured where the file would be) so nothing is written before the user saves — **GT 2026-09-23 on 1.60.1: works, and the password MUST be obscured on the environment too** (rclone reveals every `IsPassword` field wherever it reads it; a plain value fails with "input too short when revealing password"). **GT 2026-09-24: rclone WRITES its config file on its own** — the sftp backend persists `shell_type`, `md5sum_command`, `sha1sum_command` on first connect (appended to a saved remote's section; a NEW `[anastest]` section for an env-defined one, and it creates the file when absent); other sections and comments survive. Rule: an unsaved-dialog probe runs against a private 0600 temp COPY of the file (`/run/anas/rclone-probe-*/`, removed in a `finally`) so nothing of the dialog ever lands in ANAS's file; a saved-remote probe or run uses the real file and rclone's appended keys are ordinary foreign keys — kept by the INI writer, listed under `options`, never a defect. **Providers** (`GET /v1/cloud/providers`) is `rclone config providers` (396 KB, 46 backends) trimmed per option to `name, help, type, required, secret, default, examples[], provider (the `Provider` filter, `AWS,Alibaba` or `!AWS`), advanced` — the metadata the dialog renders from; read per request, not cached.

**Tasks = systemd units, `anas-cloud-<name>.service` / `.timer`,** the fifth unit store on the ONE helper module (`systemd-unit-store.ts`; `X-ANAS-Task=` marker, `Persistent=true`, never adopt a unit without the marker). `CloudSyncTask = { name, source (absolute path), remote (name), path (remote-side, may be empty), mode: copy | sync (default copy), excludes[], bwlimit? (rclone syntax, e.g. `8M`), notify (default always — the task is the operator's offsite copy, backup parity), schedule, cadence?, enabled }`. `cadence` reuses the backup cadence schema and generator (renamed `TaskCadence` with `BackupCadence` kept as an alias; biweekly parity gate, `SuccessExitStatus=75` skip, cadence-aware overdue — all as backup). The runner `dist/cloud-task.js` is the backup runner's twin (POST `…/run` with `direct:true`, poll, exit truthfully); Run Now starts the unit and supervises it, so scheduled and manual runs share one history. **Extraction, not a copy:** status derivation, journald reads, the parity gate and unit supervision in `backup-units.ts` are generic in everything but the unit prefix — they move to a prefix-parameterised shared module that backup and cloud both import, with backup's tests kept green. **The run job:** (1) source guard — the path must exist, and a path on a configured-but-unmounted mount is refused with the mount named (this is the backup2.11 guard; it is built here as ONE shared helper and backup2.11 wires it into backup); (2) `sync` with an EMPTY source directory is refused: "an empty source in sync mode would delete everything at the destination" — the catastrophic shape, guarded up front; `copy` never deletes and has no such guard. Implications, stated in the dialog: a `copy` task accumulates at the destination — a file deleted or renamed on the source stays (or exists twice) at the remote until the operator cleans up; a `sync` task mirrors the source exactly, deletions included; a source the user emptied ON PURPOSE is refused in sync mode until the remote is emptied by hand (`rclone --config … purge`), the price of the guard; a half-missing source is not a guard case — sync does what it says. A guard fires at a scheduled run as well as at Run now: the run FAILS with the sentence, notifies and shows on the dashboard — never a silent skip. Only fstab-configured mounts are detectable as unmounted; an absent path is refused by the existence check, and an empty mountpoint directory in copy mode is a harmless no-op; (3) consistency is derived per source exactly as backup derives it (ZFS dataset or a directory in one, AHR pool with the `@data`/`@snapshots` layout → a transient snapshot `anas-cloud-<task>-<unix>` through the shared snapshot helper, destroyed in a `finally`, swept at run start; remote mounts, foreign filesystems, flat AHR → live, labeled); the rclone source becomes the snapshot path; nested filesystems under the source are NOT included (a snapshot does not contain them) — the dialog says so before save, from the existing `preview-nested` scan; (4) `rclone <mode> <src> <remote>:<path> --config … --ask-password=false --use-json-log --stats 30s --stats-log-level NOTICE [--bwlimit] [--exclude …]` under the daemon's executor (`execFile`, no shell); each `stats` object updates the job's progress (bytes / total, files, checks, deletes, errors, ETA); the final `stats` object is the result. **Exit-code policy:** `0` and `9` (nothing to transfer) complete; everything else — including `6`, "less serious errors", which means files are missing at the destination — fails, with rclone's error lines in the job and the notification. `--max-delete` is not set: the empty-source guard covers the catastrophe and a partial ceiling is a policy knob with no honest default. Notifications through `pve-notify.ts` with `anas-cloud-{subject,body}.txt.hbs` (`type=anas-cloud`): task, `source → remote:path`, mode, live/snapshot label, transferred bytes and files, checks, deletes, errors, duration, the error lines on failure; skips never notify; delivery never fails the run. Dashboard warning category `cloud`: failures and silently-overdue, pull only.

**Workflow (equal weight — §2 rule).** *Where it lives:* one new menu, **Cloud Sync**, after Backup, built as Backup is: the Tasks grid with the toolbar (Create, Edit, Remove, Run now, Enable/Disable, Remotes…) and the **Remotes** manager window behind the Remotes… button — the Repositories manager's twin. Nothing in the Backup menu changes. *Remotes, happy path:* Remotes… → the grid lists every remote in the file (name, type, `set` keys) with the file path and rclone's version in the footer → Add → Name, Type (46 entries, description shown) → the fields render from the provider schema: basic options first, filtered by the chosen `provider` where the backend has one (S3's `region` and `endpoint` rows appear once, for the provider picked), examples as an editable combo, bool as a checkbox, secrets as password fields, a "Show advanced options" toggle for the rest; a backend with a `token` option shows the one sentence *"This backend authorises through a browser. On a machine with one, run `rclone authorize "<type>"` and paste its output into the token field."* → Test (verdict sentence in the dialog) → Save → job → the grid reloads on success and on failure. Edit shows non-secret values; a secret field is blank and reads "(unchanged)"; typing replaces it. Remove of a referenced remote is refused with the task names. The window footer carries the copy-back sentence: *"To copy data back, run on this node: `rclone --config /etc/anas/rclone.conf copy <remote>:<path> <directory>`."* *Tasks, happy path:* Create → Name → Source (the `ANAS.pathPicker`, live backend; PVE-owned paths refused as everywhere) → the consistency line ("backed up from a snapshot" / "live copy — <reason>") and, when the scan finds them, *"Contains N nested filesystems that will not be included: …"* → Remote (combo of saved remotes; empty ⇒ the guiding "Add a remote first (Remotes…)" toast, the backup precedent) + Path on the remote → Mode: `Copy` (default) / `Sync` with the one sentence under it: *"Sync deletes files at the destination that are no longer in the source. Copy never deletes."* → **Preview** (the dry run: "would transfer N files / M bytes, delete K files at the destination" and the first deletes listed; on `sync` a preview that would delete everything says so in red) → Excludes → Bandwidth limit (optional) → Schedule (the backup cadence widget, reused) → Notify → Save → job → the grid reloads on success and on failure with the new row selected. Run now → the job appears on the dashboard strip with rclone's progress (bytes of total, files, ETA); the row's Last run refreshes when the job ends, success or failure. Detail window: config, consistency, `source → remote:path`, the unit and timer as written, recent runs from journald (labeled recent-only; "history is not retained while disabled"). *Timeliness:* the grid derives everything from unit + timer state per load (no shadow state); it reloads after every job of its own, success AND failure; a run started by the timer shows on the next load or the dashboard pull — a stale Last run after a job the user did not start is not a defect, a stale one after a job they did is. *Failure as the user meets it:* refusals are `400`/`409` sentences that name the thing — the unmounted mount, the empty source in sync mode, the encrypted configuration, the remote's referencing tasks — shown in the dialog with the field or in the toast, never a bare "failed"; a failed run is a red Last run cell whose tooltip is rclone's last error line, the same line the notification carries, and the recovery verb (Run now, Edit, Remotes…) is on the same toolbar. *Proof:* the stunt node's own `sshd` is the real remote (`sftp` to `127.0.0.1`, password auth) — Playwright over the Remotes window (add with password → the file holds an obscured value and the API never returns it; Test `ok`, `auth` with a wrong password, `unreachable` against 192.0.2.1, `not-found`; edit keeps the secret; remove refused while referenced) and over the Tasks grid (create with the nested note, copy run → files present on the remote path, sync run → a deleted source file disappears at the destination, empty-source sync refused, unmounted-mount source refused, a failed run's cell + notification, reload after an injected failure); the run's `journalctl` shows the JSON stats and the unit's own result.

**Simplicity check (operator rule, 2026-09-22).** No picker for the config path (one file, ANAS's own). No second store — the INI writer exists only because rclone's verbs would put secrets on argv; the file stays rclone's and rclone reads it back as the gate. The provider-schema form is the one piece of mechanism, and it is what keeps "any backend rclone supports" true without vendor code; a curated subset would BE vendor code. No `--max-delete`, no retention, no two-way, no rate schedule. (A dry-run preview was cut here and reinstated 2026-09-24 by the operator: once sync's only protection is the empty-source guard, letting the user see the deletes before they save is the cheapest safety there is.) OAuth is rclone's documented headless flow, not an ANAS browser dance. The secret name rule is a heuristic and is stated as one.

**Honest limits.** rclone 1.60.1 is a 2022 release; backends added or changed since (new S3 providers, Proton, etc.) are absent until the operator installs a newer rclone, which ANAS uses unchanged. **No supported newer path exists (checked 2026-09-23):** Debian has no `trixie-backports` rclone (only sid carries 1.69.3), and upstream ships a bare `.deb` with no signed apt repository — so a newer rclone is the operator's manual install and manual updates, never something `install.sh` does. Obscured is not encrypted — the file's protection is its 0600 mode, rclone's own posture. A token refresh rclone writes into the file during a run can lose to a simultaneous remote edit in ANAS (whole-file rewrite vs. surgical edit); the next run refreshes again from the same refresh token, so nothing is lost but one write. The Test verdict classifier reads backend text; an unrecognised failure is `error` with the text, never a wrong bucket.

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/cloud/providers` | rclone's backend catalogue, trimmed per option to what the dialog renders (`name, help, type, required, secret, default, examples[], provider, advanced`) | `200` |
| `GET` | `/v1/cloud/remotes` | `{ rclone: {version, configFile, encrypted}, remotes: [{name, type, options, secretsSet[]}] }` — secret values never returned | `200` |
| `POST` | `/v1/cloud/remotes` | Add a remote: `{name, type, options{}}`; secrets obscured via stdin, INI section written surgically, `config dump` gate, byte-identical rollback | `202` with job / `409 config-encrypted` |
| `PUT` | `/v1/cloud/remotes/:name` | Update options; an absent secret key = unchanged, an empty non-secret value = key removed; type immutable | `202` with job |
| `DELETE` | `/v1/cloud/remotes/:name` | Remove the section; hard `409` naming the tasks that reference it | `202` / `409` |
| `POST` | `/v1/cloud/remotes/test` | `{name}` or `{remote inline}` + `path?` → `{verdict: ok\|unreachable\|auth\|not-found\|error, message}`; bounded `lsjson --max-depth 1`; no job (pure read) | `200` |
| `GET` | `/v1/cloud/tasks` | Task grid: source, `remote:path`, mode, schedule, enabled, last result, next run, overdue (systemd state) | `200` |
| `GET` | `/v1/cloud/tasks/:name` | Detail: config, derived consistency, nested filesystems not included, unit/timer as written, recent journald runs | `200` |
| `POST` | `/v1/cloud/tasks` | Create (`CloudSyncTask`; remote must exist; schedule or cadence validated with `systemd-analyze calendar`) | `202` with job |
| `PUT` | `/v1/cloud/tasks/:name` | Update / enable / disable | `202` with job |
| `DELETE` | `/v1/cloud/tasks/:name` | Remove the units; nothing on the remote is touched | `202` |
| `POST` | `/v1/cloud/tasks/:name/run` | Run now (`direct` = the unit's own execution); guards → snapshot → rclone with JSON progress → classification → notification | `202` with job / `400`/`409` guard |
| `POST` | `/v1/cloud/tasks/preview` | **Dry run (added 2026-09-24).** Body = the task inline (the wizard's unsaved form) or `{name}`. Runs `rclone <mode> --dry-run --use-json-log` against the LIVE source (no snapshot — a preview is a look, not a run), bounded by a 120 s ceiling; answers `{ transfers, bytes, checks, deletes, deletedFiles[] (first 200 + total), errors, truncated }`. The unmounted-mount guard refuses (nothing to look at); the empty-source guard does NOT — showing that a sync would delete everything is the point. A user-initiated read: no job, no notification, rclone writes nothing under `--dry-run` (GT 2026-09-23: every would-be delete is a `skipped: delete` object) | `200` / `400` |

#### Filesystem browse (read-only UI support; designed 2026-07-20)

One generic endpoint backing directory pickers and gentle path validation across features (backup archive paths first; Epic 17 targets and share-create later). Read-only, absolute paths only, never follows into anything mutable — it lists, it never touches.

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/fs/browse?path=<abs>` | `{ path, exists, type: dir\|file\|other\|missing, dirs: [child dir names] }` — dirs listed only when type=dir | `200` |

#### Users & Groups (filtered to relevant accounts)

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/users` | List users (UID >= UID_MIN, no service accounts) | `200` |
| `POST` | `/v1/users` | Create a user | `202` with job |
| `GET` | `/v1/users/:uid` | User detail | `200` |
| `PUT` | `/v1/users/:uid` | Modify a user | `202` with job |
| `PUT` | `/v1/users/:uid/smbpassword` | Set/update SMB password | `202` with job |
| `DELETE` | `/v1/identity/users/:name` | Remove a LOCAL share user (confirm-gated; a hard `409` when a share/ACL references it, or when it is directory-provided) — `userdel` without `-r`: its files keep their uid; the SMB passdb entry is removed if present | `202`/`409` with job |
| `GET` | `/v1/groups` | List groups | `200` |
| `POST` | `/v1/groups` | Create a group | `202` with job |
| `GET` | `/v1/groups/:gid` | Group detail | `200` |
| `PUT` | `/v1/groups/:gid` | Modify a group (members) | `202` with job |
| `DELETE` | `/v1/identity/groups/:name` | Remove a LOCAL group (confirm-gated; hard `409`s: `primary-group-in-use` when it is a local user's primary group, and `referenced-by-share` when a share/ACL names it) | `202`/`409` with job |

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

**Executor primitives:** `exec` (argv, captured output), `pipeline`, and — since backup2.7 — `execToStream` (spawn with stdout written to a caller-owned fd, `fsync` on finish): the PBS client refuses every existing restore target, so a block image can only be restored by streaming its stdout into a device the daemon opened itself.

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

Both go through the same REST API and job queue. The distinction is in how the **gateway** and **UI panels** handle them:

- **Fast reads** (GET requests): anasd responds synchronously. No job created. The gateway returns the result directly to the browser.
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
| `zpool.trim` | `zpool trim <name>` / `zpool trim -c <name>` (cancel) — Epic 4.12 |
| `zpool.upgrade` | `zpool upgrade <name>` (enable feature flags; one-way) — Epic 4.12 |
| `zpool.set` | `zpool set <prop>=<val> <name>` |
| `zpool.add` | `zpool add <name> <vdev-spec...>` |
| `zpool.remove` | `zpool remove <name> <vdev>` (cache/log/spare only — story vdevs.2) |
| `zpool.attach` | `zpool attach <name> <device> <new-device>` |
| `zpool.replace` | `zpool replace <name> <old-device> <new-device>` |
| `zpool.import` | `zpool import [opts]` |
| `zpool.export` | `zpool export <name>` |
| `zpool.import-unit` | `systemctl enable\|disable zfs-import@<escaped-pool>.service` (boot-import; side effect of create/import/destroy) |
| `disk.wipe` | `wipefs -a --force <device>` (optional cleanup after pool destroy) |
| `zfs.list` | `zfs list -j -t all` (JSON — Principle 13, matches the pool parsers; ZFS 2.3+) |
| `zfs.create` | `zfs create [opts] <dataset>` |
| `zfs.destroy` | `zfs destroy <dataset>` |
| `zfs.set` | `zfs set <prop>=<val> <dataset>` |
| `zfs.get` | `zfs get -j <props> <dataset>` (JSON) |
| `zfs.snapshot` | `zfs snapshot <dataset>@<name>` |
| `zfs.rollback` | `zfs rollback <snapshot>` |
| `zfs.clone` | `zfs clone <snapshot> <target-dataset>` — Epic 5.7 |

> **Boot import (issue #22):** `/etc/zfs/zpool.cache` alone is not a reliable boot import on PVE — a pool can simply be missing after a reboot. Creating or importing a pool therefore also enables its `zfs-import@<pool>.service`, and destroying one disables it, exactly as PVE does in `PVE/API2/Disks/ZFS.pm` (their fix for Proxmox bug #2554). The instance name is systemd-escaped in-process (no `systemd-escape` shell-out). It is a **side effect of the mutation**, not an API call, and best-effort: the pool operation has already succeeded, so a `systemctl` failure is reported as a job warning rather than failing the job.

> **Associated shares (Epic 4.4):** a dataset's detail lists SMB/NFS shares serving its mountpoint by matching the mountpoint against `smb.conf` share paths and `/etc/exports` paths (read-only; reuses the share parsers). The same lookup feeds the destroy-confirmation warnings.

### Filesystem permissions (dataset mountpoints — Epic 4.7, POSIX MVP)
| Operation | Command |
|-----------|---------|
| `fs.chown` | `chown <owner>[:<group>] <mountpoint>` |
| `fs.chmod` | `chmod <mode> <mountpoint>` |
| `identity.users` | `getent passwd` (owner/group pickers — via nsswitch, NOT /etc/passwd; source-agnostic) |
| `identity.groups` | `getent group` |

### Layered access / ACLs (dataset mountpoints — Epic 4.7.2, POSIX ACLs)

The base three principals (owner / owning-group / everyone) are **mode bits** (`chown`/`chmod`); extra named principals are **POSIX ACL entries**. A named entry requires the `acl` package (feature-detected — if `setfacl` is absent, the base editor still works and named grants are disabled with an "install acl" hint) AND `acltype=posixacl` on the dataset (auto-enabled on first named grant, with a notice). Granting a principal also writes a matching **default ACL** (+ setgid on the dir) so new files inherit; `applyToExisting` recurses. Level → perms: none=`---`, read=`r-x`/`X`, read-write=`rwx`. Mask is managed so the reported group level stays truthful.

**Destruction is explicit, never inferred.** A `SetAccessRequest` whose `entries` list carries no named user/group row means "I am not changing the named grants" — the daemon preserves them (restating them in the declarative `setfacl --set`, which is also the only correct way to move the base levels on an ACL'd directory: a plain `chmod` writes the ACL *mask*, not `group::`). Named entries are removed only for `clearNamed: true`, which may not be combined with named entries. This is the contract for any list-valued field whose emptiness would destroy data: a client that failed to pre-fill itself produces the same empty list as a deliberate one, so absence can never carry intent. Likewise, when `acltype` is `posixacl` but `getfacl` cannot be read, `GET .../access` reports `aclEnabled: false` with `aclDegraded: true` rather than presenting mode-bit guesses as a healthy ACL.

| Operation | Command |
|-----------|---------|
| `fs.acl.get` | `getfacl -pcE <mountpoint>` (and `getfacl` on a probe for feature-detect) |
| `fs.acl.set` | `setfacl [-R] -m <spec>[,…] <mountpoint>` (access + `-d` default entries) |
| `fs.acl.clear` | `setfacl [-R] -b -k <mountpoint>` (remove access + default ACLs) — **explicit `clearNamed: true` only** |
| `fs.acltype.enable` | `zfs set acltype=posixacl xattr=sa <dataset>` (first named grant only) |
| `fs.acltype.get` | `zfs get -Hp -o value acltype <dataset>` |

### SMB Operations
| Operation | Command |
|-----------|---------|
| `smb.config.get` | Read smb.conf (or `net conf list`) |
| `smb.config.set` | Write smb.conf section |
| `smb.share.add` | Add share to smb.conf |
| `smb.share.remove` | Remove share from smb.conf |
| `smb.service.restart` | `systemctl restart smbd` |
| `smb.status` | `smbstatus` |

**Self-service on SMB shares (smbsvc.1–3, designed 2026-09-22, trimmed after the operator's review — GitHub #62 + shelved Time Machine / Previous Versions).** Three per-share features, each a checkbox in the SMB share dialog, each pure surgical `smb.conf` wiring of Samba VFS modules the node already ships (`shadow_copy2.so`, `recycle.so`, `fruit.so`, `catia.so`, `streams_xattr.so` — Samba 4.22.11 on PVE 9). One composer emits the `vfs objects` line from the set of enabled features; the feature keys become managed parameters in `parsers/smb-conf.ts` next to the existing ones, so an untouched edit still rewrites byte-identically (§2 dialog↔daemon contract). **Ground truth 2026-09-22 (stunt node, Samba 4.22.11, ZFS dataset with `anas-daily-…`, `anas-hourly-…`, a manual and a `pre_GMT…` snapshot, `smbclient` as the client):** the full stack `vfs objects = catia fruit streams_xattr shadow_copy2 recycle` works — Previous Versions enumerates exactly the scheduled snapshot, a file reads back through the `@GMT-…` path, deletes land in the bin; **`shadow:snapprefix` is broken on 4.22** (every shape, including the man page's own `pre` + `_GMT` example, answers `NT_STATUS_INVALID_NETWORK_RESPONSE` on enumeration and `NT_STATUS_NO_MEMORY` on the path) — so a share exposes ONE snapshot bucket through a fixed `shadow:format`. `vfs_recycle` with `keeptree` + `versions` keeps the tree and `Copy #n of` duplicates, the bin is visible to the client at the share root, and a recycled file's **ctime is the deletion time** (the rename sets it; users cannot forge it), which is what the purge keys on. **Design rule applied throughout (operator, 2026-09-22): the simplest mechanism that gives the user the outcome — no pickers for things ANAS can decide, no lifecycles for things that can simply stay, no second store beside `smb.conf`.**

- **Previous Versions (`smbsvc.1`).** `vfs_shadow_copy2`. ANAS itself picks the finest snapshot schedule bucket on the share's dataset (hourly before daily before weekly…) and writes `shadow:format = anas-<bucket>-%Y-%m-%dT%H%M%SZ`, `shadow:localtime = no`, `shadow:sort = desc`; the dialog and detail show which bucket, read-only. Manual snapshots, replication bases and `anas-backup-*` transients never appear. No schedule on the dataset is NOT a refusal: the feature enables with `daily` as the format and the dialog says Previous Versions stays empty until a schedule on this dataset runs, naming the Snapshots menu. *ZFS:* `shadow:snapdir = .zfs/snapshot` (relative) + `shadow:snapdirseverywhere = yes`, so a share rooted below the dataset root resolves at the dataset's own `.zfs`; child datasets are separate mounts and the walk stops there. *AHR (visible divergence):* snapshots live in the `@snapshots` subvolume, mounted only transiently today — enabling the feature on a pool adds ONE read-only fstab mount `subvol=@snapshots,ro,nofail` at `/mnt/anas-ahr-snapshots/<pool>` (a sibling of the pool's mount base, never inside the data tree) and `shadow:snapdir` is that absolute path; **the mount stays** (harmless, read-only) — no enable/disable counting. A flat-layout AHR pool (`subvolLayout: false`) or a share on a path that is neither a ZFS dataset nor an AHR pool cannot enable it — the dialog greys the row with the reason, the daemon refuses 400.
- **Recycle bin (`smbsvc.2`, GitHub #62).** `vfs_recycle` with `recycle:repository = #recycle` (the name users know; visible at the share root — a hidden dot-directory would defeat self-service), `recycle:keeptree = yes`, `recycle:versions = yes`, `recycle:touch = yes`; the bin lives on the share's own filesystem (no cross-filesystem copies, counts against the same quota). **Purge policy** = age since deletion, per share: 7 / 14 / 30 / 90 days or never, default 30, stored IN the share's stanza as an ANAS marker comment `# anas:recycle-purge-days = 30` (the fstab `#ANAS` marker pattern — the config file stays the one store; the parser preserves it verbatim and ANAS rewrites only that line). Mechanism per §2 "never build a scheduler": ONE static daily timer `anas-recycle.timer` + runner installed by the package (`install.sh`, removed by `uninstall.sh`) — nothing is created or removed per share; the runner scans `smb.conf` for stanzas carrying both `recycle:repository` and the marker, runs `find <path>/#recycle -type f -ctime +<days> -delete`, prunes empty directories, logs per-share counts to journald, and does nothing for shares without a marker or with `never`. Turning the feature OFF leaves the existing `#recycle` directory in place (a checkbox never deletes data) and the dialog says so. **Users empty their own bin (GT 2026-09-22):** deleting a file inside `#recycle` is a real delete (the module recognises its repository — no loop, no nested bin), deleting the `#recycle` folder empties the bin, and Samba recreates it on the next delete; the dialog states this in one sentence. No admin "empty now" verb, no bin size cap (the module has none — only a per-file bypass, which is another knob to explain), no per-user bins.
- **Time Machine target (`smbsvc.3`) — BETA.** `vfs objects` gains `catia fruit streams_xattr` (this order; Samba requires `streams_xattr` with `fruit`), `fruit:time machine = yes` (Samba then forces `durable handles`, `kernel oplocks = no`, `kernel share modes = no`, `posix locking = no` for the share — ANAS writes nothing extra) and the **required** `fruit:time machine max size = <cap>`: Time Machine expands to fill what it sees, and per the man page the cap counts only sparsebundle contents, so the dialog states that the share must be dedicated to Time Machine. Quota = the fruit cap on BOTH stacks (uniform; on AHR it is the only mechanism), suggested value = half the dataset's available space; one line says a ZFS quota on the dataset is the hard limit and is set in Datasets. **No avahi**: the dialog states the destination is selected by mounting the share in Finder or with `tmutil setdestination`. **Beta status is explicit** (dialog row label "Time Machine target (beta)", detail, release notes): the server side is configured exactly per the Samba documentation and proven with `testparm`, but no current macOS is on the test bench — the client side is community-verified, and the release notes ask for reports.
- **`vfs objects` ownership.** Order when stacked: `catia fruit streams_xattr shadow_copy2 recycle` (ground-truthed). ANAS owns the line while any feature is on. A share that already carries a user-verbatim `vfs objects` line cannot enable a feature: the dialog greys the rows with "this share has a custom `vfs objects` line — remove it first" and the daemon refuses 400 (no merging). When the last feature is turned off the line is removed. The feature keys (`shadow:*`, `recycle:*`, `fruit:time machine*`) are managed; anything else stays verbatim passthrough.
- **Workflow (equal weight).** *Where it lives:* the Shares menu, SMB share dialog, a "Self-service" fieldset with three rows; the detail window shows the effective settings (bucket, purge age, cap). No grid column. *Happy path:* Edit share → tick Previous Versions → the row shows "exposes the daily schedule's snapshots" (or the empty-until-a-schedule-runs note) → OK → job → grid reloads, detail shows the format written. Recycle: tick + purge age combo. Time Machine (beta): tick + cap prefilled with the suggestion + the dedicated-share and Finder/`tmutil` sentences. *Timeliness:* the grid reloads after every job, success and failure; the bucket is read live when the dialog opens. *Failure as the user meets it:* rows greyed with the reason (flat AHR pool, non-snapshot path, custom `vfs objects` line); daemon refusals (400) name the share and the reason; `testparm` runs after every write and a failing config is rolled back byte-identically with the daemon's sentence in the toast (the existing reload-as-side-effect path). *Proof:* live on the stunt node with `smbclient`: enumeration lists exactly the bucket's snapshots, `get @GMT-…/file` reads the old content, `del` lands in `#recycle` with the tree kept, the purge runner deletes only files older than the age, `testparm -s` shows the Time Machine keys as written (Samba's enforced settings are connect-time module behaviour and do not appear in the config dump — GT 2026-09-23); the AHR variant on a loop AHR pool with the `@snapshots` mount; Playwright over the dialog (rows, greyed reasons, cap prefill, reload after an injected failure).

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

### Identity — share users & groups (Epic 8)

Users/groups are read **only** via `getent`/nsswitch (source-agnostic — local, LDAP, AD all surface the same; NEVER parse `/etc/passwd`). ANAS creates only **share** identities: no login shell, no Unix password, and no user-private group (`useradd -N -M -s /usr/sbin/nologin`) — they exist to own files (uid/gid → NFS) and optionally hold an SMB password (Samba passdb). They cannot log into the box or PVE. Directory-provided users are read-only here (provisioned in AD/LDAP — Epic 14). All mutations are jobs.

| Operation | Command |
|-----------|---------|
| `identity.users` | `getent passwd` (pickers + list; filtered to real accounts) |
| `identity.groups` | `getent group` |
| `identity.user.local` | `getent -s files passwd <name>` (manageable vs directory) |
| `identity.smb.list` | `pdbedit -L` (which users have an SMB passdb entry) |
| `identity.user.add` | `useradd -N -M -s /usr/sbin/nologin [-c <gecos>] [-G <groups>] <name>` (`-N`: no user-private group) |
| `identity.user.disable` | `usermod --lock --expiredate 1 <name>` + `smbpasswd -d <name>` |
| `identity.user.enable` | `usermod --unlock --expiredate '' <name>` + `smbpasswd -e <name>` |
| `identity.user.delete` | `userdel <name>` (no `-r` — its files keep their uid) + `smbpasswd -x <name>` (only if a passdb entry exists) |
| `identity.group.add` | `groupadd <name>` |
| `identity.group.members` | `gpasswd -a` / `gpasswd -d <user> <group>` |
| `identity.group.delete` | `groupdel <name>` |
| `identity.smbpasswd.set` | `smbpasswd -a -s <name>` (password on stdin, never argv) |
| `identity.smbpasswd.clear` | `smbpasswd -x <name>` |

> **Permissions editor (Epic 4.7 → 4.7.1):** the layered access UI is backed by **POSIX ACLs** (`getfacl`/`setfacl`, `acltype=posixacl`) — owner/group/mode for the base rows, named-user/group ACL entries for extra principals, and a default ACL + setgid for inheritance. NFSv4 ACLs are **deferred to Epic 14** (they earn their complexity only for Windows-file-server parity, which pairs with an AD join). No `passwd`/`chpasswd` — ANAS never sets a Unix login password.

### iSCSI Operations (LIO — iscsi epic)

- `targetcli <one command>` — create/delete/set for backstores, targets, TPGs, portals, LUNs, ACLs; `saveconfig`; always ONE command per invocation (real exit code), serialized behind a daemon mutex
- direct configfs writes under `/sys/kernel/config/target/` for CHAP secrets only (argv-free; round-trips through `saveconfig`)
- reads: `/etc/rtslib-fb-target/saveconfig.json`, configfs (`acls/<iqn>/info` for sessions, `CLAIMED`/`udev_path` for the busy diagnosis)
- `systemctl restart rtslib-fb-targetctl` never issued by ANAS (a restore over a degraded state persists the hole); enable/disable via `targetcli`

**AHR-backed LUN images stay copy-on-write (ruled 2026-09-11).** `createSparseImage` is open+truncate and stays so — no `chattr +C`, no `nodatacow`, no per-LUN toggle. The btrfs data checksum is the whole reason an AHR image is a better block object than a raw LV: it keeps the image inside scrub attribution and self-heal, and snapshots (every backup run, every schedule) defeat NOCOW anyway (first write after a snapshot is CoW-once, so the file fragments regardless while losing its checksums). Guidance is placement, not a flag — the add-LUN dialog's AHR branch says so: random-write block workloads belong on a zvol; an image on spinning AHR expects fragmentation, and a later defragment unshares snapshot extents.

### Backup restore operations (proxmox-backup-client — backup2 epic)

- nested-filesystem detection (backup2.2): `timeout <s> find -P <path> -xdev -maxdepth N -type d -printf '%D\t%p\n'` (our own machine format — no structured tool walks `st_dev`), `findmnt --json`, `btrfs subvolume show <path>`; the backup call gains `--include-dev <path>` per included boundary — **`includeNested: all` is resolved at run time into per-archive `--include-dev` paths; `--all-file-systems` is never emitted** (it is per-invocation and would spill onto sibling archives)
- `proxmox-backup-client snapshot list --output-format json`, `list`
- `proxmox-backup-client catalog shell <snap> <archive>` driven over a pipe (`ls`, `stat`, `find`) — the archive browser; never `mount` (FUSE)
- `proxmox-backup-client restore <snap> <archive> <target|-> [--pattern …] [--allow-existing-dirs --overwrite] [--ignore-*] [--rate]`
- `proxmox-backup-client map` / `unmap` (`unmap` with no argument = sweep of stale loop devices)
- `zfs set snapdev=visible` / `zfs inherit snapdev` around a zvol snapshot backup (`set snapdev=hidden` would leave `source=local`)

### Cloud sync operations (rclone — rclone.1–3)

Every call carries `--config /etc/anas/rclone.conf --ask-password=false` (ANAS's own file — root's default config is never touched; anasd has no `HOME` anyway; a password-protected file fails at the first read and is reported, never prompted for).

- `rclone version`, `rclone config providers` (the dialog's schema), `rclone config dump` (the read side AND the post-write gate)
- `rclone obscure -` (password on stdin — never argv); the section itself is written by ANAS's surgical INI edit, not by `rclone config create/update/delete`, because 1.60's `rc` accepts input only as an argv string
- `timeout <s> rclone lsjson <remote>:<path> --max-depth 1 --contimeout 10s --timeout 30s --retries 1 --low-level-retries 1` — the Test probe; an unsaved remote is defined through `RCLONE_CONFIG_ANASTEST_*` environment variables
- `rclone copy|sync <source> <remote>:<path> --use-json-log --stats 30s --stats-log-level NOTICE [--bwlimit <rate>] [--exclude <pattern>]…` — the run; never `--max-delete`, never `--dry-run` in v1
- `systemctl` / `systemd-analyze calendar` for the `anas-cloud-<name>` units, `journalctl -u` for recent runs — as backup

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
- **Auth hook** (anas gateway): verifies PVEAuthCookie signature → attaches `{ name, uid }` to the request → rejects with 401 if invalid
- **Dev mode** (`ANAS_AUTH_PROVIDER=dev`): skips cookie validation, sets a mock user on every request

Proxmox integration:
- Users logged into Proxmox UI are already authenticated to ANAS: the ANAS panels run inside the PVE UI page and reach the gateway same-origin through PVE's `:8006` under `/anas`, so the browser sends PVEAuthCookie automatically (the `Secure` cookie is satisfied by pveproxy's existing TLS — the gateway itself serves plain HTTP on loopback). Cross-node operations are forwarded server-side — the browser never contacts another node (see **PVE UI Integration**)
- The PVE web UI gains an ANAS section via an injected integration script (see **PVE UI Integration**). PVE 9 has no official UI extension hook — the previously assumed `/usr/share/pve-manager/js/custom.js` mechanism does not exist

Both services run as root — no dedicated service user.

### Authorization
- If you're authenticated, you can do everything. Auth is binary: logged in or not.
- No roles, no groups, no permission matrix. This is a tool, not a meta-system.
- User identity is still propagated to anasd for audit logging.
- If finer-grained access is ever needed, it's a future discussion — not a V1 concern.

---

## UI: Native PVE Panels (ExtJS)

> Decision (July 2026): ANAS follows the Ceph model. The UI is a set of native ExtJS panels injected into pve-manager — no separate web app, no iframe. The earlier Nuxt/Vue frontend (floating panels, embedded mode, ticket handoff) is retired; `anas` is a pure API gateway. Rationale: users live in the PVE UI; an iframed, differently-styled app inside it reads as foreign. Native panels inherit PVE's theme, interaction patterns, and node-scoped mental model by construction.

**Structure** (mirrors how Ceph presents in the node menu):

```
Node "pve1"
└─ ANAS                    (collapsible group in the node menu, injected)
   ├─ Dashboard            ExtJS panel — health summary, active jobs
   ├─ Storage
   │  ├─ Pools             grid of pools → detail window (topology, properties, scan, actions)
   │  └─ Disks             grid of disks → SMART window
   ├─ Shares (SMB/NFS)     added with Epics 6–7
   └─ Jobs                 added with Epic 9
```

**Interaction model:** PVE-native. Grids with toolbars for collection views; double-click / button → `Ext.window.Window` for details and actions; `Proxmox.window.Edit` subclasses for mutations (they already handle 4xx display, loading masks, and submit flow); confirmation flows use the 409 + `X-Anas-Confirm-Code` API contract. Long operations submit a job and surface progress the way PVE tasks do.

**"Not installed" check (the Ceph pattern):** before rendering, panels probe the gateway (`GET /api/nodes/<node>/v1/health` through the local gateway). Connection refused / probe failure renders a friendly "ANAS is not installed on this node" panel with install instructions — we cannot auto-install like Ceph (we don't ship through PVE's packaging), so the panel shows the `npm install -g anas && anas setup` path instead of a wizard.

**Code layout:** the panels live in `packages/pve-integration/` alongside the injection loader — plain ES5 ExtJS (matching PVE's bundle), split into per-view files concatenated to `anas.js` by the installer. No build step, no framework dependencies.

**Dev workflow:** panel development targets a PVE host (the stunt node) — edit, push via a fast deploy script, reload the PVE UI. API development keeps the mock loop: `anasd --mock` + the gateway serve realistic fixture data without ZFS hardware.

### `ANAS.gfx` — graphical visual language (Epic 15)

> Decision (2026-07-14, validated via three local HTML spikes — composer, pools-status, datasets-tree). Storage views use a purpose-built graphical language rather than plain grids, because the physical/spatial reality of storage (which disk in which vdev faulted; where the space went) is legible graphically in a way tables aren't. **SVG + DOM, never canvas** — canvas has no DOM nodes → no `anas-*` test hooks, no CSS theming, no accessibility.

**Three visual registers** (a deliberate, consistent separation):
- **Content objects** — skeuomorphic *filled* SVG with material gradients: disks (HDD platter+actuator / SSD label / NVMe PCB+gold), vdev "bays", the pool. Materials are theme-neutral (a real drive is grey regardless of UI theme).
- **Controls** — flat monochrome *line* icons (`currentColor`, so they theme): add / snapshot / share / lock / properties / trash / folder / pool. Always-visible with `title` tooltips (no hover-reveal).
- **Data viz** — capacity gauges/bars (fullness-coloured) and the pool-space donut (breakdown by dataset + free).

**Module surface** (`ANAS.gfx`, a new file in the `packages/pve-integration/` concat, loaded before the views):
- `icon(kind, {state})` / `objectIcon('pool'|'folder')` → content-object SVG; `ctl(name)` → control line-icon button; `gauge(frac)` / `bar(frac)` → capacity viz; `donut(segments)` + `legend(segments)` → breakdown ring.
- Monitor-side vocabulary (added with the 15.3/15.4/15.5 retrofits, so a faulted disk etc. looks identical in every view): `statePill(state)` pool/vdev state chip; `chip(text, {good})` property chip; `badge(text, {kind:'smb'|'nfs'})` share badge; `callout(html, {level})` advisory banner (reuses the composer advisor output); `activity(frac, {label})` animated scrub/resilver strip; `bay(label, inner)` read-only vdev bay; `diskCard({kind, state, id, sub})` skeuomorphic disk tile.
- `drag(el, {onDrop})` → the pointer-events drag/dropzone helper (ghost locked to source width — no resize-on-lift; dropzone hit-test via `elementFromPoint`). Native Pointer Events — no library for MVP (a vendored Interact.js UMD is an optional later polish for touch/snapping, added as an earlier-numbered concat file exposing a global).
- Shared `<defs>` (material gradients) + a scoped `<style>` (palette tokens) injected once by the layer. Chrome tokens inherit PVE light/dark; every object/control carries an `anas-gfx-*` hook.

**First increment (de-risk before the composer):** port `ANAS.gfx` into `pve-integration` and deploy a minimal graphical panel to the stunt node to confirm the *real* PVE page is happy — CSP permits inline SVG/style, no ExtJS event conflicts, theme inherits, a Playwright hook drives. (The one thing local spikes couldn't prove.)

**Consumers** (build order): Pool Composer (below, the flagship / Epic 3.23 build-side) → Pools status view (same objects, live health) → Datasets enriched tree (inline bars/chips/badges + persistent controls + space donut) → Dashboard/Disk-Health as the vocabulary matures. Graphics where they add insight; Shares/Users/Jobs stay tabular.

### Pool Composer (Epic 15.2 / story 3.23)

A large modal composer launched from the Pools view, serving **create** (empty draft) and **expand** (seeded with the pool's existing topology, shown read-only; stage additions). Built on `ANAS.gfx`.

- **Data flow:** on open, GET the node's disks (existing disks API), filter to available/blank. Hold a **client-side draft model** (`vdevs[]` with role/type/disks, an assigned map) — no server calls until commit. Commit → **create**: `POST /pools` with `CreatePoolRequest` (compose `dataVdevs[]/logVdevs[]/cacheDisks[]/spareDisks[]` from the draft, one shot); **expand**: `zpool add` per staged vdev (`AddVdevRequest`). Via `ANAS.runJob`. No new schema — the API is already vdev-centric.
- **Interaction:** available-disk objects (draggable) → vdev bays grouped by role; "Add vdev" (role+type) spins up a bay; drag disks in, remove returns them; change a bay's type inline. Live summary (usable capacity, redundancy, "survives N failures").
- **Validity gating:** the Create button is DISABLED until the draft is valid — ≥1 data vdev at/above its type-min, every vdev meets its min, and (hard rule, per 3.22) special/dedup/log vdevs are **redundant**. Mixed data-vdev types warn but don't block.
- **Pool advisor** (differentiator): a rules-based panel that (a) characterises best-use from the composition ("Capacity pool, all-HDD — sequential/large-file"), (b) suggests improvements from the *unused* disks ("2 free SSDs → a mirrored special vdev accelerates metadata/small files"), (c) states honest caveats (L2ARC helps only when the working set exceeds RAM yet fits cache, and costs RAM for headers; SLOG helps only sync writes; a special vdev's loss loses the pool). Advisory, not salesy.

---

## Public API (browser ↔ anas gateway)

The gateway exposes anasd's resource model with the **node as a path parameter**, following PVE's own convention (`/api2/json/nodes/<node>/...`), served through PVE's `:8006` under the `/anas` prefix (see [`PROXY-TRANSPORT-DESIGN.md`](PROXY-TRANSPORT-DESIGN.md), story 12.2):

```
https://<ui-host>:8006/anas/api/nodes/<node>/v1/pools
https://<ui-host>:8006/anas/api/nodes/<node>/v1/pools/:name/scrub
https://<ui-host>:8006/anas/api/nodes/<node>/v1/jobs/:id
```

- **The browser only ever talks to the PVE `:8006` on the host serving the UI.** ANAS is same-origin under `/anas`, so `PVEAuthCookie` flows automatically — no CORS, no cert exception. pveproxy proxies `/anas` to the gateway on `127.0.0.1:3000`, which strips the prefix.
- **Node routing:** if `<node>` is the local node, the gateway forwards to the local anasd socket (`/v1/...`) — on a single-node install this branch is the whole story. Otherwise it forwards the request to `https://<node>:8006/anas/api/nodes/<node>/v1/...`, resolving the peer's address from PVE cluster membership (`/etc/pve/.members`, not DNS) and passing the user's ticket; the remote gateway verifies the ticket against the replicated cluster authkey (`/etc/pve/authkey.pub`) exactly as for a direct request, and the TLS hop is verified against the cluster CA (`/etc/pve/pve-root-ca.pem`). A node without ANAS returns a clean `ANAS_NOT_INSTALLED` signal. No new trust infrastructure — this is PVE's own fabric (Principle 15).
- anasd's `/v1/` API is unchanged — socket-only (Principle 9), reached exclusively through a gateway.

---

## PVE UI Integration (injection mechanism)

PVE 9 has **no official UI extension hook**. Verified facts (PVE 9.2, stunt node):
- pveproxy serves unowned files dropped into `/usr/share/pve-manager/js/` (dpkg never removes files it doesn't own — survives upgrades)
- The PVE UI page sends no CSP headers — same-origin injected scripts work
- `PVEAuthCookie` is set by PVE's own JS with `Secure` + `SameSite=Lax` and tickets are **cluster-valid** (any node verifies against the replicated authkey)

Integration consists of:
1. **`/usr/share/pve-manager/js/anas.js`** — the ANAS ExtJS panels + loader (concatenated from `packages/pve-integration/`), served at `/pve2/js/anas.js`. Our file, upgrade-safe.
2. **One `<script>` line inserted into `/usr/share/pve-manager/index.html.tpl`** (after `pvemanagerlib.js`). The single fragile point: pve-manager upgrades overwrite the template. Mitigations: idempotent presence-checked insert, an apt `DPkg::Post-Invoke` hook re-applies after upgrades, `anas doctor` detects and repairs, uninstall restores the pristine template.
3. **Menu injection**: a direct prototype patch of `PVE.node.Config.initComponent` (NOT `Ext.override` — `callParent` in a runtime override resolves against a missing hierarchy and crashes panel construction). The captured original runs first; our injection is try/catch-guarded.
4. **Fail-open, always**: every ExtJS/PVE internal touched is feature-detected; worst-case failure is "no ANAS section appears" plus one `console.warn`. The PVE UI must never break because of ANAS.

### Forward compatibility

- **Epic 12 (multi-node)**: already assumed by the API shape — the node is a path parameter and forwarding is server-side. A cluster deployment is N gateways + N daemons; the UI needs no changes.
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
4. Installs the pveproxy `/anas` reverse-proxy hook (fail-open, `perl -c`-gated) so the loopback gateway is reachable through PVE's `:8006` — no TLS or certificate of ANAS's own (see [`PROXY-TRANSPORT-DESIGN.md`](PROXY-TRANSPORT-DESIGN.md))

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

**anas.service** (the API gateway — serves no pages; plain HTTP on `127.0.0.1:3000`, fronted by pveproxy at `:8006/anas`)
```ini
[Unit]
Description=ANAS API Gateway
After=anasd.service
Requires=anasd.service

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/anas/packages/gateway/dist/index.js
User=root
Environment=NODE_ENV=production
# Operator-configurable loopback port (issue #2). install.sh writes ANAS_PORT
# into /etc/default/anas; the leading '-' makes it optional so an absent file
# leaves the built-in default 3000. AnasProxy.pm reads the same file, so the
# pveproxy /anas hop always targets the port the gateway actually binds. The
# port is NODE-LOCAL — nothing here is cluster-wide.
EnvironmentFile=-/etc/default/anas

[Install]
WantedBy=multi-user.target
```

**Generated schedule units** (written at run time, not installed by `anas setup`): the snapshot schedules ship `anas-snap-<id>.service`/`.timer` per policy, and story selfheal.4 adds ONE node-level pair, `anas-scrub.service`/`anas-scrub.timer` — a `Persistent=true` timer (monthly/quarterly OnCalendar) whose oneshot service runs `node dist/scrub-task.js <pools…>`, the runner that POSTs `/v1/ahr/<pool>/scrub` per enabled AHR pool in sequence. Both pairs follow the same unit-store pattern: the canonical config rides an `X-ANAS-Schedule=` JSON marker inside the `.service` file, and ANAS never edits a unit that lacks the marker. Cloud sync (rclone.2) adds `anas-cloud-<name>.service`/`.timer` per task on the backup shape (`X-ANAS-Task=` marker, runner `dist/cloud-task.js`).

---

## Security Considerations

### Attack surface minimization
- The gateway never executes system commands — all mutations go through anasd's REST API
- anasd only accepts structured REST operations, never raw commands
- Unix socket (not TCP) — only local processes can reach anasd
- Both processes run as root (like Proxmox) — the API contract is the security boundary

### Input validation layers (defense in depth)
1. **UI panels** — client-side validation for UX (not security)
2. **anas gateway** — server-side validation using Zod schemas
3. **anasd** — validates parameters using the same shared Zod schemas before execution

Shared schemas mean validation is defined once and enforced at both boundaries.

### Authentication & audit chain
```
Browser ──cookie──→ gateway ──X-Anas-User──→ anasd ──audit log──→ syslog/file
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
- Proxmox owns the session: PVEAuthCookie lifetime, renewal, and logout are PVE's
- ANAS is served same-origin under `:8006/anas`, so there is no CORS surface — the cookie flows automatically and cross-origin requests are impossible by construction
- State-changing requests are same-site by construction (panels run in the PVE page)

---

## Implementation Plan

> Historical note: phases 1–2 were executed against the original Nuxt/Vue frontend design; the July 2026 ExtJS-native pivot (see "UI: Native PVE Panels") reshapes the UI parts of later phases. Epic/story status in EPICS.md is authoritative.

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

### 1. UI Component Library: ExtJS (superseded PrimeVue, July 2026)

The UI is native ExtJS inside pve-manager (see "UI: Native PVE Panels"). Key components:
- **Ext.grid.Panel / Proxmox grids** — pool lists, disk lists, share lists, job history
- **Ext.tree.Panel** — ZFS dataset hierarchy (pool → dataset → child → snapshot)
- **Proxmox.window.Edit subclasses** — mutations (built-in 4xx display, masks, submit flow)
- **Theme** — inherited from PVE (light/dark follows the user's PVE setting)

*(Original decision was PrimeVue/Lara Dark in a Nuxt app; retired with the ExtJS-native pivot.)*

### 2. Configuration File: `/etc/anas/config.yaml`

YAML format (readable, supports comments, sysadmin-friendly). Generated by `anas setup` with sensible defaults.

Contents:
- Loopback listen port (default: 3000, `127.0.0.1` only)
- Session timeout (default: 30 min)
- Log level
- Socket path (default: `/run/anas/anasd.sock`)

### 3. TLS: none of ANAS's own — pveproxy terminates it

The gateway serves plain HTTP on `127.0.0.1:3000`; it holds no certificate and
opens no public origin. Browser-facing TLS is terminated by **pveproxy at
`:8006`**, which proxies `/anas` to the loopback gateway — so ANAS inherits the
exact certificate the Proxmox UI already uses, with nothing to configure and no
per-port exception to accept. Cross-node forwarding is the one place the gateway
speaks TLS as a client: `<node>:8006/anas` verified against the cluster CA
(`/etc/pve/pve-root-ca.pem`), the peer resolved via cluster membership
(`/etc/pve/.members`). See [`PROXY-TRANSPORT-DESIGN.md`](PROXY-TRANSPORT-DESIGN.md).

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

### 5a. Shares are storage-agnostic — a path is a path (decided July 2026)

ANAS manages shares by editing `smb.conf` / `/etc/exports` directly. It does **NOT** use ZFS's `sharesmb`/`sharenfs` dataset properties, even though those are useful and used elsewhere. Rationale: a share is just a directory **path** plus protocol options — it doesn't care what filesystem backs it. Editing the Samba/NFS config keeps the share layer completely decoupled from the storage backend, so the **same** share management works over ZFS datasets today and md + LVM + btrfs later (Epic 11). Tying shares to `sharesmb` would fork the share layer per backend. So: a filesystem dataset's mountpoint is the *usual* share path, but the share machinery only knows about paths and config files.

Consequence: the "Share this" action is offered only on **filesystem** datasets (they have a mountpoint); ZFS **volumes** (zvols) are block devices with no path to share — that's iSCSI territory: the iSCSI epic (`docs/EPICS.md`) exports volumes (and raw image files) as LUNs through its own menu, outside the share layer. A dataset's "associated shares" (story 4.4) are resolved by matching share paths against the dataset's mountpoint.

### 5b. Concurrency safety for config-file writes

Text-file editing must be safe against races — both ANAS-internal (two jobs) and external (an admin editing `smb.conf` by hand). The model:

- **Serialize ANAS writes** — a per-file async mutex in anasd so two jobs never read-modify-write the same config concurrently. (All mutations already funnel through the single anasd job queue.)
- **Always read fresh, never cache** — re-read the current file at the start of every mutation (Principle 11), so the edit is applied to the real current state, minimizing the external-edit window.
- **Optimistic change-detection** — capture a hash (or mtime+size) of the file at read; before writing, re-read and compare. If it changed underneath us (external edit), abort and surface a conflict rather than clobbering — the operator re-drives against fresh state.
- **Atomic replace** — write the new content to a temp file in the same directory, `fsync`, then `rename()` over the original (atomic on POSIX). Readers and the service reload never see a half-written file.
- **Backup before write** — keep a timestamped `.bak` so a bad edit is recoverable (guest philosophy: never destroy).
- **Reload is a side effect** — after a successful write, reload the service (`systemctl reload smbd`, `exportfs -ra`) as part of the same job, not a separate API call.

Decided: edit `smb.conf` / `/etc/exports` **in place** (surgical stanza edits) — ANAS sees and manages *every* share incl. admin-created, one source of truth (Principle 11). Not an include file (splits ANAS vs non-ANAS shares), not `net conf` registry (less transparent). And **no stage-then-apply** (unlike PVE network config): shares are independent, non-self-locking, and cheap+non-disruptive to reload, so per-operation atomicity (temp-write → rename, one job, immediate reload) is the right granularity; staging would add shadow "pending" state that conflicts with Principle 11. The review benefit comes cheaply via an optional **preview-diff on the confirmation step** of a single mutation.

### 5c. Share network binding — global server bind vs per-share client access

Binding is **server-wide, not per-share** — one `smbd`/`nfsd` listens for all shares.

- **Which address(es) the server serves on = GLOBAL.** SMB: `interfaces = …` + `bind interfaces only = yes` (in the SMB global config — `/v1/shares/smb/global`); this is the multi-NIC lever ("serve NAS traffic on the storage NIC only"). Default is all interfaces. There is no per-share interface binding in vanilla Samba. NFS: server-level (`/etc/nfs.conf`), coarse — MVP relies on per-export client specs rather than interface binding.
- **Which clients may connect = PER-SHARE.** SMB: `hosts allow`/`hosts deny` (host/subnet allow-lists) on each share. NFS: the per-export client spec (`/export 10.0.0.0/24(rw,sync)`). This segments access by network even while the server listens broadly.

Schema impact: **SmbGlobalConfig** carries `interfaces` + `bindInterfacesOnly` (MVP — multi-NIC is common); **SmbShare** carries `hostsAllow`/`hostsDeny`; **NfsExport** carries client specs (host/subnet + options).

### 5d. Shares UX (decided July 2026 — usability-first)

- **Unified "Shares" view** — one menu item, one grid listing every share across both protocols (Protocol column). A path shared via SMB+NFS shows as two clearly-labeled rows. Toolbar: +SMB Share, +NFS Export, SMB Settings.
- **Contextual create** — a "Share…" action on *filesystem* datasets (Datasets view) opens the create dialog pre-filled: path = mountpoint, SMB name suggested from the dataset's last path segment, overridable (the snapshot-name-default pattern).
- **Near-zero-typing defaults** — browseable=yes, read-only=no, guest=no; SMB access via a getent-backed user/group picker (not free-text); NFS client spec via a subnet field.
- **Active connections** column from `smbstatus` — live per-share connections (a differentiator PVE lacks).
- **Preview-diff on confirm** — show the exact smb.conf/exports change before applying.
- **SMB Settings** action for the global config (interface binding / multi-NIC lever, workgroup, server string) — a clear surface, not buried.

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
