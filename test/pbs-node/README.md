# PBS Test Node — a real Proxmox Backup Server for the backup epic

A second libvirt VM beside the [stunt node](../stunt-node/README.md), running
**Proxmox Backup Server 4** on Debian 13. It exists so backup and restore work
can be exercised against a real PBS over a real network, instead of a PBS
co-installed on the node under test.

| | |
|---|---|
| VM name | `anas-pbs` |
| Address | `192.168.200.51` (network `anas-test`, same as the stunt node) |
| SSH | `ssh root@192.168.200.51` (password `anas-test`, plus your host key) |
| Web UI | `https://192.168.200.51:8007` |
| Disks | 20 GB system + 30 GB datastore (serial `ANAS_PBS_STORE`) |
| Datastore | `gtstore` at `/mnt/datastore/gtstore` (ext4) |
| API token | `root@pam!anas`, `DatastoreAdmin` on `/datastore/gtstore` |

The host setup is the stunt node's: `test/stunt-node/setup-host.sh` installs
libvirt, defines the `anas-test` network and writes `STORAGE_PATH` into
`test/stunt-node/config.local`. This node reads that same `STORAGE_PATH` and
shares the cached Debian cloud image — there is nothing extra to install.

## Quick start

```bash
# 1. Create the VM (cloud-init, network handoff to ifupdown2, ~3 min)
./test/pbs-node/create-pbs-vm.sh

# 2. Install PBS, build the datastore, mint the API token (~10 min)
./test/pbs-node/provision-pbs.sh

# 3. Baseline snapshot (offline, VM is stopped for it)
./test/pbs-node/snapshot.sh baseline
```

## Provisioning order

`create-pbs-vm.sh` follows the ordering the stunt node learned the hard way:

1. Boot the Debian 13 genericcloud image with a cloud-init seed ISO — root SSH
   key, root password, static `192.168.200.51`.
2. Install **ifupdown2** and write `/etc/network/interfaces` **before** removing
   cloud-init. Purging netplan cascades into `iproute2`; doing it in the other
   order bricks the network.
3. Point systemd-resolved at the libvirt gateway (`192.168.200.1`).
4. Purge cloud-init and netplan, disable systemd-networkd.
5. Set the hostname and an `/etc/hosts` entry on the non-loopback IP.
6. Reboot onto the ifupdown2 config, so a broken handoff fails here rather than
   halfway through provisioning, then eject the seed ISO.

`provision-pbs.sh` then:

1. Adds the **pbs-no-subscription** repo for trixie with the Proxmox trixie
   keyring, and writes the enterprise stanza out commented (it 401s without a
   subscription, and apt refuses a stanza that is only half commented out).
2. `apt-get full-upgrade`, then installs `proxmox-backup-server`, enabling
   `proxmox-backup` and `proxmox-backup-proxy`.
3. Formats the 30 GB disk **ext4** (labelled `pbs-gtstore`), mounts it by UUID
   at `/mnt/datastore/gtstore`, and creates datastore `gtstore` on it. ext4
   rather than ZFS on purpose: this VM is a backup *target*, nothing in the
   harness reads the datastore's own filesystem, and ext4 needs no extra
   packages, no import ordering and no ARC tuning in a 4 GB VM.
4. Generates the API token `root@pam!anas` and grants it `DatastoreAdmin` on
   `/datastore/gtstore`.
5. Reads the certificate fingerprint and writes the token secret + fingerprint
   into `config.local` (0600, gitignored).

Re-running `provision-pbs.sh` is safe. The token is the exception: PBS shows a
token secret only at generation, so a re-run deletes the existing token and
mints a new one. Anything holding the old secret must be updated.

## What the datastore and token are for

ANAS backs up to PBS with `proxmox-backup-client`, driven by a registered
repository (Epic 16). A repository is host + port + datastore + an identity +
a pinned certificate fingerprint — see `packages/daemon/src/services/backup-repos.ts`.
`gtstore` is the target datastore, `root@pam!anas` is the identity ANAS
authenticates as, and the fingerprint is what pins this VM's self-signed
certificate (its CN is the VM hostname, so a client MUST pin the fingerprint
rather than rely on hostname verification).

## Registering it in ANAS

```
POST /v1/backup/repos
{
  "name": "gt-pbs",
  "host": "192.168.200.51",
  "port": 8007,
  "datastore": "gtstore",
  "authType": "token",
  "tokenId": "root@pam!anas",
  "secret": "<PBS_TOKEN_SECRET from config.local>",
  "fingerprint": "<PBS_FINGERPRINT from config.local>"
}
```

The equivalent client-side repository string, for a check by hand from the stunt
node (`proxmox-backup-client` ships with PVE):

```bash
PBS_REPOSITORY='root@pam!anas@192.168.200.51:gtstore' \
PBS_PASSWORD='<secret>' \
PBS_FINGERPRINT='<fingerprint>' \
  proxmox-backup-client list --output-format json     # [] on an empty datastore
```

An unauthenticated `curl -sk https://192.168.200.51:8007/api2/json/version`
answers `authentication failed` with HTTP 401 — that is the proxy answering.
With the token header it returns the version JSON.

## Scripts

| Script | Purpose |
|--------|---------|
| `create-pbs-vm.sh` | Create the VM from the cloud image + cloud-init, hand the network to ifupdown2, purge cloud-init |
| `provision-pbs.sh` | Install PBS 4, build the `gtstore` datastore, mint the API token, write `config.local` |
| `start.sh` | Start the VM, wait for SSH |
| `stop.sh` | Graceful shutdown (60 s, then force) |
| `ssh.sh` | SSH into the VM |
| `snapshot.sh <name>` | Offline snapshot |
| `restore.sh <name>` | Revert to a snapshot and start |
| `destroy-vm.sh` | Delete the VM, both disks, every snapshot — and every backup in the datastore |

## Snapshots

| Name | Contents |
|------|----------|
| `baseline` | PBS 4 installed, `gtstore` empty, token `root@pam!anas` valid |

Reverting to `baseline` restores the token that was valid when the snapshot was
taken, which is not necessarily the one in `config.local` if the token has been
regenerated since.

## Security

- Root password `anas-test` and the API token are test credentials on an
  isolated host-only network. `config.local` is gitignored and 0600; the secret
  never goes in the repo.
