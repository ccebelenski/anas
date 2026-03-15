# ANAS — Design Principles

These principles were established during initial design and govern all subsequent design decisions, implementation details, and feature additions. Deviating from these principles requires explicit, deliberate discussion — not gradual drift.

---

## 1. Two-process architectural separation

The system is two processes: a web application (anas) and a system daemon (anasd). Both run as root. The separation is architectural, not privilege-based — it provides a clean API boundary, a centralized audit point, a non-blocking job queue, and a path to multi-node management. No web-facing code runs in the daemon process. No system command execution happens in the web process. This boundary is absolute.

## 2. Formal REST API as the internal contract

Communication between anas and anasd is REST over a Unix domain socket. Standard HTTP methods, standard status codes, standard content types. No custom wire protocols, no RPC shortcuts, no "just call the function directly." The API is versioned (`/v1/`). If the transport changes later (e.g., TCP for multi-node), the API does not.

## 3. Authentication propagates end-to-end

Every request from anas to anasd carries the authenticated user's identity. anasd never executes an operation without knowing who requested it. This enables audit logging, traceability, and future authorization enforcement at the daemon layer. The auth chain is: browser → session cookie → Nuxt → identity headers → anasd → audit log.

## 4. All mutations are jobs

Every state-changing operation returns `202 Accepted` with a job reference. The frontend never blocks on a mutation. This is true whether the operation takes 50ms or 5 hours. The job queue is the single mechanism for mutations — no exceptions, no "fast path" that bypasses it.

## 5. Command whitelist, not command passthrough

anasd does not accept arbitrary commands. It accepts structured operations with validated parameters and maps them to specific system commands internally. The API surface defines what the system can do. If it's not in the API, it can't be done through ANAS.

## 6. Shared schemas, validated at every boundary

Request and response types are defined once (Zod) and shared between anas and anasd. Validation happens at both boundaries — Nuxt validates incoming user input, anasd validates before execution. This is defense in depth, not redundancy.

## 7. Lightweight by design

This runs on Proxmox hosts that are already doing real work. Minimal memory footprint, minimal dependencies, minimal background activity. When no user is connected, the system does effectively nothing. We do not add background services, pollers, or schedulers without explicit justification.

## 8. Single-package deployment

The entire system ships as one npm package. `npm install -g anas` gets you everything. `sudo anas setup` configures systemd units and permissions. The install experience is simple and repeatable. We do not introduce build steps, external binaries, platform-specific compilation, or dedicated service users into the deployment path.

## 9. Unix socket, not TCP, for internal IPC

anasd listens on a Unix domain socket, not a TCP port. This means only local processes can reach it, and access is controlled by filesystem permissions. This is a security boundary, not a convenience choice. If multi-node support is added later, it gets its own transport layer — the socket assumption is not relaxed.

## 10. Proxmox for authentication, system users for identity

We do not maintain our own user database or session management. Users authenticate via Proxmox (PVEAuthCookie) — ANAS is always accessed through the Proxmox UI. If you're logged in, you can do everything — auth is binary, no roles or permission matrix. Share access requires real system users with real UIDs/GIDs. We manage users through standard system tools, not a parallel identity system.

## 11. Stateless — the system is the source of truth

ANAS does not maintain its own state about what it has created or manages. The system config files (smb.conf, /etc/exports, ZFS properties) are the source of truth. ANAS reads them, understands them, presents them, and makes surgical changes to them. It does not keep a shadow database of "things ANAS manages" vs "things that were already there." If it exists in the config, ANAS can see it and manage it, regardless of who created it.

## 12. Guest, not owner

ANAS is a guest on the Proxmox system. It does not own the OS, the config files, or the services it manages. It makes surgical, targeted changes to system config files (smb.conf, /etc/exports) — modifying only what it needs to, preserving everything else verbatim. It does not overwrite files, use marker comments, or assume it's the only thing managing the system. The system was here before ANAS and will be here after.

## 13. Structured output and config files are the API

Two sources of truth: command output (structured) for runtime state, config files for persistent configuration. Use JSON (`-j`) or machine-parseable (`-Hp`) output from CLI tools — never parse human-readable output when a structured alternative exists. Config files (smb.conf, /etc/exports, /etc/fstab) are not something we read *through* an API — they *are* the API. We read them, understand their full structure, and make surgical edits.

## 14. Safety through the API, not the frontend

The API is the authority on what is safe, what is risky, and what is forbidden. The frontend does not contain safety logic — it handles standard HTTP status codes. Both blocked and confirmation-required operations return `409 Conflict`. Blocked operations (destroy root pool, delete boot disk) have no override. Risky operations (destroy pool with active shares, remove export with connected clients) include an `X-Anas-Confirm-Code` response header — the client resends with the code to proceed. A client that doesn't understand the confirmation system just sees 409 and stops. anasd generates, verifies, and expires the codes. No safety logic in the frontend, no custom status codes, no cheating from the client.

## 15. Leverage the host, don't duplicate it

Where Proxmox (or the underlying OS) provides infrastructure, use it. TLS certificates, journald logging, the notification system — these already exist, are already configured, and are already trusted by the user. Building parallel systems wastes resources and creates configuration burden. ANAS integrates with the host rather than replacing its capabilities.

---

## How to use this document

- **Before adding a feature:** Does it conform to these principles? If not, stop and discuss.
- **Before refactoring:** Will the refactoring preserve these principles? If it weakens one, that's a design discussion, not an implementation detail.
- **When in doubt:** Re-read principle 7. If the answer to "do we need this?" isn't clearly yes, the answer is no.
