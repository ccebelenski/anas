# ANAS — Epics & Stories

Stories follow the format: **As a [role], I want to [action], so that [outcome].**

Roles:
- **user** — any authenticated user. If you're logged in, you can see and do everything. Auth is binary: logged in or not.
- **dev** — developer/engineering role. Dev stories are non-deliverable prerequisites: infrastructure, scaffolding, parsers, test harnesses. They exist to make the scope of foundational work visible.

Story numbering is for identification only, not implementation order. Within each epic, stories are ordered by natural workflow: observe → understand → act.

---

## Epic 0: Foundation & Infrastructure

> Dev infrastructure that multiple epics depend on. No direct user-facing deliverable.

### Stories

0.1. [done] As a dev, I want the Nuxt 3 project initialized with TypeScript, PrimeVue, and Pinia, so that I have a working frontend skeleton.

0.2. [done] As a dev, I want anasd initialized as a Fastify server listening on a Unix domain socket, so that I have a working daemon skeleton.

0.3. [done] As a dev, I want a shared schema package (Zod) importable by both anas and anasd, so that types and validation are defined once.

0.4. [done] As a dev, I want a REST client in Nuxt that communicates with anasd over the Unix socket (with auth header propagation), so that API routes can delegate to the daemon.

0.5. [done] As a dev, I want the job queue implemented in anasd (submit, status polling, lifecycle management), so that all mutations have infrastructure to run on.

0.6. [done] As a dev, I want a command executor abstraction with Prod and Mock implementations, so that development and testing don't require a real Proxmox/ZFS system.

0.7. [done] As a dev, I want the auth provider interface defined with PVE, PAM, and Dev implementations, so that authentication is pluggable from day one.

0.7.1. [done] As a dev, I want auth simplified to PVE-only (with Dev for testing), removing PAM, JWT, and login page — since ANAS is always accessed through Proxmox, Proxmox owns the session.

0.8. [done] As a dev, I want audit logging to journald wired into anasd, so that every mutation is traceable from the start.

0.9. As a dev, I want a basic app layout shell (sidebar nav, header, content area), so that feature work has a place to live.

0.10. As a dev, I want a CI pipeline (lint, type-check, test), so that quality is enforced from the start.

---

## Epic 1: Authentication & Session Management

> As a user, I can access ANAS securely, with seamless authentication when coming from Proxmox.

### Stories

1.1. As a user, I want to access ANAS from the Proxmox UI sidebar and be automatically authenticated via my Proxmox session, so that it feels like part of Proxmox with no separate login.

1.2. [OBE] ~~As a user, I want a fallback login page with PAM authentication, so that I can access ANAS directly (not through Proxmox) if needed.~~ *ANAS is always accessed through Proxmox; PVE owns auth.*

1.3. [OBE] ~~As a user, I want ANAS to auto-detect whether Proxmox is available at startup and choose the right auth provider, so that I don't have to configure authentication manually.~~ *Simplified: PVE in production, Dev for testing. No auto-detection needed.*

1.4. [OBE] ~~As a user, I want my session to expire after inactivity, so that an unattended browser isn't a security risk.~~ *Proxmox manages session expiry via PVEAuthCookie.*

1.5. [OBE] ~~As a user, I want to log out explicitly, so that I can secure my session when I'm done.~~ *Logout is through Proxmox UI.*

#### Dev
1.6. As a dev, I want a mock PVE auth endpoint in the test suite, so that I can test PVEAuthCookie validation without a real Proxmox instance.

---

## Epic 2: Dashboard & System Overview

> As a user, I want a single view that tells me the health of my storage and shares at a glance.

### Stories

2.1. As a user, I want to see the health status of all ZFS pools on the dashboard, so that I can quickly identify problems.

2.2. As a user, I want to see disk utilization summaries, so that I know when I'm running low on space.

2.3. As a user, I want to see active SMB and NFS shares with their status, so that I can confirm services are running.

2.4. As a user, I want to see recent job activity on the dashboard, so that I know what operations have been performed.

2.5. As a user, I want to see warnings (degraded pools, failed scrubs, disk errors) prominently, so that I can take action before data loss.

#### Dev
2.6. As a dev, I want a unified system status endpoint in anasd that aggregates pool health, share status, and disk state, so that the dashboard can render from a single call.

---

## Epic 3: ZFS Pool Management

> As a user, I can create, manage, and monitor ZFS storage pools.

### Stories

#### Observe
3.1. As a user, I want to see all available disks and their current usage (unpartitioned, part of a pool, etc.), so that I understand what hardware I have.

3.2. As a user, I want to see the status of each pool (online, degraded, faulted, scrub progress), so that I can monitor health.

3.3. As a user, I want to see the vdev topology of a pool (which disks are in which vdevs, spares, cache, log), so that I understand the physical layout.

3.4. As a user, I want to see pool properties (ashift, autoexpand, etc.), so that I understand current configuration.

3.5. As a user, I want to see scrub progress and history, so that I know when the last integrity check ran and how it went.

3.6. As a user, I want to see SMART health data for individual disks, so that I can identify drives that may be failing.

#### Act
3.7. As a user, I want to import an existing pool (e.g., after moving disks from another system), so that I can access the data.

3.8. As a user, I want to create a ZFS pool by selecting disks and a redundancy level (mirror, raidz, raidz2, etc.), so that I can set up storage appropriate for my needs.

3.9. As a user, I want to modify pool properties, so that I can tune pool behavior.

3.10. As a user, I want to start a scrub on a pool, so that I can verify data integrity.

3.11. As a user, I want to add a vdev to an existing pool, so that I can expand capacity.

3.12. As a user, I want to attach a disk to a mirror (or replace a failed disk), so that I can restore redundancy.

3.13. As a user, I want to export a pool, so that I can safely move it to another system.

3.14. As a user, I want to destroy a pool, so that I can reclaim the disks. *(Confirmation required, clearly dangerous.)*

#### Dev
3.15. As a dev, I want a ZFS output parser that handles both JSON (`-j`) and parseable (`-Hp`) formats, so that pool/vdev/disk data is consistently structured regardless of ZFS version.

3.16. As a dev, I want mock ZFS command output fixtures (healthy pool, degraded pool, mid-scrub, etc.), so that I can develop and test the UI against realistic data.

---

## Epic 4: ZFS Dataset Management

> As a user, I can create and manage datasets within pools to organize storage.

### Stories

#### Observe
4.1. As a user, I want to see all datasets in a tree hierarchy, so that I understand how storage is organized.

4.2. As a user, I want to see dataset space usage (used, available, referenced, quota), so that I can monitor consumption.

4.3. As a user, I want to see dataset properties (compression, record size, mountpoint, etc.), so that I understand current configuration.

4.4. As a user, I want to see which shares (SMB and NFS) are associated with a dataset, so that I understand how it's being used before making changes.

#### Act
4.5. As a user, I want to create a dataset with configurable properties (compression, quota, reservation, record size), so that I can organize storage by purpose.

4.6. As a user, I want to modify dataset properties, so that I can adjust behavior as needs change.

4.7. As a user, I want to set permissions (owner, group, mode) on a dataset's mountpoint, so that the right users can access it.

4.8. As a user, I want to destroy a dataset, so that I can clean up unused storage. *(Confirmation required, warn if dataset has children or active shares.)*

---

## Epic 5: ZFS Snapshots

> As a user, I can create and manage snapshots for point-in-time data recovery.

### Stories

#### Observe
5.1. As a user, I want to see all snapshots for a dataset, so that I know what recovery points exist.

5.2. As a user, I want to see how much space each snapshot is consuming, so that I can manage snapshot retention.

#### Act
5.3. As a user, I want to create a snapshot of a dataset, so that I can capture the current state.

5.4. As a user, I want to rename a snapshot, so that I can give it a meaningful name.

5.5. As a user, I want to rollback a dataset to a snapshot, so that I can recover from mistakes. *(Confirmation required, clearly destructive.)*

5.6. As a user, I want to destroy a snapshot, so that I can reclaim space.

---

## Epic 6: SMB Share Management

> As a user, I can create and manage SMB (Windows/Samba) file shares.

### Stories

#### Observe
6.1. As a user, I want to see all configured SMB shares (including ones created outside ANAS), so that I have a complete picture of what's shared.

6.2. As a user, I want to see active SMB connections (who is connected, to which share, from where), so that I can monitor usage.

6.3. As a user, I want to see SMB global configuration (workgroup, server string, etc.), so that I understand the server-level settings.

#### Act
6.4. As a user, I want to create an SMB share pointing at a dataset or directory, with options and access controls configured together, so that the share is ready to use in one step.

6.5. As a user, I want to modify an existing share's settings (options, access controls), so that I can adjust behavior as needs change.

6.6. As a user, I want to modify SMB global configuration, so that I can change server-level settings like workgroup name.

6.7. As a user, I want to remove an SMB share from the configuration, so that I can revoke access to a path.

6.8. As a user, I want ANAS to reload the SMB service after configuration changes, so that changes take effect without manual intervention.

#### Dev
6.9. As a dev, I want a round-trip smb.conf parser (parse → modify → write) that preserves comments, whitespace, ordering, and unknown directives, so that surgical config editing works correctly.

6.10. As a dev, I want smb.conf test fixtures (minimal, complex, hand-edited with comments, Proxmox-default), so that the parser is tested against real-world configs.

---

## Epic 7: NFS Export Management

> As a user, I can create and manage NFS exports for Linux/Unix clients.

### Stories

#### Observe
7.1. As a user, I want to see all configured NFS exports (including ones created outside ANAS), so that I have a complete picture of what's exported.

#### Act
7.2. As a user, I want to create an NFS export for a dataset or directory, so that Unix clients can mount it.

7.3. As a user, I want to configure export options (client restrictions, read/write, sync/async, root squash), so that the export is appropriately secured.

7.4. As a user, I want to modify an existing export, so that I can adjust settings.

7.5. As a user, I want to remove an NFS export, so that I can revoke access.

7.6. As a user, I want ANAS to reload NFS exports after configuration changes, so that changes take effect without manual intervention.

#### Dev
7.7. As a dev, I want a round-trip /etc/exports parser (parse → modify → write) that preserves comments, whitespace, and unknown entries, so that surgical config editing works correctly.

---

## Epic 8: User & Group Management (for share access)

> As a user, I can manage the system users and groups that are needed for share access and permissions.

### Stories

#### Observe
8.1. As a user, I want to see system users relevant to share access (filtering out system/service accounts), so that I understand the access landscape without noise.

#### Act
8.2. As a user, I want to create a system user, so that they can access shares. *(Focused on share access, not full user administration.)*

8.3. As a user, I want to create a group, so that I can organize share permissions.

8.4. As a user, I want to add/remove users from groups, so that I can manage access at the group level.

8.5. As a user, I want to set an SMB password for a user, so that they can authenticate to SMB shares.

8.6. As a user, I want to disable a user's access without deleting them, so that I can temporarily revoke access.

---

## Epic 9: Job & Operation Management

> As a user, I can monitor operations and be notified of outcomes through Proxmox's notification system.

### Stories

9.1. As a user, I want to see all active jobs and their progress, so that I know what's currently happening.

9.2. As a user, I want to see the history of completed and failed jobs since the last service restart, so that I can review recent activity.

9.3. As a user, I want to see the details of a job (who initiated it, what it did, when, result or error), so that I can audit operations.

9.4. As a user, I want job failures to generate Proxmox notifications, so that I'm alerted through whatever channels I've already configured (email, Gotify, etc.).

#### Dev
9.5. As a dev, I want a Proxmox notification client that can send notifications through the PVE notification system, so that ANAS events reach users through their existing alert channels.

---

## Epic 10: System Setup & Configuration

> As a user, I can install ANAS on my Proxmox system quickly and have it integrate automatically.

### Stories

10.1. As a user, I want to install ANAS with a single command (`npm install -g anas`), so that deployment is simple.

10.2. As a user, I want `anas setup` to detect Proxmox, configure systemd units, set up TLS, and generate default config, so that the system is ready to use with minimal intervention.

10.3. As a user, I want `anas setup` to install a sidebar entry in the Proxmox UI, so that ANAS is accessible from the Proxmox interface.

10.4. As a user, I want ANAS to use Proxmox TLS certificates automatically, so that I don't need to manage separate certs.

10.5. As a user, I want to override defaults (port, TLS, auth provider) via `/etc/anas/config.yaml`, so that I can customize the deployment when needed.

10.6. As a user, I want to run `anas doctor` to validate my environment (Proxmox version, ZFS availability, Samba/NFS installed, TLS certs, config sanity), so that I can diagnose problems without guessing.

10.7. As a user, I want `anas doctor` to fix what it can automatically and clearly explain what it can't (with actionable guidance), so that I can resolve issues quickly.

10.8. As a user, I want to upgrade ANAS (`npm update -g anas`) and have services restart cleanly, so that upgrades are simple and low-risk.

#### Dev
10.9. As a dev, I want the `anas setup` and `anas doctor` commands implemented as CLI subcommands (not part of the web app), so that they can run before the services are started.

---

## MVP Scope

For V1 MVP, the priority order is:

1. **Epic 10** — Setup & config (foundation — can't do anything without it)
2. **Epic 1** — Auth (can't use it without logging in)
3. **Epic 9** — Jobs (infrastructure — every mutation depends on this)
4. **Epic 3** — ZFS pools (core value proposition)
5. **Epic 4** — ZFS datasets (core value proposition)
6. **Epic 5** — Snapshots (core value proposition)
7. **Epic 6** — SMB shares (core value proposition)
8. **Epic 7** — NFS exports (core value proposition)
9. **Epic 8** — Users & groups (required for share security)
10. **Epic 2** — Dashboard (polish — can ship without it initially)

Stories marked *(V2?)* are explicitly deferred.

---

## V2 Backlog

### Epic 11: md (mdadm) Storage Management

> As a user, I can create and manage Linux software RAID arrays with md for environments where ZFS isn't appropriate.

md provides RAID without ZFS's memory overhead, using standard Linux filesystems (ext4, xfs). This involves managing multiple layers: mdadm arrays, filesystem creation/formatting, mount points, and /etc/fstab. The share management side (SMB, NFS) is reusable — a path is a path. The storage management UI needs parallel workflows for md vs ZFS.

Detailed stories to be written when this epic is prioritized.

### Epic 12: Multi-Node / Cluster Management

> As a user, I can manage storage and shares across multiple Proxmox nodes from a single ANAS instance.

Single pane of glass for multi-node environments. anasd's REST API becomes the building block — the same API that runs over a Unix socket locally can run over TCP/TLS to remote nodes. Each node runs anasd; one node runs anas as the central UI.

Proxmox has the Datacenter Manager product, but ANAS cluster management would be storage-focused and independent of it.

Detailed stories to be written when this epic is prioritized.
