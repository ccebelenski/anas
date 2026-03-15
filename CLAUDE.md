# ANAS Development Guide

## Before writing any code

1. Read `docs/PRINCIPLES.md` — these are non-negotiable. If your planned change conflicts with a principle, stop and discuss with the user.
2. Read `docs/EPICS.md` — only implement work that traces to a story. If it's not in a story, it's not in scope.
3. Read `docs/DESIGN.md` — the architecture, API, and tech stack are decided. Do not introduce new dependencies, change the API shape, or alter the architecture without discussion.

## Key decisions (do not revisit without discussion)

- Two processes: anas (Nuxt 3) + anasd (Fastify), both as root
- REST over Unix socket, versioned /v1/
- Shared Zod schemas in packages/shared/
- PrimeVue for UI, no Tailwind
- PVE auth primary, PAM fallback, Dev for testing
- All mutations are jobs (202 Accepted)
- Safety: 409 with X-Anas-Confirm-Code for dangerous ops
- Config files are the API — surgical editing, never overwrite
- Stateless — no shadow state, system is the source of truth
- Structured CLI output (JSON/-j preferred, -Hp fallback)
- journald for audit logging
- Guest philosophy — we don't own the system

## When implementing a story

- Identify which epic and story number you're working on
- Check the API resource model in DESIGN.md for the correct endpoints
- Use shared Zod schemas — do not define types inline
- Use execFile, never exec — arguments as arrays
- Validate at both boundaries (Nuxt and anasd)
- Service reloads are side effects of mutations, not separate API calls

## Do not

- Add dependencies without discussing first
- Create new API endpoints not in the design
- Add features not in a story
- Parse human-readable command output when structured output exists
- Build notification/alerting systems (Proxmox handles this)
- Build user management beyond what's needed for share access
- Add roles, permissions, or authorization logic — auth is binary
- Create custom log files — use journald
