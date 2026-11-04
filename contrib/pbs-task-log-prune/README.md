# pbs-task-log-prune

> **NOT SUPPORTED — USE AT YOUR OWN RISK.**
> This runs on your Proxmox Backup Server, not on the PVE node. ANAS does not
> install it, does not call it and does not manage it. It is published here
> because the problem it works around hits anyone who backs up large sources
> to PBS, and the cleanup it performs is the one documented in
> [`docs/PBS-TASK-LOGS.md`](../../docs/PBS-TASK-LOGS.md). It is a deletion
> tool for a directory PBS owns. Read the script before you install it.

## What it does

Once a day it deletes task logs under `/var/log/proxmox-backup/tasks/` that
are **older than 30 days and larger than 1 MiB**. Both numbers are knobs.
The size floor is what makes it safe to run blind: a task log inflated by the
per-chunk debug lines (PBS bug 4646) is tens of megabytes to over a gigabyte,
while nearly every normal task log is a few kilobytes and is left alone,
however old. The exception seen so far: a garbage collection that logs
thousands of warnings crosses 1 MiB and goes with the rest once it is older
than `AGE_DAYS`. Raise `MIN_SIZE` if you want to keep those. The task
archive, index and active files are never touched, so the task list in the
PBS UI stays complete. An entry whose log was removed opens with no log text.

## Install (on the PBS host, as root)

```sh
install -m 0755 pbs-task-log-prune.sh      /usr/local/sbin/pbs-task-log-prune.sh
install -m 0644 pbs-task-log-prune.default /etc/default/pbs-task-log-prune
install -m 0644 pbs-task-log-prune.service pbs-task-log-prune.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pbs-task-log-prune.timer
```

See what it would do before the first timer run:

```sh
pbs-task-log-prune.sh --dry-run
```

Change the knobs in `/etc/default/pbs-task-log-prune` (`AGE_DAYS`, `MIN_SIZE`
in `find -size` syntax: digits plus `k`, `M` or `G`). Each run writes one
line to the journal: `journalctl -u pbs-task-log-prune`.

## Uninstall

```sh
systemctl disable --now pbs-task-log-prune.timer
rm -f /etc/systemd/system/pbs-task-log-prune.service /etc/systemd/system/pbs-task-log-prune.timer
rm -f /usr/local/sbin/pbs-task-log-prune.sh /etc/default/pbs-task-log-prune
systemctl daemon-reload
```

Remove it once PBS ships the fix for
[bug 4646](https://bugzilla.proxmox.com/show_bug.cgi?id=4646); after that the
per-chunk lines stop and the logs are small again.

## Test

`./test.sh` runs the script over a fake task tree in a temporary directory
and checks the keep and delete sets, the dry run and the refusals. It needs
no root and no PBS.
