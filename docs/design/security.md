# Security considerations

## Security Considerations

### Attack surface minimization
- The gateway never executes system commands — all mutations go through anasd's REST API
- anasd only accepts structured REST operations, never raw commands
- Unix socket (not TCP) — only local processes can reach anasd
- Both processes run as root (like Proxmox) — the API contract is the security boundary

### Input validation layers (defense in depth)
1. **UI panels** — client-side validation for UX (not security)
2. **anas gateway** — authenticates the caller, checks the PVE privilege (`Sys.Audit` / `Sys.Modify`) and forwards the request body unparsed; it does not validate against the schemas (operator ruling 2026-11-14: anasd is the schema boundary)
3. **anasd** — validates parameters using the same shared Zod schemas before execution

Shared schemas mean validation is defined once and enforced at anasd, the schema boundary.

### Authentication & audit chain
The identity headers anasd accepts are exactly `RequestHeaders` in `packages/shared/src/schemas/api.ts` (the
original design named `X-Anas-UID` / `X-Anas-Groups` — there is no groups header; `x-anas-privileges` was added
by cr.28):
```
Browser ──cookie──→ gateway ──x-anas-user──────→ anasd ──audit log──→ journald
                           x-anas-user-uid
                           x-anas-privileges
                           x-anas-request-id
```
- User identity and the PVE grants propagated on every request to anasd
- A user id that is not plain printable ASCII, or holds a `%`, is sent percent-encoded as UTF-8 with `x-anas-user-encoding: percent-utf8`; anasd decodes it before anything reads `x-anas-user`. A user header that does not decode, is empty, or carries a control character or line separator is removed, and the request is then refused as naming no user
- `x-anas-privileges` is REQUIRED (cr.28): a request without it, or with one that does not parse, is refused —
  fail closed, no "absent means trusted"; the Unix socket's access control bounds who can send it, it does not
  make the headers trusted by presence
- anasd logs every mutating operation with user, operation, params, and result
- Request ID enables end-to-end correlation across both services

### Command injection prevention
- `execFile` (not `exec`) — no shell interpretation
- Arguments passed as arrays, never interpolated into strings
- Parameter values validated against strict patterns (Zod schemas)
- anasd command whitelist — only known operations can be executed

### Session security
- Proxmox owns the session: PVEAuthCookie lifetime, renewal, and logout are PVE's
- ANAS is served same-origin under `:8006/anas`, so there is no CORS surface — the cookie flows automatically and cross-origin requests are impossible by construction
- State-changing requests are same-site by construction (panels run in the PVE page)

---
