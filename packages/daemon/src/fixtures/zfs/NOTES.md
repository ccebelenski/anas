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

## The `-p` flag and these captures (issue #50, 2026-09-03)

`zfsListArgs` now issues `zfs list -j **-p** -r -o …`. Without `-p` every number
in the JSON is the DISPLAY form — three significant digits — and the volume
never-shrink gate was comparing a requested exact byte count against it, so a
real shrink inside the rounding window read as a grow (`1.21T` → 1,330,409,069,609
against a true 1,331,439,861,760: ~983 MiB light).

**Both `zfs list` files here therefore predate the command we now issue.** They
are deliberately kept **verbatim** rather than mechanically rewritten:

- `zfs-list-volumes.json` is a real capture. Its exact byte counts are NOT
  recoverable from the rounded strings it holds (`2.03G` is anything in
  [2.025 G, 2.035 G)), so "converting" it would mean inventing digits and
  checking them in under a heading that says *real capture*. That is exactly the
  thing ground-truth-first forbids.
- `zfs-list.json` is synthetic and mixed-purpose: the same file feeds the `-p`
  dataset list AND the snapshot parsers, whose commands stay in display form
  (`creation` under `-p` is an epoch integer `parseZfsDate` does not read).
  Rewriting it would make one of its two jobs wrong.

Instead, `parseHumanSize` reads **both** forms (it has to: `zfs get -j all` and
the snapshot listings are still display-form on purpose), the `-p` rows are
DERIVED inside the tests and named as derived — the same rule the thin-volume
case above already follows — and these two files now serve as the display-form
tolerance cases.

**Owed:** a fresh `zfs list -j -p -r -o <ZFS_LIST_PROPS> -t filesystem,volume
<pool>` capture from a real node, to be checked in beside the existing one
(suggested name `zfs-list-volumes-p.json`) and to settle two things nothing here
can attest to: whether libzfs emits `-p` values as JSON strings or numbers (the
parser accepts both), and whether `compressratio` keeps its trailing `x` under
`-p` (`parseDedupRatio` accepts both).

## Pre-existing fixtures — synthetic

Every other file here (`zfs-list.json`, `zfs-get-*.json`, `zpool-*.json`,
`zpool-upgrade-*.txt`, …) is hand-written sample data built while the parsers were
written: they describe a fictional `testpool` with round sizes and no host ever had
those pools. They are shaped after real command output and remain fine as parser
fixtures, but they are **not captures** and must not be cited as evidence about how ZFS
behaves. When one of them is the only support for a behavioural claim, capture the real
thing instead.
