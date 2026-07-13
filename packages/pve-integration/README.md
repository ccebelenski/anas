# ANAS — Proxmox VE UI Integration

This package makes ANAS a **native** section inside the Proxmox web UI, modeled
on how PVE presents **Ceph**: a collapsible group in the **node** menu whose
items (Dashboard, Pools, Disks) render as native ExtJS panels in the content
area. There is no separate web app and no iframe — the panels talk directly to
the ANAS gateway on the same host (`https://<host>:3000`), and `PVEAuthCookie`
flows automatically because cookies ignore ports.

```
Node "pve1"
├─ Summary / Shell / System / Disks ...   (PVE's own)
└─ ANAS                                    (collapsible section, injected)
   ├─ Dashboard   → native ExtJS panel
   ├─ Pools       → native ExtJS grid + detail window
   └─ Disks       → native ExtJS grid + SMART window
```

## Why this exists / why it looks like this

PVE 9 has **no official UI extension hook**. See `docs/DESIGN.md` → *PVE UI
Integration* and *UI: Native PVE Panels* for the authoritative contract.
Verified facts (PVE 9.2):

- `pveproxy` serves unowned files dropped into `/usr/share/pve-manager/js/`.
  dpkg never removes files it does not own, so our script survives upgrades.
- The PVE UI page sends no CSP headers, so a same-origin injected script works.
- `PVEAuthCookie` is set by PVE's own JS with `Secure` + `SameSite=Lax` and
  tickets are **cluster-valid** (any node verifies them). The gateway routes
  per-node server-side, so the browser only ever talks to the local host.

## Files

The installed `anas.js` is **generated** by concatenating the per-view ES5
sources in `src/` (lexical order), so there is no build step — plain files
joined verbatim.

| File                   | Role                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| `src/00-core.js`       | `window.ANAS` namespace, fail-open helpers, formatters, menu injection. |
| `src/10-api.js`        | `ANAS.api` gateway helper (`request`/`get`/`post`/`put`/`del`/`health`). |
| `src/20-notinstalled.js` | `ANAS.notInstalledPanel` + `ANAS.withInstallCheck` (the Ceph "not installed" probe). |
| `src/30-pools.js`      | Pools view (grid, detail window, Start Scrub via the job API).   |
| `src/40-disks.js`      | Disks view.                                                      |
| `src/50-dashboard.js`  | Dashboard view.                                                  |
| `src/90-register.js`   | Wires `ANAS.views` into the node menu in a fixed order.          |
| `install.sh`           | Idempotent installer — concatenates `src/*.js` → `/usr/share/pve-manager/js/anas.js` (served at `/pve2/js/anas.js`), inserts the tpl line, installs the apt hook. |
| `uninstall.sh`         | Surgical uninstaller — restores the pristine template.           |

## Mechanism

Two moving parts:

1. **`/usr/share/pve-manager/js/anas.js`** — our generated script. Upgrade-safe
   (dpkg doesn't own it). It patches `PVE.node.Config.prototype.initComponent`
   directly — the original is captured in a closure and called first, then our
   guarded injection appends an `ANAS` group (with the registered view panels)
   to the menu's tree store and card registry, the same structure
   `PVE.panel.Config` builds for Ceph. **Not `Ext.override`**: `callParent`
   inside a runtime override resolves against the override's absent class
   hierarchy and crashes node panel construction. Every ExtJS/PVE internal it
   touches is feature-detected and everything is wrapped in try/catch: **it
   fails open**. Worst case is "no ANAS section appears"; the PVE UI is never
   broken. Each view is wrapped in a health probe (`ANAS.withInstallCheck`) so a
   node without ANAS installed shows a friendly install hint instead.

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

## Cross-node auth

`PVEAuthCookie` is cluster-valid and, because cookies ignore ports, the browser
sends it to the local gateway (`https://<ui-host>:3000`) automatically. The
panels only ever call the **local** gateway; cross-node requests are forwarded
server-side by the gateway (node as a path parameter,
`/api/nodes/<node>/v1/...`). There is no browser-side ticket handoff — that
iframe-era mechanism was retired with the ExtJS-native pivot.

## Install / uninstall

```bash
sudo ./install.sh      # generate anas.js from src/, insert tpl line, install apt hook
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
