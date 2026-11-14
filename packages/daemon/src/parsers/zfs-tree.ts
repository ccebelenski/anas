/**
 * Parsers for the TREE-WIDE ZFS listings recursive replication reads (rrep.1a,
 * #84). Three shapes, all plain `-H`/`-Hp` tab-separated stdout captured on the
 * stunt nodes (`fixtures/zfs/replication-tree/`, see its README):
 *
 *   zfs list -H  -o name                  -r -t filesystem,volume  → tree
 *   zfs list -Hp -t snapshot -o name,creation,guid -r              → snapshots
 *   zfs get -Hp  -r -t filesystem,volume -o name,property,value    → props
 *
 * One rule runs through all three: A LINE WE CANNOT READ IS AN ERROR, NEVER
 * "nothing there". A dataset with no snapshots legitimately exits 0 with empty
 * stdout (fixture README, rrep.0 ground truth), so empty input means empty
 * output — but a line with the wrong number of fields means the listing is not
 * the one this parser was written for, and reading it as "no datasets / no
 * snapshots / unencrypted" would hand a half-read tree to a `zfs send`. The
 * CALLER has already proven the read succeeded (it checked the exit code);
 * these parsers never see a failure, so they never guess.
 */

/** Quote an unreadable line in the thrown message. */
/** A `-p` epoch: digits only (`Number('')` is 0, so an empty column must not pass). */
const DIGITS_RE = /^\d+$/

/** Every C0 control character but the tab, and DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0A-\x1F\x7F]/g

function unreadable(what: string, line: string): never {
  // Control characters are shown, not carried: this message travels into a
  // job error and a mail body, and a raw carriage return there rewrites the
  // line it lands on. A tab stays a tab (it is the listing's own separator).
  const shown = line.replace(CONTROL_RE, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
  throw new Error(`Unreadable ${what} line: '${shown}'`)
}

/** Split stdout into content lines (a trailing newline is not a line). */
function lines(stdout: string, what: string): string[] {
  const out = stdout.split('\n').filter(l => l.length > 0)
  // A carriage return is not something `zfs -H` prints; a listing that
  // carries one came through something we do not understand, and a name with
  // a trailing `\r` would quietly match nothing downstream (review of rrep.1a).
  for (const l of out) {
    if (l.includes('\r'))
      unreadable(what, l)
  }
  return out
}

/**
 * `zfs list -H -o name -r -t filesystem,volume -- <root>` — the dataset tree
 * (`zfsTreeListArgs`, services/zfs-snapshot.ts, builds the argv; fixture
 * `src-tree.txt`). The
 * LISTING ORDER is kept: ZFS lists the root first, then descendants
 * parents-before-children, and the planner's sweep order is exactly that.
 * One field per line; a line containing a tab is unreadable.
 */
export function parseTreeList(stdout: string): string[] {
  const out: string[] = []
  for (const line of lines(stdout, 'zfs tree listing')) {
    const fields = line.split('\t')
    if (fields.length !== 1 || fields[0].length === 0 || out.includes(fields[0]))
      unreadable('zfs tree listing', line)
    out.push(fields[0])
  }
  return out
}

/**
 * `zfs list -Hp -t snapshot -o name,creation,guid -r -- <root>` — every
 * snapshot of the tree ({@link zfsTreeSnapshotsArgs} builds the argv; fixture
 * `src-snaps-p.txt`). Each line is `<dataset>@<name>\t<creation epoch>\t<guid>`
 * → dataset → snapshot NAMES, NEWEST FIRST. Order comes from the creation
 * epoch, not the listing order; two snapshots of ONE dataset sharing an epoch
 * keep the listing's meaning of "later line = newer", so the later line comes
 * FIRST (an equal-epoch pair cannot be told apart any other way from stdout —
 * `-Hp` gives no finer clock). A dataset with no snapshots gets no key at all
 * (empty stdout = no keys: the fixture README's "nothing there").
 */
export function parseTreeSnapshots(stdout: string): Map<string, string[]> {
  interface Entry {
    dataset: string
    name: string
    epoch: number
    /** Position in the listing; breaks equal-epoch ties (later = newer). */
    order: number
  }
  const entries: Entry[] = []
  const seen = new Set<string>()
  for (const line of lines(stdout, 'zfs snapshot listing')) {
    const fields = line.split('\t')
    // A repeated snapshot would let a base search pick S as its own base.
    if (fields.length !== 3 || seen.has(fields[0]))
      unreadable('zfs snapshot listing', line)
    seen.add(fields[0])
    const at = fields[0].lastIndexOf('@')
    // `Number('')` is 0: an empty creation column is unreadable, not 1970.
    const epoch = DIGITS_RE.test(fields[1]) ? Number(fields[1]) : Number.NaN
    if (at <= 0 || at === fields[0].length - 1 || !Number.isFinite(epoch))
      unreadable('zfs snapshot listing', line)
    entries.push({ dataset: fields[0].slice(0, at), name: fields[0].slice(at + 1), epoch, order: entries.length })
  }
  const newest = (a: Entry, b: Entry): number =>
    b.epoch - a.epoch || b.order - a.order
  entries.sort(newest)
  const out = new Map<string, string[]>()
  for (const e of entries) {
    const list = out.get(e.dataset)
    if (list)
      list.push(e.name)
    else
      out.set(e.dataset, [e.name])
  }
  return out
}

/**
 * `zfs get -Hp -r -t filesystem,volume -o name,property,value <props> -- <root>`
 * — one row per dataset per property ({@link zfsTreeGetArgs} builds the argv;
 * fixtures `src-keystatus.txt`, `dst-written.txt`). Each line is
 * `<dataset>\t<property>\t<value>` → dataset → property → value, first-seen
 * order. Values stay STRINGS exactly as printed (`'-'` for a keyless
 * keystatus, `'24576'` for a modified target); deciding what a value MEANS is
 * the planner's question, and a missing ROW is something only the planner can
 * tell from a missing dataset.
 */
export function parseTreeProps(stdout: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>()
  for (const line of lines(stdout, 'zfs property listing')) {
    const fields = line.split('\t')
    if (fields.length !== 3 || fields[0].length === 0 || fields[1].length === 0)
      unreadable('zfs property listing', line)
    const row = out.get(fields[0])
    if (row && Object.hasOwn(row, fields[1]))
      unreadable('zfs property listing', line)
    if (row)
      row[fields[1]] = fields[2]
    else
      out.set(fields[0], { [fields[1]]: fields[2] })
  }
  return out
}

/**
 * The argv for the tree's snapshot listing — the recursive twin of
 * `zfsSnapshotListArgs` (zfs-list.ts), which stays DIRECT-only by design.
 * `-p` matters here exactly as it does in `zfsListArgs`: under `-Hp` the
 * `creation` column is an exact epoch integer, while without `-p` it is a
 * display date that two snapshots taken in one recursive call would share to
 * the second.
 */
export function zfsTreeSnapshotsArgs(root: string): string[] {
  return ['list', '-Hp', '-t', 'snapshot', '-o', 'name,creation,guid', '-r', '--', root]
}

/**
 * The argv for the tree's property listing: `keystatus` on the source side
 * (R5f — is the key loaded?), `written` on the target side (R5g — has the
 * replica been modified since its last received snapshot?).
 */
export function zfsTreeGetArgs(root: string, props: string[]): string[] {
  return ['get', '-Hp', '-r', '-t', 'filesystem,volume', '-o', 'name,property,value', props.join(','), '--', root]
}
