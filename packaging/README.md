# ANAS packaging

Build a production `.tar.gz` release of ANAS and install it on a real Proxmox VE
node with a careful, transactional installer.

## Contents

| File | Purpose |
| --- | --- |
| `make-release.sh` | Builds the release tarball on the dev host. |
| `install.sh` | Transactional installer, runs on the target PVE node (shipped in the tarball). |
| `uninstall.sh` | Clean, idempotent removal (shipped in the tarball). |
| `systemd/anasd.service`, `systemd/anas.service` | The two systemd units. |

## Build a release (on the dev host)

```sh
./packaging/make-release.sh
```

This runs `npm run build`, assembles a staging tree, produces a **production-only**
`node_modules` (via `npm ci --omit=dev --ignore-scripts` — no playwright/tsc/tsx),
**smoke-tests** that the daemon and gateway actually boot on that pruned tree, and
writes:

```
dist-release/anas-<version>.tar.gz
```

The tarball untars to `anas-<version>/` containing `install.sh`, `uninstall.sh`,
`VERSION`, `systemd/`, and `app/` (which becomes `/opt/anas`).

## Install (on the target Proxmox VE node, as root)

```sh
tar xzf anas-<version>.tar.gz
cd anas-<version>
sudo ./install.sh            # add --install-deps on a fresh node
```

Open `https://<node-ip>:3000`. The ANAS panels appear inside the normal PVE web
UI (no separate app).

### Flags

| Flag | Effect |
| --- | --- |
| `--install-deps` | Auto-install `acl`, and Node.js ≥ 20 via NodeSource `setup_22.x` if missing/old. |
| `--yes`, `-y` | Non-interactive (assume yes). |
| `--prefix DIR` | Install location (default `/opt/anas`). Units are rewritten to match. |
| `--force` | Skip the ZFS ≥ 2.2 gate (ANAS needs `zpool -j` JSON output). |

### What install.sh does

1. **Preflight (mutates nothing, aborts early):** root, PVE node, Node.js ≥ 20,
   ZFS ≥ 2.2, `acl`; warns on missing `smbd`/`exportfs` and on a busy `:3000`.
2. **Transactional install:** back up any existing `/opt/anas`, copy the app,
   install + enable + start the units, **health-check** the gateway, then run the
   PVE UI injection. Any failure triggers a rollback that reverses every completed
   step and restores the previous install — leaving the node unchanged.
3. Idempotent: re-running is a clean in-place upgrade (never a duplicate unit or
   a double `<script>` line).

## Uninstall

```sh
sudo ./uninstall.sh          # or: sudo /opt/anas/../uninstall.sh --prefix /opt/anas
```

Stops/disables the services, reverts the PVE UI integration (restoring the
pristine `index.html.tpl`), removes the unit files, and deletes the prefix.

## Prerequisites (target node)

- Proxmox VE (provides `pveversion` and `/usr/share/pve-manager/index.html.tpl`).
- Node.js ≥ 20 (install with `--install-deps`, or NodeSource `setup_22.x`).
- ZFS ≥ 2.2.
- `acl` (auto-installed). Optional per-protocol: `samba` (SMB), `nfs-kernel-server` (NFS).
