# ZFS pools

## ZFS Pools

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/v1/pools` | List all pools; on a node where ZFS is not available (no `zpool` command, or the zfs module not loaded) `[]` with `zfsUnavailable: <statement>` beside `data`; a list that could not be read answers `503` (`The pools could not be listed: <why>`) and is never read as no pools | `200` / `503` |
| `POST` | `/v1/pools` | Create a pool | `202` with job |
| `GET` | `/v1/pools/:name` | Pool detail (status, vdevs, properties); `404` only when both `zpool list` and `zpool status` answered without the pool; a read that failed, or two that disagree, is `503`; ZFS not available on the node is `409` with reason `zfs-unavailable` | `200` / `404` / `409` / `503` |
| `PUT` | `/v1/pools/:name` | Update pool properties | `202` with job |
| `DELETE` | `/v1/pools/:name` | Destroy a pool | `202`/`409` |
| `POST` | `/v1/pools/:name/scrub` | Start a scrub | `202` with job |
| `POST` | `/v1/pools/:name/export` | Export a pool | `202`/`409` |
| `POST` | `/v1/pools/:name/vdevs` | Add a vdev (`AddVdevRequest`: role data/log/cache/spare/special/dedup + type + whole disks) — `zpool add` (3.21/3.23) | `202` with job |
| `POST` | `/v1/pools/:name/vdevs/remove` | Remove a **cache, log or spare** vdev (`{ vdev }`: a leaf named by its device-path basename — `ata-SSD-part2`, `sdb3` — or a log `mirror-N`) — `zpool remove`, instant, no evacuation; `400` for data/special/dedup vdevs (evacuation is a different operation ANAS does not offer), a vdev the pool does not carry, a name that fits more than one leaf (a split by-id device), or a spare ZFS has put to work; plain job, no confirm code (vdevs.2, #66) | `202`/`400` |
| `POST` | `/v1/pools/import` | Import a pool (on collection — pool isn't ours yet) | `202` with job |

**Reshaping a pool's topology** — both vdev routes above, and since cr.36 the attach / replace / raidz-expand route, stand behind ONE pre-flight, run at the request and again in the job (ruling (j)): the system-pool `409` (the pool holding this node's boot filesystem, no bypass), then the PVE-ownership `409 PVE_MANAGED` (the answer every pool verb gives for a pool PVE uses — a `400` before cr.36). PVE owns the topology of the pools it manages, and adding a vdev reshapes a pool exactly as removing one does (pvepool.1).
