# PBS task logs can fill the backup server's root disk

**Status:** operator note, written 2026-11-04 after the backup server behind a production
ANAS node refused new backups with its root filesystem full. Nothing here is an ANAS
defect or an ANAS setting. It is recorded because every ANAS backup task talks to a
Proxmox Backup Server, and this is how that server fails when it happens.

## The symptom

A backup task fails within a second of starting. The job error, and the client output in
the task's run log, read:

```
Error: mkstemp "/var/log/proxmox-backup/tasks/XX/UPID:...:backup:...:.tmp_XXXXXX" failed: ENOSPC: No space left on device
```

Nothing is wrong on the PVE node. The PBS server could not create the file that holds the
task's own log, because the filesystem that holds `/var/log` on the PBS host is full. The
datastore is usually fine; it is the small OS disk that filled.

## The cause

Two PBS behaviours combine.

**Every backup task log records every chunk.** `proxmox-backup-client` opens its session
with the server's debug flag set unconditionally (`debug: true` in `create_backup`), and the
server then writes one `successfully added chunk ... to dynamic index ...` line per chunk
into the task log. A host backup of a few terabytes has millions of chunks, so its server-side
task log is hundreds of megabytes; one of the logs that triggered this note was 1.3 GB. PVE's
own guest backups show the same lines, so a PBS that only receives vzdump backups fills too,
only more slowly per task and faster in count. This is Proxmox
[bug 4646](https://bugzilla.proxmox.com/show_bug.cgi?id=4646). A patch was posted to the
developer list in September 2026 and had not been applied when this was written.

**Old task logs are not deleted.** PBS removes a task's log file only when the task falls off
the task archive. The archive rotates only once it grows past 512 KiB, roughly 5000 tasks, and
twenty rotations are kept. Until the first rotation nothing is ever deleted. The node setting
`task-log-max-days` does not change this: its cutoff is applied to archives that have already
rotated, and the file cleanup uses the oldest entry of the oldest archive as its cutoff. On a
server that runs a handful of tasks a day the first rotation is years away, so the setting has
no effect for years. Seen in `proxmox-rest-server`, `src/worker_task.rs`,
`rotate_task_log_archive` and `cleanup_old_tasks`.

Together: a backup server with a 40 GB root disk and a few large host backups fills in
months. The one behind this note did it in five.

## Check

On the PBS host:

```sh
df -h /
du -sh /var/log/proxmox-backup/tasks
find /var/log/proxmox-backup/tasks -type f -name 'UPID:*' -size +100M -printf '%s\t%TY-%Tm-%Td\t%f\n' | sort -n | tail
```

If the task directory is most of the used space and the big files are backup task logs, this
is the problem.

## One-time cleanup

Delete the backup task logs older than thirty days. The task archive stays, so every task is
still listed in the PBS UI; an entry whose log was removed opens with no log text.

```sh
find /var/log/proxmox-backup/tasks -mindepth 2 -maxdepth 2 -type f -name 'UPID:*:backup:*' -mtime +30 -delete
df -h /
```

Adjust `+30` to taste. Nothing else in that directory needs to go: all the non-backup task
logs together are a few megabytes. Failed ANAS runs do not retry on their own; run them from
the task's Run Now button or wait for the next schedule.

## Keeping it from coming back

Pick one, or wait for the upstream fix.

- **A scheduled prune on the PBS host.** The repository carries one under
  [`contrib/pbs-task-log-prune/`](../contrib/pbs-task-log-prune/), a daily timer that removes
  task logs older than N days and larger than M. The size floor is what selects the flooded
  logs: restore (`reader`) task logs carry the same per-chunk lines, so a backup-only cleanup
  misses them, while almost every normal task log is a few kilobytes. **It is not supported and
  not part of ANAS; use it at your own risk**, read it before installing it, and remove it when
  bug 4646 ships.
- **Lower the proxy's log level.** `systemctl edit proxmox-backup-proxy.service` with
  `Environment=PBS_LOG=warn` under `[Service]`, then restart the proxy. This stops the flood
  at the source, and it also drops every informational line from every task log, including
  the garbage-collection, verify and prune summaries. The log level is a single global
  setting; per-module filtering is not available.

ANAS deliberately does none of this. It is a guest on the PVE node and has no business on
the backup server (EPICS §2, "ANAS never contacts the PBS server for status or monitoring";
GitHub #56). What ANAS does is report the failure as it happened, with the server's error
text, so the operator can find this page.
