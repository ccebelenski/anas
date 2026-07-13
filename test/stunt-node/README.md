# Stunt PVE Node — Integration Test Infrastructure

A local Proxmox VE 9 virtual machine for end-to-end testing of ANAS against real ZFS, SMB, and NFS.

## Host Requirements

- **OS:** Fedora 43+ (other Linux distros may work)
- **Packages:** qemu-kvm, libvirt, virt-install, genisoimage
- **Resources:** ~50 GB disk, 8 GB RAM for the VM
- **Network:** Internet access for cloud image and package downloads

## Quick Start

```bash
# 1. One-time host setup (packages, libvirt, network)
./test/stunt-node/setup-host.sh

# 2. Log out and back in (for libvirt group membership)

# 3. Create the VM (cloud-init, boots in ~1 min)
./test/stunt-node/create-vm.sh

# 4. Install Proxmox VE (packages + config, ~15-20 min)
./test/stunt-node/provision.sh

# 5. Deploy ANAS
./test/stunt-node/deploy-anas.sh

# 6. Take baseline snapshot
./test/stunt-node/snapshot.sh baseline

# 7. Run integration tests
npx playwright test --project=integration
```

## How It Works

The VM is built from a Debian 13 (Trixie) cloud image, configured via cloud-init
for static IP and SSH access. Provisioning installs Proxmox VE 9 on top.

No data disks are attached at boot — they're created on demand by `add-disk.sh`
and `setup-test-data.sh` when needed for ZFS testing.

## Network

The VM runs on an isolated NAT network (`anas-test`, 192.168.200.0/24).

| Service | Address |
|---------|---------|
| SSH | `ssh root@192.168.200.50` (password: `anas-test`) |
| PVE Web UI | `https://192.168.200.50:8006` |
| ANAS | `https://192.168.200.50:3000` (PVE cert, log into PVE first) |
| SMB | `smbclient //192.168.200.50/share` |
| NFS | `mount 192.168.200.50:/export /mnt` |

## Scripts

| Script | Purpose |
|--------|---------|
| `setup-host.sh` | One-time host setup |
| `create-vm.sh` | Create VM from cloud image + cloud-init |
| `provision.sh` | Install PVE 9 + deps, take `bare` snapshot |
| `start.sh` | Start VM, wait for SSH |
| `stop.sh` | Graceful shutdown (30s timeout, then force) |
| `ssh.sh` | SSH into the VM |
| `snapshot.sh <name>` | Take offline snapshot |
| `restore.sh <name>` | Restore snapshot + start VM |
| `add-disk.sh <1\|2\|3>` | Create + hot-attach a disk (512M, on demand) |
| `remove-disk.sh <1\|2\|3>` | Hot-detach a disk |
| `deploy-anas.sh` | Build + rsync + restart services |
| `setup-test-data.sh` | Attach disks + create test pool and shares |
| `run-tests.sh` | Full workflow: restore → deploy → test |
| `destroy-vm.sh` | Delete VM + all disk images |

## Snapshots

| Name | Contents | When to restore |
|------|----------|-----------------|
| `bare` | Debian 13 + PVE 9 + deps, no ANAS | Re-provisioning |
| `baseline` | PVE + ANAS, no test data | Most test runs |
| `test-ready` | baseline + test pool/shares | Tests needing existing storage |

Snapshots are taken offline for full disk consistency.

## Integration Tests

Playwright runs on the **host** and drives a headless browser against the VM.

```bash
# Run all integration tests
npx playwright test --project=integration

# Run specific test
npx playwright test tests/integration/auth.spec.ts --project=integration

# Hot-plug test workflow
./test/stunt-node/add-disk.sh 1
npx playwright test tests/integration/disks/ --project=integration
./test/stunt-node/remove-disk.sh 1
```

### One-command test run

```bash
./test/stunt-node/run-tests.sh
```

Restores the baseline snapshot, deploys current code, and runs Playwright.

## Cleanup

```bash
# Delete VM and all disk images
./test/stunt-node/destroy-vm.sh

# Remove network (optional)
sudo virsh net-destroy anas-test && sudo virsh net-undefine anas-test
```

## Security

- Root password is `anas-test` — test credential only
- VM is on an isolated NAT network (host-only access)
- `config.local` is gitignored (developer-specific paths)
