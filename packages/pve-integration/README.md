# ANAS — Proxmox VE UI Integration

This package makes ANAS appear as a native-feeling section inside the Proxmox
web UI, modeled on how PVE presents **Ceph**: a collapsible group in the
**node** menu whose items (Dashboard, Pools, Disks) render in the content area.

```
Node "pve1"
├─ Summary / Shell / System / Disks ...   (PVE's own)
└─ ANAS                                    (collapsible section, injected)
   ├─ Dashboard   → iframe /?embedded=1
   ├─ Pools       → iframe /storage/pools?embedded=1
   └─ Disks       → iframe /storage/disks?embedded=1
```

## Why this exists / why it looks like this

PVE 9 has **no official UI extension hook**. See `docs/DESIGN.md` → *PVE UI
Integration* for the authoritative contract. Verified facts (PVE 9.2):

- `pveproxy` serves unowned files dropped into `/usr/share/pve-manager/js/`.
  dpkg never removes files it does not own, so our script survives upgrades.
- The PVE UI page sends no CSP or `X-Frame-Options`, so a same-origin injected
  script and cross-port iframes work.
- `PVEAuthCookie` is set by PVE's own JS, is **not** HttpOnly (readable by page
  JS), and tickets are **cluster-valid** (any node verifies them).

## Files

| File            | Role                                                                 |
| --------------- | -------------------------------------------------------------------- |
| `anas.js`       | ExtJS integration script. Our file. Copied to `/usr/share/pve-manager/js/anas.js`, served at `/pve2/js/anas.js`. |
| `install.sh`    | Idempotent installer (see below).                                    |
| `uninstall.sh`  | Surgical uninstaller — restores the pristine template.               |

## Mechanism

Two moving parts:

1. **`/usr/share/pve-manager/js/anas.js`** — our script. Upgrade-safe (dpkg
   doesn't own it). It uses `Ext.override(PVE.node.Config, ...)` to run after
   the node menu is built, then appends an `ANAS` group (with Dashboard / Pools
   / Disks child panels) to the menu's tree store and card registry — the same
   structure `PVE.panel.Config` builds for Ceph. Every ExtJS/PVE internal it
   touches is feature-detected and everything is wrapped in try/catch:
   **it fails open**. Worst case is "no ANAS section appears"; the PVE UI is
   never broken.

2. **One `<script>` line in `/usr/share/pve-manager/index.html.tpl`**, inserted
   immediately after the `pvemanagerlib.js` line:

   ```html
   <script type="text/javascript" src="/pve2/js/anas.js"></script>
   ```

### The single fragile point

**pve-manager upgrades overwrite `index.html.tpl`**, dropping our line. This is
the one fragile point in the whole integration. Mitigations:

- The insert is **idempotent** — presence-checked by grepping for the exact
  `src="/pve2/js/anas.js"`, with **no marker comments** (PRINCIPLES #12: we
  don't tag the host's files).
- An **apt hook** at `/etc/apt/apt.conf.d/80anas-pve-integration` adds a
  `DPkg::Post-Invoke` command that re-runs `install.sh` after every dpkg
  transaction, re-applying the line after a pve-manager upgrade.
- `uninstall.sh` removes **only** our line (matched by its exact `src`),
  leaving the rest of the template byte-for-byte pristine.

If the line is ever lost between an upgrade and the next apt run, the only
symptom is that the ANAS section disappears until `install.sh` runs again — PVE
itself keeps working.

## Ticket handoff (cross-node auth)

`PVEAuthCookie` is host-scoped: logged into node A's UI, the browser has no
cookie for node B's ANAS (`https://<node>:3000`). `anas.js` implements the
parent side of the postMessage handshake described in `docs/DESIGN.md`:

1. A menu item renders an iframe `https://<node>:3000/auth/handoff?to=<route>`.
2. The ANAS handoff page posts `{ type: 'anas:handoff:ready' }` to its parent.
3. `anas.js` verifies `event.origin` is an ANAS iframe origin **it created**,
   reads `PVEAuthCookie` via `document.cookie`, and replies
   `{ type: 'anas:handoff:ticket', ticket }` with `targetOrigin` set to that
   same (validated) origin.
4. The handoff page verifies the sender origin, sets the cookie on its own
   origin, and redirects to the target route.

The ticket is only ever posted to an origin ANAS itself opened an iframe for —
never to an arbitrary sender.

Node addressing: when the selected tree node is the one serving the PVE UI
(`Proxmox.NodeName`), the iframe uses `window.location.hostname` (preserving
IP-based access); otherwise it uses the node name.

## Install / uninstall

```bash
sudo ./install.sh      # copy anas.js, insert tpl line, install apt hook
sudo ./uninstall.sh    # remove tpl line, anas.js, apt hook
```

Both scripts are `set -euo pipefail` and parameterise their paths (with
production defaults) so the template logic can be exercised against a copy
without a real PVE install:

```bash
PVE_TPL=/tmp/t/index.html.tpl \
PVE_JS_DIR=/tmp/t/js \
APT_HOOK=/tmp/t/hook \
./install.sh
```

Installation on the stunt node is wired into
`test/stunt-node/deploy-anas.sh` (runs `install.sh` remotely after the ANAS
services are up).
