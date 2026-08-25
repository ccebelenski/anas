# ZFS fixtures — provenance

The "ground truth first" ruling asks every fixture to be labelled **real capture** vs
**synthetic**. This directory predates that labelling, so this file states what is known
about each group rather than pretending it was always recorded.

## Real captures

Captured on **2026-08-25** for story **iscsi.3** on the stunt node (`anas-pve`,
192.168.200.50) — a disposable PVE 9 VM running `zfs-2.4.3-pve1` / `zfs-kmod-2.4.3-pve1`
on kernel `7.0.14-12-pve`. Nothing here comes from a production host. Both files are
verbatim daemon stdout, re-indented by `python3 -m json.tool --indent 4` and nothing else
— no values were edited, added or removed.

| File | Command | What it proves |
|------|---------|----------------|
| `zfs-list-volumes.json` | `zfs list -j -r -o name,used,available,referenced,quota,mountpoint,compression,compressratio,type,volsize,volblocksize,refreservation -t filesystem,volume gtiscsi` | A real pool carrying a filesystem, a nested filesystem and a **real zvol** side by side — the exact columns `ZFS_LIST_PROPS` asks for. |
| `zfs-get-volume.json` | `zfs get -j all gtiscsi/vol1` | The complete property bag of a **real zvol**: 48 properties. |

What these two captures settle for `iscsi.3` (each was a guess before):

- A volume's `zfs list` row reports `mountpoint`, `quota`, `volsize` and `volblocksize`
  as literal `"-"` where they do not apply — so `"-"` must be read as *absent*, never
  parsed as a size. On the volume row `volsize` is `2G` and `volblocksize` is `16K`.
- `zfs get all` on a volume **does not emit `mountpoint`, `quota`, `recordsize` or
  `atime` at all** — those properties simply do not exist on a zvol. That is the
  evidence behind the create schema refusing `mountpoint`/`recordsize`/`quota` for
  `type: 'volume'`, and behind the UI disabling the filesystem-property editor on a
  volume row.
- The volume is **thick**: `refreservation` is `2.03G` with source `LOCAL`, and `used`
  (2.03G) is the refreservation rather than what was written (`referenced` is 60.5K).
  This is why `sparse` is derived from `refreservation` and why a thick volume never
  shows reclaim in `used`.
- `volblocksize` carries `source.type: "DEFAULT"`, which is the only honest place to
  read **ZFS's own default block size** from — there is no module parameter for it
  (checked: `/sys/module/zfs/parameters` has no such knob). `parseVolblocksizeDefault`
  reads it straight out of the list output, so stating the default in the Create dialog
  costs no extra command.

No sparse volume existed on the stunt node and the story's read-only rule forbade
creating one, so the thin case is exercised by mutating this real capture's
`refreservation` to `none` inside `zfs-list.test.ts` — done in the test, and named
there, rather than checked in as a fixture that looks captured but is not.

## Pre-existing fixtures — synthetic

Every other file here (`zfs-list.json`, `zfs-get-*.json`, `zpool-*.json`,
`zpool-upgrade-*.txt`, …) is hand-written sample data built while the parsers were
written: they describe a fictional `testpool` with round sizes and no host ever had
those pools. They are shaped after real command output and remain fine as parser
fixtures, but they are **not captures** and must not be cited as evidence about how ZFS
behaves. When one of them is the only support for a behavioural claim, capture the real
thing instead.
