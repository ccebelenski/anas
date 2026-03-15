# Contributing to ANAS

## Prerequisites

- Node.js 22+
- npm 10+

## Setup

```bash
git clone <repo-url> && cd anas
npm install
```

## Development

Start the full stack (daemon + web) with one command:

```bash
npm run dev
```

This runs:
- **anasd** on `/tmp/anasd.sock` in mock mode (no real ZFS/SMB/NFS commands)
- **Nuxt dev server** on `http://localhost:3000` with dev auth (no Proxmox needed)

Both processes hot-reload on file changes. Ctrl-C stops everything.

### Running processes individually

```bash
npm run dev:daemon    # anasd only (mock mode, /tmp/anasd.sock)
npm run dev:web       # Nuxt only (dev auth, localhost:3000)
```

### Talking to anasd directly

```bash
curl -s --unix-socket /tmp/anasd.sock http://localhost/v1/health
curl -s --unix-socket /tmp/anasd.sock http://localhost/v1/jobs
```

## Building

```bash
npm run build         # Build everything
npm run build:daemon  # Daemon only (tsc → dist/)
npm run build:web     # Nuxt only (.output/)
```

## Quality checks

```bash
npm run lint          # ESLint
npm run lint:fix      # ESLint with auto-fix
npm run typecheck     # Type-check all packages (shared, daemon, web)
```

These all run in CI on push/PR to main.

## Project structure

```
packages/
├── shared/     @anas/shared — Zod schemas, validators, types
│                 Imported by both daemon and web. No build step.
├── daemon/     @anas/daemon — Fastify server on Unix socket
│                 Job queue, command executor, audit logging.
│                 Dev: tsx watch. Prod: tsc → node dist/index.js
└── web/        @anas/web — Nuxt 3 app (SSR + API routes)
                  PrimeVue UI, auth middleware, anasd REST client.
                  Dev: nuxi dev. Prod: nuxi build → .output/
```

## Architecture

Two processes, one npm package:

```
Browser → ANAS (Nuxt 3, port 3000) → anasd (Fastify, Unix socket)
```

- **anas** handles the UI, authentication, and proxies to anasd
- **anasd** handles system commands, job queue, and audit logging
- Shared Zod schemas validate at both boundaries
- All mutations go through the job queue (202 Accepted)

See `docs/DESIGN.md` for the full architecture and API reference.
See `docs/PRINCIPLES.md` for non-negotiable design principles.
See `docs/EPICS.md` for the story backlog.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANAS_AUTH_PROVIDER` | *(auto)* | `dev` for development, `pve` for production |
| `ANASD_SOCKET` | `/run/anas/anasd.sock` | Unix socket path (`/tmp/anasd.sock` in dev) |
