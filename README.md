# ANAS — A NAS

**The storage layer Proxmox VE doesn't have, inside the Proxmox web UI.**

Proxmox VE manages VMs and containers and the storage they consume. It doesn't
do much for the storage you serve to everything else: file shares, block
targets, and the pools and disks behind them. ANAS fills that gap, on the PVE
node itself: ZFS pools, **Hybrid RAID pools that mix drive sizes and grow one
disk at a time**, datasets and zvols, SMB and NFS shares, an iSCSI target,
snapshots and scrubs on a schedule, replication with `zfs send/recv`, file and
block backup to Proxmox Backup Server (and restore), client-side NFS/CIFS
mounts, and disk health.

The UI is a set of native ExtJS panels added to the Proxmox web UI, the same way
Proxmox does Ceph. You don't deploy an appliance or pass an HBA through to a NAS
VM, and there's no second web app or second login. You're already logged into
PVE, and since PVE tickets are valid cluster-wide, the same browser tab works on
every node.

> **Status: pre-1.0.** Actively developed and dogfooded on a production PVE
> cluster, but interfaces and behavior may change without notice. Use at your
> own risk — and read the guest philosophy below for why the risk is smaller
> than you'd think.

## Screenshots

![ANAS dashboard: pool health, capacity, and live per-pool and per-disk I/O and latency, with an AHR array expanding online](docs/images/dashboard.png)

**Live dashboard** — pool health, capacity, and real-time per-pool and per-disk I/O + latency, for ZFS and AHR pools alike. Caught here with an AHR array expanding online, one disk at a time.

![Hybrid RAID (AHR) composer: build a redundant pool from mixed-size disks, with a live sliced layout and an advisor that flags unsafe configurations](docs/images/ahr-composer.png)

**Hybrid RAID (AHR)** — build a redundant pool from mixed-size disks by dragging them in, with a live sliced layout and honest capacity accounting. The advisor won't let you footgun it — here it flags that a single disk has no redundancy, and exactly what's needed to fix it, rather than silently building something unsafe.

![Creating an SMB share with per-share access control in ANAS](docs/images/smb-shares.png)

**SMB & NFS shares** — create and secure shares with per-share access control: valid users, browseable, read-only, and allowed/denied hosts.

![Creating a scheduled snapshot with keep-N-per-period retention](docs/images/snapshot-schedule.png)

**Scheduled snapshots & scrubs** — uniform snapshot schedules across ZFS and AHR, driven by systemd timers with keep-N-per-period retention and sane presets built in.

## Features

### Pools

- **ZFS pools** — create/import/export/destroy, scrub, topology view with
  per-bay disk health, device errors and properties. A drag-to-build vdev
  composer shows capacity and redundancy as you go, and a rules-based advisor
  warns about layouts with no redundancy or wasted space before you build them.
  Special/dedup vdevs and RAIDZ expansion are supported; PVE-owned pools are
  tagged and left alone.
- **Hybrid RAID (AHR)** — Synology-SHR-style pools from **mismatched disk
  sizes**, using every drive's full height (a 12 TB next to 8 TBs contributes
  all 12, not 8): disks are sliced into size-matched bands, each band is its own
  md RAID5/6 array, LVM concatenates the bands, and one btrfs filesystem sits on
  top (checksums + scrub; redundancy always lives in md, never btrfs-RAID).
  **Grow as you buy** — add or live-replace one disk at a time while the pool
  stays mounted, with a layout preview that names what each combination yields
  and what stays locked until a matching disk arrives. Expansion is a resumable
  multi-layer job; power loss mid-reshape is survivable. **Hot spares** are
  full-coverage — sliced into every band so md owns failover.

### Data

- **Datasets** — tree view, quotas, compression/dedup/sync/trim, and a
  POSIX-ACL permissions editor with a layered access view.
- **ZFS volumes (zvols)** — listed with size, `volblocksize` and usage; create,
  grow while in use (the initiator rescans and sees the new size), snapshot and
  destroy. PVE guest volumes stay read-only.
- **Snapshots** — create, rename, rollback (gated), clone, destroy on ZFS; the
  same verbs on AHR over btrfs `@data`/`@snapshots` subvolumes, where rollback
  preserves the replaced state rather than destroying it.
- **Schedules** — uniform snapshot and scrub schedules across ZFS and AHR, on
  systemd timers, with keep-N-per-period retention that never prunes a held
  snapshot. Scrubs start and stop from the UI and report progress and a
  last-scrub verdict.
- **Replication** — `zfs send/recv` tasks on systemd timers: local pool→pool and
  remote over SSH. PVE cluster peers are auto-discovered; external hosts —
  including TrueNAS — need only sshd and ZFS, nothing installed. Host keys are
  pinned and shown; when a remote is rebuilt you re-trust it from the UI.

### Serving

- **SMB shares** — full share lifecycle over a round-trip `smb.conf` editor
  that preserves your comments and formatting; per-share access control (valid
  users, browseable, read-only, allowed/denied hosts) and a connection-details
  view.
- **NFS exports** — the same treatment for `/etc/exports`.
- **iSCSI target** — manages LIO (targetcli) natively: targets with a stable
  ANAS-generated IQN, portals, initiator ACLs with one-way or mutual CHAP
  (secrets go to configfs, never onto a command line), and LUNs backed by a
  **zvol** or by a **raw image file** on a dataset or AHR pool. LUN serials and
  attributes survive every recreate, since that's how initiators (and PVE's own
  volids) recognise a disk. New targets start locked down: demo mode off,
  dynamic ACLs off, discovery closed to initiators not on the list. At boot the
  target comes up after ZFS volumes and AHR pools; a file-backed LUN whose
  filesystem didn't mount is quarantined and not served. Destroying a LUN's
  zvol, exporting its pool, or unmounting its filesystem is refused while the
  LUN exists, and the refusal names the LUN and the connected initiators.
- **Share users** — Samba user management for share access, over `getent`
  identities and nologin accounts. No role or permission system — PVE owns
  identity.

### Protecting

- **Backup to PBS** — a task is **files** (shares, datasets, any mounted path)
  or **block** (one LUN per task, as a fixed-chunk `.img` archive), stored on a
  Proxmox Backup Server via `proxmox-backup-client` with dedup, encryption,
  retention and pruning. Repositories include the PBS storages PVE already knows
  about. File sources on ZFS and AHR are backed up **from a snapshot**, so a
  multi-hour run captures one instant; sources that can't be snapshotted (remote
  mounts, for instance) are backed up live and labeled as such. Nested
  filesystems under a source are detected and listed, and you choose which
  ones to include.
- **Restore** — selective file restore with a picker that browses the live tree
  and the archive catalog side by side, restoring **into the original**
  (matching files overwritten, the rest kept) or **somewhere else**. Whole-image
  LUN restore goes onto the original LUN, or onto a **new LUN** with a fresh
  serial on any target, leaving the source untouched. There's one Restore
  dialog, reachable from the LUN toolbar, the task grid or the repository, and
  it only asks for what it can't work out from where you opened it.
- **Disk health** — SMART and ZFS fused into a single per-disk status, with
  pool and vdev membership.

### Consuming

- **Mounts** — client-side NFS/CIFS mounts with surgical fstab persistence
  (credentials in root-only files, never on a command line), a common option set
  across both protocols, human-readable file/dir permission modes, and on-demand
  (automount) mounting. Local, ZFS-, AHR- and PVE-owned mounts are inventoried
  read-only and labeled with what manages them.

### Operating

- **Dashboard** — pool health, capacity, disk health, shares, running jobs and
  warnings, plus live telemetry: ARC, network throughput, and per-pool/per-disk
  I/O with latency for ZFS and AHR alike (the AHR strip breaks down to per-band
  and per-member throughput/IOPS/latency). The jobs strip and warning cards
  appear only when something is running or wrong.
- **Jobs** — every change is a queued job you can watch through to its result,
  including the multi-hour ones.
- **Notifications** — unattended runs (backup, snapshot schedules, replication)
  report through **PVE's own notification system**, per task: always, or on
  failure only.
- **Cluster** — cross-node traffic goes through each node's `:8006`: no extra
  port, no extra certificate. A version-skew banner names the versions when a
  newer UI meets an older daemon.

## What ANAS is not

- **Not a Proxmox replacement or fork.** It installs onto a stock PVE node and
  adds panels to the UI that is already there.
- **Not a NAS operating system or appliance.** There's no second machine to
  boot, patch, or pass an HBA through to.
- **Not a VM or container manager.** Proxmox does that.
- **Not a Ceph manager.** `pveceph` owns Ceph. A mounted CephFS path can be
  shared like any other path; ANAS does nothing else with Ceph.
- **Not an identity system.** PVE owns the login, and there are no roles or
  permissions. The only accounts ANAS manages are Samba users for share access.
- **Not a scheduler, notifier, or monitoring stack.** systemd timers run the
  schedules and PVE's notification system delivers the messages.

## How it's built (the guest philosophy)

ANAS treats your system as the source of truth and itself as a **guest**:

- **No shadow state.** Nothing is stored that the system doesn't already know.
  Pools come from `zpool`, shares from `smb.conf`/`exports`, schedules from
  systemd units. Uninstalling ANAS loses nothing.
- **Surgical config editing.** Config files are edited in place — comments,
  ordering, and hand-edits preserved byte-for-byte outside the touched lines.
  Never overwritten, never "owned".
- **Leverage, don't rebuild.** PVE's certificates, auth tickets, journald,
  systemd timers, notification system, and cluster filesystem are used as-is.
  ANAS builds no scheduler, no notifier, no user database.
- **PVE territory is read-only.** Pools, datasets, volumes and mounts that
  Proxmox manages are inventoried, labeled, and left alone; `storage.cfg` is
  parsed, never written.
- **Two processes, one boundary.** An API gateway (`anas`, plain HTTP on the
  loopback interface) fronts a system daemon (`anasd`, REST over a Unix
  socket). The gateway is reached through PVE's own `:8006` front door under
  `/anas` (a fail-open reverse-proxy hook in pveproxy) — no separate origin, no
  extra certificate. All mutations are queued jobs; every operation is audited
  to journald with the requesting user's identity.
- **Dangerous operations are gated.** Destructive actions require an explicit
  confirmation code round-trip. An operation that would break something in use
  is refused, and the refusal says why and what to do instead.

## Requirements

- Proxmox VE node (single node or cluster)
- Node.js ≥ 20 (installer can provide via `--install-deps` — the only thing that
  flag gates)
- ZFS ≥ 2.2 (ANAS uses `zpool`'s JSON output)
- `mdadm` + `btrfs-progs` for Hybrid RAID, `samba` for SMB shares and share
  users, `nfs-kernel-server` for NFS exports, `acl` for permissions,
  `targetcli-fb` + `python3-rtslib-fb` for serving iSCSI block storage — the
  installer adds all of them, on fresh installs and upgrades alike (PVE ships
  none of them, and ANAS never gates a feature on its tools being absent)

## Install

Grab a release tarball, untar it on the PVE node, and run the installer as
root:

```sh
tar xzf anas-<version>.tar.gz
cd anas-<version>
sudo ./install.sh              # add --install-deps on a fresh node
```

The installer preflights the node without touching it, then performs a
transactional install (dependencies → backup → install → health check → PVE UI
integration) that rolls itself back completely on any failure. Re-running it is
the upgrade path. ANAS is served through pveproxy on `:8006` under `/anas`, so
there is no separate origin and **no extra certificate to accept** — if the
Proxmox web UI loads, ANAS does. See [`packaging/README.md`](packaging/README.md)
for flags and uninstall.

### Gateway port

The gateway binds a loopback port (default **3000**) that only pveproxy talks
to; it is never exposed and needs no certificate. If something else on the node
already listens on 3000, pass another port:

```sh
sudo ./install.sh --port 3001
```

On a fresh install the installer auto-picks the next free port if 3000 is taken.
The choice is written to `/etc/default/anas` and preserved across upgrades unless
you pass `--port` again. It is per-node — nodes in a cluster need not agree,
since cross-node traffic goes through each node's `:8006`.

## Building from source

```sh
npm install
./packaging/make-release.sh    # builds, smoke-tests, and tars a release
```

Produces `dist-release/anas-<version>.tar.gz`. Versioning is semver with a
single source of truth — see [`packaging/README.md`](packaging/README.md).

## Development

```sh
npm install
npm run dev     # anasd in mock mode (no real ZFS needed) + gateway with dev auth
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow, tests (unit +
Playwright against a disposable "stunt" PVE node), and project structure, and
`docs/` for the architecture ([`DESIGN.md`](docs/DESIGN.md)), the
non-negotiable design principles ([`PRINCIPLES.md`](docs/PRINCIPLES.md)), and
the story backlog ([`EPICS.md`](docs/EPICS.md)).

## License

ANAS is free software, licensed under the **GNU Affero General Public License
v3.0 or later** (AGPL-3.0-or-later) — the same license family as Proxmox VE
itself. See [`LICENSE`](LICENSE).

Copyright © 2026 Chris Cebelenski
