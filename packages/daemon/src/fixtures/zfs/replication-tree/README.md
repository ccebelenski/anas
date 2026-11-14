# Recursive replication — ground truth (rrep.0)

Captured 2026-11-13 from the two stunt nodes: source tree `rpool/rrsrc` on the
ZFS-root node (OpenZFS 2.4.2), target `datapool/rrdst` on the ext4-root node
(OpenZFS 2.4.4), reached over ssh. Exact bytes of stdout; nothing typed by hand.

The tree: `rrsrc`, `a`, `a/deep`, `enc` (encrypted, own encryption root),
`skipme` (never sent — an exclude), `vol` (a zvol), `new` (created after the
first snapshot), `late` (created after the second; it has no snapshot).
Two recursive snapshots, `…-11-13…` (S1) and `…-11-14…` (S2). Run 1 sent S1 to
every dataset but `skipme`, one `zfs send | ssh zfs recv -o readonly=on` each,
and held it on both sides. The files without `after-` are the state before
run 2; `after-*` are the state once run 2 had sent S2.

| File | Command |
|---|---|
| `src-tree.txt`, `dst-tree.txt`, `after-dst-tree.txt` | `zfs list -H -o name -r -t filesystem,volume -- <root>` |
| `after-dst-pool-tree.txt` | the same listing asked of the target POOL (`-- datapool`), captured 2026-11-14 after run 2: the pool's own row comes first, always |
| `src-snaps.txt`, `dst-snaps.txt`, `after-dst-snaps.txt` | `zfs list -H -t snapshot -o name,creation -r -- <root>` |
| `src-snaps-p.txt`, `dst-snaps-p.txt` | `zfs list -Hp -t snapshot -o name,creation,guid -r -- <root>` |
| `src-keystatus.txt`, `src-keystatus-unloaded.txt` | `zfs get -Hp -r -t filesystem,volume -o name,property,value keystatus,encryptionroot -- <root>` (second: after `zfs unload-key` on `enc`) |
| `dst-written.txt` | `zfs get -Hp -r -t filesystem,volume -o name,property,value written,readonly -- <root>` |
| `src-holds-batch.txt`, `dst-holds-batch.txt`, `after-*-holds.txt` | `zfs holds -H -- <every snapshot of the tree>` in one call |
| `holds-one-gone.*` | the same call with one snapshot that does not exist: exit 1, the other rows still on stdout |
| `tree-missing.stderr.txt` | the tree listing of a dataset that does not exist: exit 1, empty stdout |

Facts the captures and the run settle:

- A tree listing or snapshot listing of a missing dataset exits 1 with empty
  stdout. A dataset with no snapshots exits 0 with empty stdout. Only the exit
  code tells "nothing there" from "could not read".
- An ssh that cannot connect exits 255 with empty stdout.
- `dst-tree.txt` carries `targetonly`, a dataset made on the target that the
  source never had.
- `written` on a replica: 0 untouched; 0 after `readonly=off` with nothing
  written; 0 with a destination-only snapshot and no change; 14336 after one
  small file was written to it. The modified replica's incremental receive
  failed: "cannot receive incremental stream: destination datapool/rrdst/enc
  has been modified since most recent snapshot". The replica with only a
  destination-only snapshot received its incremental (exit 0). Not captured:
  a replica modified and THEN snapshotted locally (`written` reads 0 there).
- The failed receive left no resume token (`receive_resume_token` is `-`) and
  no snapshot.
- A non-raw send of a dataset whose key is not loaded prints "warning: cannot
  send '<ds>@<snap>': dataset key must be loaded" and sends nothing;
  `keystatus` reads `unavailable` on it and `-` on an unencrypted dataset.
- A zvol replicates like a filesystem; `readonly=on` is accepted on it.
- Sending an incremental whose snapshot the replica already has (2026-11-14,
  same pair): the receive prints "snap <target>@<snap> already exists;
  ignoring", "received 0B stream", and both ends exit 0.
