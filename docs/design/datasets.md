# ZFS datasets and snapshots

## ZFS Datasets (nested under pools)

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/pools/:name/datasets` | List/tree of datasets in pool | `200` |
| `POST` | `/v1/pools/:name/datasets` | Create a dataset | `202` with job |
| `GET` | `/v1/pools/:name/datasets/*path` | Dataset detail, properties, associated shares | `200` |
| `PUT` | `/v1/pools/:name/datasets/*path` | Update dataset properties | `202` with job |
| `DELETE` | `/v1/pools/:name/datasets/*path` | Destroy a dataset | `202`/`409` |

**Volumes (iscsi epic, 2026-08-25):** a dataset of `type: volume` is first-class in the same resource — `POST` accepts `{type: 'volume', volsize, volblocksize, sparse}`; `PUT` may grow `volsize` — carried under `properties` like every other ZFS property (`zfs set volsize=`) — (live under a LUN — the initiator rescans) but a shrink, a rename, or a rollback of a volume referenced by a LUN is refused (ZFS lets all three through silently). Volumes have no mountpoint and cannot be shared; PVE-owned `vm-*` zvols stay hands-off.

## ZFS Snapshots (nested under datasets)

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/pools/:name/datasets/*path/snapshots` | List snapshots, newest first in the order ZFS took them (`createtxg`); a listing that could not be read answers `503` | `200` / `503` |
| `POST` | `/v1/pools/:name/datasets/*path/snapshots` | Create a snapshot | `202` with job |
| `GET` | `/v1/pools/:name/datasets/*path/snapshots/:snap` | Snapshot detail | `200` |
| `PUT` | `/v1/pools/:name/datasets/*path/snapshots/:snap` | Rename a snapshot | `202` with job |
| `DELETE` | `/v1/pools/:name/datasets/*path/snapshots/:snap` | Destroy a snapshot | `202` with job |
| `POST` | `/v1/pools/:name/datasets/*path/snapshots/:snap/rollback` | Rollback to snapshot | `202`/`409` |
