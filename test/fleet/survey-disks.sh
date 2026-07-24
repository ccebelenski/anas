#!/bin/bash
# ANAS fleet disk survey — STRICTLY READ-ONLY.
#
# Classifies every whole disk on a PVE node so free AHR candidates are
# obvious: ZFS member / Ceph-LVM / md member / partitioned / held / FREE.
# Run as root on the node and paste the output back:
#   ssh root@<node> bash < test/fleet/survey-disks.sh
#
# Nothing here writes: wipefs runs with --no-act, everything else is
# lsblk/zpool/pvs/proc reads.
set -u

echo "=== disk survey: $(hostname) $(date -Is) kernel $(uname -r) ==="

# ZFS member device paths (realpaths, so kernel names can be matched).
ZPOOL_MEMBERS=""
if command -v zpool >/dev/null 2>&1; then
  ZPOOL_MEMBERS=$(zpool status -P 2>/dev/null | awk '$1 ~ /^\// {print $1}' \
    | while read -r p; do realpath "$p" 2>/dev/null; done)
fi

# LVM PVs (Ceph OSDs live in ceph-* VGs).
PV_TABLE=""
if command -v pvs >/dev/null 2>&1; then
  PV_TABLE=$(pvs --noheadings -o pv_name,vg_name 2>/dev/null)
fi

# md members from mdstat, e.g. "sda1[0]" -> sda1.
MD_MEMBERS=$(awk '/^md/ {for (i=5; i<=NF; i++) {split($i, a, "["); print a[1]}}' \
  /proc/mdstat 2>/dev/null)

echo
echo "--- zpool status -P (context) ---"
zpool status -P 2>/dev/null || echo "(no zfs)"
echo
echo "--- pvs (context; ceph-* VGs are OSDs) ---"
echo "${PV_TABLE:-"(no lvm)"}"
echo
echo "--- /proc/mdstat (context) ---"
cat /proc/mdstat 2>/dev/null || echo "(no md)"
echo

FREE_LIST=""
echo "--- per-disk classification ---"
for d in $(lsblk -dno KNAME,TYPE | awk '$2 == "disk" {print $1}'); do
  case "$d" in
    rbd*|zd*|loop*|sr*|fd*) continue ;;
  esac
  # MODEL last: it may contain spaces, and the final read field takes the rest.
  read -r size serial model <<EOF
$(lsblk -dno SIZE,SERIAL,MODEL "/dev/$d" | head -1)
EOF
  byid=$(find /dev/disk/by-id -maxdepth 1 -type l ! -name 'wwn-*' ! -name '*-part*' \
    -exec sh -c 'test "$(realpath "$1")" = "/dev/'"$d"'" && basename "$1"' _ {} \; 2>/dev/null | head -1)

  tags=""
  parts=$(lsblk -no KNAME "/dev/$d" | tail -n +2)
  [ -n "$parts" ] && tags="$tags partitioned"
  for node in $d $parts; do
    if printf '%s\n' "$ZPOOL_MEMBERS" | grep -qx "/dev/$node"; then
      tags="$tags zfs-member"; break
    fi
  done
  if printf '%s\n' "$PV_TABLE" | grep -q "/dev/$d"; then
    vg=$(printf '%s\n' "$PV_TABLE" | grep "/dev/$d" | awk '{print $2}' | head -1)
    tags="$tags lvm-pv($vg)"
  fi
  for node in $d $parts; do
    if printf '%s\n' "$MD_MEMBERS" | grep -qx "$node"; then
      tags="$tags md-member"; break
    fi
  done
  holders=$(ls "/sys/block/$d/holders" 2>/dev/null)
  [ -n "$holders" ] && tags="$tags held($(echo "$holders" | tr '\n' ',' | sed 's/,$//'))"
  fstype=$(lsblk -no FSTYPE "/dev/$d" | grep -v '^$' | sort -u | tr '\n' ',' | sed 's/,$//')
  [ -n "$fstype" ] && tags="$tags fs($fstype)"
  sigs=$(wipefs --no-act "/dev/$d" 2>/dev/null | tail -n +2)
  [ -n "$sigs" ] && tags="$tags signatures"
  mounted=$(lsblk -no MOUNTPOINT "/dev/$d" | grep -v '^$' | head -1)
  [ -n "$mounted" ] && tags="$tags MOUNTED($mounted)"

  if [ -z "$tags" ]; then
    verdict="FREE"
    FREE_LIST="$FREE_LIST$d $size ${byid:-?}\n"
  else
    verdict="in-use:$tags"
  fi
  printf '%-8s %8s  %-28s sn=%-20s %s\n    by-id: %s\n' \
    "$d" "$size" "${model:--}" "${serial:--}" "$verdict" "${byid:-<none>}"
done

echo
echo "=== FREE candidates (no partitions, no signatures, no holders, no pool) ==="
if [ -n "$FREE_LIST" ]; then
  printf '%b' "$FREE_LIST" | sort -k2 -h
else
  echo "(none — every disk is claimed; pick victims from the classification above)"
fi
