#!/usr/bin/env bash
# pbs-task-log-prune — remove oversized, aged task logs on a Proxmox Backup Server.
#
# NOT SUPPORTED — USE AT YOUR OWN RISK. This is not part of ANAS, is not
# installed by ANAS, and runs on the PBS host, which ANAS does not manage.
# Read README.md in this directory before installing it.
#
# What it does: under /var/log/proxmox-backup/tasks/<XX>/ delete every task log
# (file named UPID:...) that is older than AGE_DAYS days AND larger than
# MIN_SIZE. The task archive, index and active files are never touched, so the
# task list in the PBS UI stays complete; an entry whose log was removed opens
# with no log text.
#
# Knobs (environment, or /etc/default/pbs-task-log-prune through the unit):
#   TASK_DIR   task log directory              default /var/log/proxmox-backup/tasks
#   AGE_DAYS   older than this many days       default 30   (find -mtime +N)
#   MIN_SIZE   larger than this (find -size)   default 1M   (digits + optional k/M/G)
# Flags: --dry-run | -n   list what would be removed, remove nothing.
set -euo pipefail

TASK_DIR=${TASK_DIR:-/var/log/proxmox-backup/tasks}
AGE_DAYS=${AGE_DAYS:-30}
MIN_SIZE=${MIN_SIZE:-1M}
dry=0

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) dry=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "pbs-task-log-prune: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

[[ "$AGE_DAYS" =~ ^[0-9]+$ ]]        || { echo "pbs-task-log-prune: AGE_DAYS must be a whole number of days, got '$AGE_DAYS'" >&2; exit 2; }
[[ "$MIN_SIZE" =~ ^[0-9]+[kMG]?$ ]]  || { echo "pbs-task-log-prune: MIN_SIZE must be digits with an optional k, M or G, got '$MIN_SIZE'" >&2; exit 2; }
[ -d "$TASK_DIR" ]                   || { echo "pbs-task-log-prune: task directory '$TASK_DIR' not found" >&2; exit 1; }

# Only files named UPID:* exactly one level down (the 256 two-hex subdirectories).
# archive/index/active sit at the top level and are outside -mindepth 2.
mapfile -d '' candidates < <(
  find "$TASK_DIR" -mindepth 2 -maxdepth 2 -type f -name 'UPID:*' \
       -mtime "+$AGE_DAYS" -size "+$MIN_SIZE" -print0
)

count=${#candidates[@]}
bytes=0
for f in "${candidates[@]}"; do
  s=$(stat -c %s -- "$f" 2>/dev/null || echo 0)
  bytes=$((bytes + s))
  [ $dry -eq 1 ] && printf '%s\n' "$f"
done
mib=$((bytes / 1048576))

if [ $dry -eq 1 ]; then
  echo "pbs-task-log-prune: would remove $count task logs (${mib} MiB) older than $AGE_DAYS days and larger than $MIN_SIZE under $TASK_DIR"
  exit 0
fi

removed=0
for f in "${candidates[@]}"; do
  if rm -f -- "$f"; then removed=$((removed + 1)); else echo "pbs-task-log-prune: could not remove '$f'" >&2; fi
done
echo "pbs-task-log-prune: removed $removed task logs (${mib} MiB) older than $AGE_DAYS days and larger than $MIN_SIZE under $TASK_DIR"
