# The restore mark on an image file — ground truth (cr3.lunrestore.filemark)

Captured 2026-11-15 on the two stunt nodes, in scratch made for the purpose and
removed afterwards: anas-zfs (PVE 9.2 from the ISO, OpenZFS 2.4.2, ZFS root,
kernel 7.0.2-6-pve) and anas-pve (PVE 9, ext4 root, kernel 7.0.14-28-pve).
Every parser and writer test of the file mark reads these files; no typed
line. Every finding below names the capture that shows it; a finding with no
capture says "not captured".

| capture | script (committed beside it) | what |
|---|---|---|
| `file-mark.anas-zfs.txt` | `file-mark-capture.sh` | every argv the daemon issues, byte-exact: ZFS `xattr=sa`, a dataset set `readonly=on` after a mark was set, a dataset over its `quota=8M` |
| `file-mark.anas-pve.txt` | `file-mark-capture.sh` | the same on ext4 (the root filesystem), btrfs (a loop), an ext4 loop remounted read-only after a mark was set, a filled ext4 loop, a vfat loop; the 4032/4096 size cases |
| `investigation.anas-zfs.txt`, `investigation.anas-pve.txt` | `investigation-capture.sh` | the namespace question, the read forms, the restore's open, value sizes, copies on ONE filesystem (human-readable, `cat -v`) |
| `travel.anas-zfs.txt`, `travel.anas-pve.txt` | `travel-capture.sh` | copies ACROSS filesystems, `zfs send`, clone, `.zfs/snapshot`, rollback, btrfs snapshots |
| `limits.anas-zfs.txt`, `limits.anas-pve.txt` | `limits-capture.sh` | `xattr=off`, the two-file read, value sizes at the edges, a truly full ext4, the package |

Format of the `file-mark.*` files (one case each; the `set-too-long` cases, a
64 KiB argv line, were dropped from the committed file):

```
### <node> <filesystem> <case>
$ <argv, shell-quoted>
--- stdout <N>
<N bytes>
--- stderr <M>
<M bytes>
EXIT=<status>
```

The other captures print each command as `$ <command>`, its output, then `exit=<n>`.

The daemon's argv (run with `LC_ALL=C`): read `getfattr --absolute-names -e hex -n trusted.anas.restore -- <file>`;
set `setfattr -n trusted.anas.restore -v 0x<hex> -- <file>`; remove `setfattr -x trusted.anas.restore -- <file>`.

## Findings

1. **Namespace** (`investigation.*`, "1. namespaces"). `trusted.` is root's: an
   unprivileged user (`nobody`, with write access to the image, mode 0666) reads
   `No such attribute`, and a set or remove is `Operation not permitted`, on
   ZFS, ext4 and btrfs. `user.` is read, set and removed by that user. So the
   mark is `trusted.anas.restore`.
2. **Read forms.** `--only-values` prints the raw value; `-e hex` prints
   `<name>=0x<hex>`; without `--absolute-names` every successful read prints
   `getfattr: Removing leading '/' from absolute path names` on stderr;
   setfattr reads a value beginning `0s` as base64 (`-v 0sQUJD` stored `ABC`)
   (`investigation.*`, "1. namespaces"). Byte-exact hex for an empty value
   (`=0x`), bytes that are not UTF-8 and a newline (`file-mark.*`, cases
   `read-empty`, `read-odd`, `read-newline`). Not set: exit 1, `<path>:
   trusted.anas.restore: No such attribute` (`read-absent`). A missing file:
   exit 1, `getfattr: <path>: No such file or directory` (`read-missing-file`).
   Remove of an absent attribute: exit 1, `setfattr: <path>: No such attribute`
   (`remove-absent`). Two files in one `getfattr`, one unset and one missing:
   their two lines on stderr, the found value on stdout, exit 1
   (`limits.anas-zfs.txt`, "two files in one getfattr"). The error lines are
   the C locale's: under another locale they are translated (attr 2.6.0 under
   de_DE prints `Kein solches Attribut`: seen on a workstation by the review,
   not captured on a node), so the daemon runs both tools with `LC_ALL=C`.
3. **The restore's open** (`investigation.*`, "2. survives the restore's
   open"). The attribute is on the inode: a Node `fs.createWriteStream(path,
   { flags: 'w' })` (O_TRUNC) then 4 MiB written, an open that only empties the
   file (size 0), `truncate -s`, and `dd` (O_TRUNC) all keep it, inode
   unchanged, on ZFS, ext4 and btrfs.
4. **Refusing filesystems.** vfat: read `<path>: trusted.anas.restore:
   Operation not supported`, set and remove `setfattr: <path>: Operation not
   supported` (`file-mark.anas-pve.txt`, `unsupported-*`). OpenZFS 2.4.2 with
   `xattr=off` does NOT refuse: the mount shows `noxattr`, and set, read and
   remove all work, and a mark set before the switch still reads
   (`limits.anas-zfs.txt`, "xattr=off" and "a mark set before"). Read-only (ZFS
   `readonly=on`, ext4 `remount,ro`): the mark reads; set and remove `Read-only
   file system` (`file-mark.*`, `readonly-*`). Full: ZFS over its quota refuses
   the set with `Disk quota exceeded` (`file-mark.anas-zfs.txt`, `full-set`);
   ext4 filled to its last block, root's reserve included, still takes a
   2-byte value and refuses a 1400-byte one with `No space left on device`
   (`limits.anas-pve.txt`, "ext4 filled to its last block"; a less full loop
   took the 149-byte mark: `file-mark.anas-pve.txt`, `full-set`).
5. **Copies.** Carry the mark: `cp -a`, `cp --preserve=all`, `rsync -aX` and
   `mv` on one filesystem (ZFS, ext4, btrfs: `investigation.*`, "4a. travel");
   `cp -a`, `rsync -aX` and `mv` from ext4 to btrfs, and `mv` from btrfs to
   ext4 (`travel.anas-pve.txt`); `mv` between two ZFS datasets (two mounts,
   `travel.anas-zfs.txt`); the `.zfs/snapshot` copy, a plain `zfs send | zfs
   recv` and a `zfs clone` (`travel.anas-zfs.txt`); a btrfs snapshot of a
   subvolume, read-write and read-only (`travel.anas-pve.txt`). A `zfs
   rollback` puts back what the snapshot holds: a mark removed after the
   snapshot comes back, and a mark set after it goes (`travel.anas-zfs.txt`).
   Drop the mark: `cp` and `rsync` with no options, on one filesystem and from
   ext4 to btrfs (`investigation.*`, `travel.anas-pve.txt`). Not captured: a
   `zfs send -R` or raw send, `cp --reflink`, a copy over NFS or SMB. A
   volume's ZFS user property behaves differently: a plain send does not carry
   it and a rollback does not revert it (`docs/DESIGN.md`, the restore mark).
6. **Size.** ext4 (4 KiB blocks, 256-byte inodes) takes 4032 bytes for this
   name and refuses 4033 and 4096 with `No space left on device`
   (`limits.anas-pve.txt`, "value sizes on ext4"; also `file-mark.anas-pve.txt`,
   `toobig-*`); btrfs takes 8000 and refuses 65536 with `No space left on
   device`; ZFS takes 65536; above that setfattr itself refuses (`Argument list
   too long`) (`limits.*`, "value sizes"). The mark's JSON is about 150 bytes
   with a short reason; its fields are bounded (repo 128, ns 256, snapshot 256,
   archive 128, started 40, reason 512 characters), so an ASCII mark stays
   under 1.5 KB (arithmetic, not a capture), and a value that does not fit is
   refused by the set.
7. **Package** (`limits.*`, "the package"). `/usr/bin/setfattr` and
   `/usr/bin/getfattr` belong to `attr` (1:2.5.2-3, priority optional). On both
   nodes the dpkg log shows `attr` installed in the same minute as `samba`
   (anas-zfs: samba 21:57:43, attr 21:57:46; anas-pve: both 17:32:48), after
   `proxmox-ve`: it came with samba, which Recommends it in Debian 13's 4.22;
   the 4.24.7 backport only Suggests it, and `xfsprogs` only Suggests it. On
   anas-pve `attr` is now marked manual, by a later `apt-get install ... attr`
   (its history line is in the capture). Not captured: a fresh PVE 9 node
   without samba (inferred from the dpkg log order: nothing before samba
   installed attr).
