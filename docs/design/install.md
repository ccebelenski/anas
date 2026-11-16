# Deployment and installation

## Deployment & Installation

### Target install experience

> **Retired 2026-10-14:** neither `npm install -g anas` nor `anas setup` was ever built — EPICS §5 rejects the npm-global install path. The install path is the release tarball and `./install.sh` (`packaging/install.sh`), which writes the units, socket dir and proxy hook itself and enables both services. There is no `'anas'` user — both processes run as root — and no config file is generated. The plan below is kept as history.

```bash
npm install -g anas
sudo anas setup          # Creates 'anas' user, systemd units, socket dir
sudo systemctl enable --now anasd anas
```

### What `anas setup` does
1. Creates `/run/anas/` directory (via tmpfiles.d)
2. Installs `anasd.service` and `anas.service` systemd units
3. Generates `/etc/anas/config.yaml` with defaults
4. Installs the pveproxy `/anas` reverse-proxy hook (fail-open, `perl -c`-gated) so the loopback gateway is reachable through PVE's `:8006` — no TLS or certificate of ANAS's own (see [`PROXY-TRANSPORT-DESIGN.md`](../PROXY-TRANSPORT-DESIGN.md))

### systemd units

**anasd.service** — the shipped unit, `packaging/systemd/anasd.service` (the original draft's `After=zfs.target` was corrected at install design: the daemon needs the cluster filesystem up, and a pool's presence is discovered at run time, never unit-ordered):
```ini
[Unit]
Description=ANAS Daemon
After=network.target pve-cluster.service

[Service]
Type=simple
ExecStartPre=/bin/mkdir -p /run/anas
ExecStart=/usr/bin/node /opt/anas/packages/daemon/dist/index.js
Environment=ANASD_SOCKET=/run/anas/anasd.sock
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**anas.service** (the API gateway — serves no pages; plain HTTP on `127.0.0.1:3000`, fronted by pveproxy at `:8006/anas`)
```ini
[Unit]
Description=ANAS API Gateway
After=anasd.service
Requires=anasd.service

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/anas/packages/gateway/dist/index.js
User=root
Environment=NODE_ENV=production
# Operator-configurable loopback port (issue #2). install.sh writes ANAS_PORT
# into /etc/default/anas; the leading '-' makes it optional so an absent file
# leaves the built-in default 3000. AnasProxy.pm reads the same file, so the
# pveproxy /anas hop always targets the port the gateway actually binds. The
# port is NODE-LOCAL — nothing here is cluster-wide.
EnvironmentFile=-/etc/default/anas

[Install]
WantedBy=multi-user.target
```

**Generated schedule units** (written at run time, not installed by `anas setup`): the snapshot schedules ship `anas-snap-<id>.service`/`.timer` per policy, and story selfheal.4 adds ONE node-level pair, `anas-scrub.service`/`anas-scrub.timer` — a `Persistent=true` timer (monthly/quarterly OnCalendar) whose oneshot service runs `node dist/scrub-task.js <pools…>`, the runner that POSTs `/v1/ahr/<pool>/scrub` per enabled AHR pool in sequence. Both pairs follow the same unit-store pattern: the canonical config rides an `X-ANAS-Schedule=` JSON marker inside the `.service` file, and ANAS never edits a unit that lacks the marker. Cloud sync (rclone.2) adds `anas-cloud-<name>.service`/`.timer` per task on the backup shape (`X-ANAS-Task=` marker, runner `dist/cloud-task.js`). Every ANAS timer-unit store — backup, cloud sync, replication, snapshot schedules, and the scrub pair — deletes its systemd stamp (`/var/lib/systemd/timers/stamp-<unit>.timer`) and resets its failed state when its units are removed, and orphan stamps under any of the stores' prefixes are swept at daemon start (stamps newer than the process start are left alone — possibly a just-created task's) — a re-created task or schedule no longer inherits a stale last-trigger (SCHEDULES-GT-17).

---
