# ANAS — A NAS: design index

This page is an index. The design itself lives in the files below, one per area. Each entry says what the file covers and when to read it. New design text goes into the area file; this page only gains a pointer.

Read [`PRINCIPLES.md`](PRINCIPLES.md) first: it binds every area. Scope and stories are in [`EPICS.md`](EPICS.md).

## The whole system

| File | What it covers | Read it when |
|---|---|---|
| [`design/architecture.md`](design/architecture.md) | The two processes, how a request travels through pveproxy, the tech stack, what V1 includes. | You are new to the project, or a change touches how the processes talk. |
| [`design/api.md`](design/api.md) | The rules every endpoint follows: versioning, identifiers, the 409 confirm, responses, jobs. Also the status, jobs and browse endpoints and the full route index. | You add or change any endpoint. |
| [`design/owners.md`](design/owners.md) | Which module owns which fact, and the rules for everything else. | Before you read, parse or write a config file, or decide a system fact. |
| [`design/commands.md`](design/commands.md) | Every command anasd may run, by area. | A change needs to run a command. |
| [`design/auth.md`](design/auth.md) | How a PVE ticket becomes an identity, and the `Sys.Audit` / `Sys.Modify` rule. | Anything about who may do what. |
| [`design/security.md`](design/security.md) | Attack surface, input validation, command injection, the audit chain. | A change takes outside text toward a command or a file. |
| [`design/ui.md`](design/ui.md) | The panels inside the PVE web UI and how they are injected. | Panel work. |
| [`design/install.md`](design/install.md) | The tarball install, `anas setup`, the systemd units. | Installer, packaging or upgrade work. |
| [`design/decisions.md`](design/decisions.md) | Decisions already made, with their reasons, and the original build plan. | Before reopening a settled question. |

## Storage and services

| File | What it covers | Read it when |
|---|---|---|
| [`design/pools.md`](design/pools.md) | ZFS pool endpoints and the gates on reshaping a pool. | Pool work. |
| [`design/datasets.md`](design/datasets.md) | Dataset and snapshot endpoints. | Dataset, snapshot or permissions work. |
| [`design/shares.md`](design/shares.md) | SMB shares and NFS exports. | Share work. |
| [`design/mounts.md`](design/mounts.md) | Remote and local mounts managed through `/etc/fstab`. | Mount work. |
| [`design/iscsi.md`](design/iscsi.md) | iSCSI targets and LUNs on LIO, ownership, health, the gates other features take from it. | iSCSI work, or a change to anything a LUN can sit on. |
| [`design/replication.md`](design/replication.md) | `zfs send` replication: targets, holds, recursive runs, guards on a replica. | Replication work. |
| [`design/backup.md`](design/backup.md) | File backup to Proxmox Backup Server and restore. | Backup work. |
| [`design/cloud.md`](design/cloud.md) | Cloud sync with rclone. | Cloud sync work. |
| [`design/users.md`](design/users.md) | The users and groups ANAS shows and manages for share access. | Identity work. |
| [`AHR-DESIGN.md`](AHR-DESIGN.md) | ANAS Hybrid RAID: mixed-size pools on md, LVM and btrfs. | AHR work. |
| [`SCHEDULES-DESIGN.md`](SCHEDULES-DESIGN.md) | Snapshot and scrub schedules for ZFS and AHR. | Schedule work. |
| [`PROXY-TRANSPORT-DESIGN.md`](PROXY-TRANSPORT-DESIGN.md) | The single transport through pveproxy on port 8006. | Gateway or proxy work. |

## Evidence, not design

The `*-GROUND-TRUTH.md` files hold captured output from real nodes; a parser is written against them. The `LIVE-PROOF-*.md` and `CODE-REVIEW-*.md` files are records of past passes. [`EPICS-HISTORY.md`](EPICS-HISTORY.md) holds the rationale behind each ruling.
