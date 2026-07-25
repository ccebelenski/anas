# ANAS packaging

Build a production `.tar.gz` release of ANAS and install it on a real Proxmox VE
node with a careful, transactional installer.

## Contents

| File | Purpose |
| --- | --- |
| `make-release.sh` | Builds the release tarball on the dev host. |
| `bump-version.mjs` | Bumps the version everywhere it lives, from one command. |
| `install.sh` | Transactional installer, runs on the target PVE node (shipped in the tarball). |
| `uninstall.sh` | Clean, idempotent removal (shipped in the tarball). |
| `systemd/anasd.service`, `systemd/anas.service` | The two systemd units. |

## Versioning (story 10.10)

The root `package.json` version is the **single source of truth**. To cut a new
version:

```sh
npm run version:bump -- 0.2.0   # syncs workspace package.jsons, the shared
                                # VERSION const, and package-lock.json
git commit -am "release: 0.2.0"
./packaging/make-release.sh     # verifies no drift, builds, tags v0.2.0
git push origin main v0.2.0
```

`make-release.sh` **refuses to build** if any version copy has drifted or (for a
real release) if the working tree is dirty, and tags `v<version>` at HEAD on
success. The installed node carries `/opt/anas/VERSION`, and the gateway/daemon
report the same version on their health/status endpoints.

> Ultimately GitHub Actions builds the release artifacts (tag push → CI runs
> make-release incl. the smoke test → tarball attached to the GitHub Release);
> `make-release.sh` stays as the shared local/CI build core.

## Build a release (on the dev host)

```sh
./packaging/make-release.sh          # real release: clean tree required, tags v<version>
./packaging/make-release.sh --dev    # iteration build: dirty tree OK, no tag
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

Open `https://<node-ip>:8006` — the normal Proxmox web UI. The ANAS panels
appear inside it as a native section (open a node to find them); there is no
separate app.

> **No separate certificate to trust.** ANAS's API is served through pveproxy on
> `:8006` under the `/anas` path (story 12.2), the same origin as the PVE UI you
> already use — so the browser's existing trust of `:8006` covers ANAS too. There
> is no `:3000` origin and no per-port certificate exception to accept: if the
> PVE web UI loads, ANAS does.

### Flags

| Flag | Effect |
| --- | --- |
| `--install-deps` | Auto-install `acl`, and Node.js ≥ 20 via NodeSource `setup_22.x` if missing/old. |
| `--yes`, `-y` | Non-interactive (assume yes). |
| `--prefix DIR` | Install location (default `/opt/anas`). Units are rewritten to match. |
| `--force` | Skip the ZFS ≥ 2.2 gate (ANAS needs `zpool -j` JSON output). |

### What install.sh does

1. **Preflight (mutates nothing, aborts early):** reports the version transition
   (fresh / reinstall / `upgrade X -> Y`; a **downgrade** warns and asks for
   confirmation); then root, PVE node, Node.js ≥ 20, ZFS ≥ 2.2, `acl`; warns on
   missing `smbd`/`exportfs` and on a busy `:3000`.
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
