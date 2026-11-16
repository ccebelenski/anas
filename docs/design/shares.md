# SMB shares and NFS exports

## SMB Shares

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/shares/smb` | List all SMB shares (including non-ANAS) | `200` |
| `POST` | `/v1/shares/smb` | Create a share | `202` with job |
| `GET` | `/v1/shares/smb/global` | SMB global config | `200` |
| `PUT` | `/v1/shares/smb/global` | Update global config | `202` with job |
| `GET` | `/v1/shares/smb/:name` | Share detail (config + active connections) | `200` |
| `PUT` | `/v1/shares/smb/:name` | Update share config | `202` with job |
| `DELETE` | `/v1/shares/smb/:name` | Remove a share | `202`/`409` |
| `GET` | `/v1/shares/smb/:name/access` | The Permissions editor on the share's path (access.1) — `DatasetAccess` + `backing` | `200` |
| `PUT` | `/v1/shares/smb/:name/access` | Set it — `SetAccessRequest`, the same `fs.setAccess` job | `202` with job / `400`/`409` |

**Share-path grant (access.1, GitHub #75).** `POST`/`PUT /v1/shares/smb` take an optional `grantAccess: {applyToExisting?}`; present, the share job — after the `smb.conf` write and reload — runs the Permissions editor's writer on the share path with the form pre-filled: each `valid users` principal (`@`/`+`/`&` = group; `%` macros and names `getent` cannot resolve are skipped and listed) gets a named entry at Read-Write, Read on a read-only share; guest access gives Everyone the same level; owner/group untouched; every existing named entry kept and never lowered; access + default ACL. On an edit it runs only when the principal set, guest flag, read-only flag or path changed (or `applyToExisting` asks). `applyToExisting: true` is confirm-gated on the create/edit itself — `409` + `X-Anas-Confirm-Code` before anything is written, the same confirm the editor's recursive PUT carries (operator ruling 2026-10-11). The share is created or updated whatever the grant answers: its outcome (`ShareAccessGrantResult`: applied / refused with the gate's sentence / failed / nothing) rides on the job result as `grant`. Nothing is ever revoked — removing a principal or deleting the share leaves the path's ACL as it is (the filesystem carries no record of who wrote an entry).

## NFS Exports

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/shares/nfs` | List all NFS exports (including non-ANAS) | `200` |
| `POST` | `/v1/shares/nfs` | Create an export | `202` with job |
| `GET` | `/v1/shares/nfs/:path` | Export detail (path is URL-encoded) | `200` |
| `PUT` | `/v1/shares/nfs/:path` | Update export config | `202` with job |
| `DELETE` | `/v1/shares/nfs/:path` | Remove an export | `202`/`409` |
| `GET` | `/v1/shares/nfs/:path/access` | The Permissions editor on the export's path (access.1). An export has no principal list, so there is no automatic grant — this is the after-the-fact editor | `200` |
| `PUT` | `/v1/shares/nfs/:path/access` | Set it — `SetAccessRequest`, the same `fs.setAccess` job | `202` with job / `400`/`409` |
