# Architecture

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
- ~~SMART monitoring and alerting~~ — moved in scope since V1: SMART is displayed in the Disks tab (detail + dashboard warnings, disks.1); alerting stays PVE's (no alerting systems, per CLAUDE.md)
- ~~Scheduled tasks (scrub scheduling, snapshot policies)~~ — moved in scope since V1: the schedule unit (`/v1/schedules`, scrub schedules in `/v1/scrub`) ships periodic scrub, snapshot and sync policies
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
│  - Believes only pveproxy's signed hand-off  │
│    (X-Anas-Auth: PVE checked the ticket,    │
│    CSRF and privileges); GET/HEAD need      │
│    Sys.Audit on /, else Sys.Modify (cr.27)  │
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
[`PROXY-TRANSPORT-DESIGN.md`](../PROXY-TRANSPORT-DESIGN.md) for the authoritative
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
- Mitigated by: one release tarball carries both, and a single `./install.sh` configures both

---

## Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| UI | ExtJS panels injected into pve-manager (the Ceph model) | Native PVE look, theme, and interaction — no iframe, no style clash, users stay in the UI they know |
| API gateway (anas) | Fastify (TypeScript) | Same stack as anasd; auth verification, validation, node forwarding. Plain HTTP on loopback, fronted by pveproxy at `:8006/anas` (no TLS/CORS of its own) |
| Config format | none — environment (`/etc/default/anas`, systemd unit drop-ins) | No config file exists; defaults in code, overrides via env (EPICS §5 rejected a YAML layer) |
| Auth | PVE's own `auth_handler` and `$rpcenv->check`, run inside pveproxy by `AnasProxy.pm`, handed to the gateway as an HMAC-signed header (cr.27); Dev provider for testing | Proxmox owns the session and the privileges; tickets and ACLs are cluster-valid |
| Daemon runtime | Node.js (TypeScript) | Same language as gateway, shared schemas, single npm package |
| Daemon framework | Fastify | Lightweight, schema validation built-in, Unix socket support |
| IPC | REST (HTTP) over Unix domain socket | Formal semantics, curl-debuggable, auth propagation |
| Project structure | Monorepo (packages/) | shared schemas imported by both anas and anasd |
| Schema validation | Zod (shared between anas and anasd) | Single source of truth for request/response types |
| Command execution | `child_process.execFile` | No shell interpretation, no injection |
| Process management | systemd | Standard, reliable, already on Proxmox |

---
