# Contributing to ANAS

## Prerequisites

- Node.js 22+
- npm 10+

## Setup

```bash
git clone https://github.com/ccebelenski/anas.git && cd anas
npm install
```

## Development

Start the full stack (daemon + gateway) with one command:

```bash
npm run dev
```

This runs:
- **anasd** on `/tmp/anasd.sock` in mock mode (no real ZFS/SMB/NFS commands)
- **anas gateway** on `http://localhost:3100` with dev auth (no Proxmox needed)

Both processes hot-reload on file changes. Ctrl-C stops everything.

### Running processes individually

```bash
npm run dev:daemon    # anasd only (mock mode, /tmp/anasd.sock)
npm run dev:gateway   # gateway only (dev auth, localhost:3100)
```

### Talking to anasd directly

```bash
curl -s --unix-socket /tmp/anasd.sock http://localhost/v1/health
curl -s --unix-socket /tmp/anasd.sock http://localhost/v1/jobs
```

## Building

```bash
npm run build           # Build everything (shared → daemon → gateway)
npm run build:daemon    # One workspace (also :shared, :gateway)
```

## Quality checks

```bash
npm run lint          # ESLint
npm run lint:fix      # ESLint with auto-fix
npm run typecheck     # Type-check all packages (shared, daemon, gateway)
npm run test:unit     # Unit tests (daemon + gateway)
```

### Integration tests (stunt node)

End-to-end tests run against a disposable "stunt" PVE node (a VM provisioned
by the scripts in `test/stunt-node/`) and drive the real UI with Playwright:

```bash
npm run test:stunt-deploy   # deploy the working tree to the stunt node
npm run test:integration    # Playwright integration suite
```

## Project structure

```
packages/
├── shared/          @anas/shared — Zod schemas, validators, types, VERSION.
│                      Imported by daemon and gateway.
├── daemon/          @anas/daemon — anasd: Fastify on a Unix socket.
│                      Parsers, command executor, job queue, audit logging.
├── gateway/         @anas/gateway — anas: Fastify HTTPS gateway (:3000).
│                      PVE ticket verification, validation, node routing.
└── pve-integration/ ExtJS panels injected into the PVE web UI (Ceph model),
                       plus the inject/eject scripts.
packaging/           Release tarball build, versioning, and the transactional
                       installer. See packaging/README.md.
docs/                DESIGN.md (architecture/API), PRINCIPLES.md
                       (non-negotiable), EPICS.md (story backlog).
```

## Architecture

Two processes:

```
Browser — PVE web UI (:8006, ANAS panels injected)
   → anas gateway (HTTPS :3000, PVE ticket auth)
      → anasd (REST over /run/anas/anasd.sock)
```

- **anas** verifies the PVE ticket, validates input, and routes to the right
  node's daemon
- **anasd** executes whitelisted system commands, runs the job queue, and
  audit-logs to journald
- Shared Zod schemas validate at both boundaries
- All mutations go through the job queue (202 Accepted)

Before writing code, read `docs/PRINCIPLES.md` — the principles are
non-negotiable — and find the story in `docs/EPICS.md` your change traces to.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANAS_AUTH_PROVIDER` | *(auto)* | `dev` for development, `pve` for production |
| `ANAS_PORT` | `3000` | Gateway port (`3100` in dev) |
| `ANASD_SOCKET` | `/run/anas/anasd.sock` | Unix socket path (`/tmp/anasd.sock` in dev) |

## License

ANAS is licensed under AGPL-3.0-or-later. By contributing, you agree that
your contributions are licensed under the same terms.
