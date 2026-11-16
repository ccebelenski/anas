# Authentication and authorization

## Authentication & Authorization

### Authentication

ANAS is always accessed through Proxmox UI — Proxmox owns the session.

| Provider | When | How |
|----------|------|-----|
| `PveAuthProvider` | Production (default) | Believes only the `X-Anas-Auth` statement `AnasProxy.pm` signs inside pveproxy — no ticket parsing, no network calls (cr.27) |
| `DevAuthProvider` | Development & testing | Accepts everything, returns a mock user holding both privileges |

- **No login page** — users are already authenticated via Proxmox
- **No JWT / session store** — PVEAuthCookie is the credential, validated by PVE on each request
- **No PAM fallback** — standalone access outside Proxmox is not a supported path
- **Session expiry & logout** — managed by Proxmox
- **Who and what, inside pveproxy** (cr.27, `docs/WAVE2-DESIGN.md` §2): `AnasProxy.pm` calls PVE's own
  `auth_handler` — the method pveproxy calls for `/api2` — which checks the ticket, that the user exists and is
  enabled, the TFA state and, for every method but GET, the `CSRFPreventionToken`; then `$rpcenv->check` answers
  which of `Sys.Audit` / `Sys.Modify` PVE grants on `/`. It removes any client-supplied `X-Anas-Auth` and adds
  `X-Anas-Auth: v1;user=<userid>;privs=<list>;ts=<epoch>;mac=<hex>`, an HMAC-SHA256 over the user (percent-encoded),
  the privileges, the timestamp, the method and the forwarded path. PVE API tokens are refused ("PVE API tokens are
  not accepted by ANAS"). The hook refuses to serve inside pvedaemon (`:85`, root, `trusted_env`), where PVE skips
  the CSRF check. Every refusal is logged (journal unit `pveproxy`, `anas-proxy: refused …`), the access log names
  the user, and a 401 is delayed 3 s as PVE delays its own.
- **The hand-off key**: the gateway writes 32 random bytes to `/run/anas/proxy.key` (`root:www-data 0640`,
  atomically) at every start and refuses to start if it cannot; pveproxy's workers (www-data) read it. A runtime
  credential like the socket, rotated by a restart, never written by the installer.
- **Auth hook** (anas gateway): verifies the MAC (constant time), `|now − ts| ≤ 30 s` and that method and path match
  the request it received → attaches `{ name, uid, privileges }` → else 401 "This request did not come through
  pveproxy" with the failed check logged (`[authz] refused …`, journal unit `anas`). The gateway listens on loopback,
  where any local uid can reach it, so it trusts nothing unsigned.
- **Dev mode** (`ANAS_AUTH_PROVIDER=dev`): no pveproxy, no hand-off; a mock user with both privileges on every
  request; still refused on a real PVE node without `ANAS_ALLOW_INSECURE_DEV_AUTH=1`
- **Installer**: an upgrade that changes `AnasProxy.pm` reloads pveproxy, because a running worker keeps the module
  it loaded (F12)

Proxmox integration:
- Users logged into Proxmox UI are already authenticated to ANAS: the ANAS panels run inside the PVE UI page and reach the gateway same-origin through PVE's `:8006` under `/anas`, so the browser sends PVEAuthCookie automatically (the `Secure` cookie is satisfied by pveproxy's existing TLS — the gateway itself serves plain HTTP on loopback). Cross-node operations are forwarded server-side — the browser never contacts another node (see **PVE UI Integration**)
- The PVE web UI gains an ANAS section via an injected integration script (see **PVE UI Integration**). PVE 9 has no official UI extension hook — the previously assumed `/usr/share/pve-manager/js/custom.js` mechanism does not exist

Both services run as root — no dedicated service user.

### Authorization
*(Operator ruling 2026-10-14, built by cr.27; replaces "auth is binary".)* ANAS asks PVE the question PVE asks for
its own ZFS, LVM and directory disk verbs: **`Sys.Audit` on `/` to read, `Sys.Modify` on `/` to change.**
- **The rule is the method:** GET and HEAD need `Sys.Audit`; POST, PUT, DELETE and PATCH need `Sys.Modify`. No
  route table — a new route needs no row. One exception (cr.67, operator ruling 2026-10-17): a POST whose
  daemon-side path starts a READ job — `/cloud/tasks/preview`, `/cloud/remotes/test`, `/backup/restore/browse`,
  and `POST /jobs/<id>/cancel` (job id matched, never a bare wildcard) — needs `Sys.Audit` at the gateway; the
  daemon's job queue (`jobs/authority.ts`) stays the authority on a cancel, so cancelling a non-read job still
  answers 403 naming `Sys.Modify` from the daemon, which no gateway-side rule could know. `GET /installed` is
  the only unauthenticated route.
- **PVE answers, the gateway decides:** the privileges come from PVE's `$rpcenv->check` inside pveproxy (roles,
  groups, `--propagate 0`, pools — PVE's compile, PVE's definedness rule); the gateway applies the rule once.
- **A refusal is a 403 `FORBIDDEN`** naming the privilege and the path: "Permission check failed (/, Sys.Modify):
  alice@pve does not have it. ANAS asks the privilege PVE asks for its own disk and ZFS operations." The panel shows
  "You need Sys.Audit on / to view ANAS on this node" when the install probe is refused.
- **What it means for operators:** `PVEAuditor`, `PVESysAdmin` and `PVEAdmin` on `/` can view and change nothing;
  `Administrator` (or a custom role with `Sys.Modify`) on `/` can change. A grant on `/nodes/<node>` alone opens
  nothing, exactly where PVE's own ZFS create refuses. root@pam passes every check.
- **No ANAS roles, no permission matrix.** User identity (with realm) is propagated to anasd for the audit log.

---
