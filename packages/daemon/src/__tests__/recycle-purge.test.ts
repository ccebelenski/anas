import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { isPurgeable, isSingleSegment, main, parseRunnerArgs, purgeBin, runRecyclePurge } from '../recycle-purge.js'

const DAY = 86_400_000
/**
 * A fixed "today" for the run: the host clock at module load (the fixtures
 * are aged RELATIVE to it, so the actual value never matters).
 */
const NOW = Date.now()

/**
 * The age seam uses mtime: ctime cannot be set from userspace (any utimes
 * call stamps it back to "now"), so the tests inject `ageOf` over mtime after
 * aging fixture files with utimes — the runner's DEFAULT reads ctime, which is
 * exactly the property the purge keys on (a recycled file's ctime is its
 * deletion time, and users cannot forge it).
 */
const mtimeAge = (stats: { mtimeMs: number }) => NOW - stats.mtimeMs

function ageFile(path: string, ageMs: number): void {
  const when = new Date(NOW - ageMs)
  utimesSync(path, when, when)
}

describe('isPurgeable — `find -ctime +N` semantics', () => {
  it('whole days only, strictly more than N: a 30-day-old file is NOT past a 30-day purge', () => {
    assert.equal(isPurgeable(30 * DAY, 30), false)
    assert.equal(isPurgeable(30 * DAY + 3 * 3600_000, 30), false, 'the fractional part is ignored, as find does')
    assert.equal(isPurgeable(31 * DAY, 30), true)
    assert.equal(isPurgeable(31 * DAY - 3600_000, 30), false)
  })

  it('boundary for the other policy values', () => {
    assert.equal(isPurgeable(7 * DAY, 7), false)
    assert.equal(isPurgeable(8 * DAY, 7), true)
    assert.equal(isPurgeable(14 * DAY, 14), false)
    assert.equal(isPurgeable(90 * DAY, 90), false)
    assert.equal(isPurgeable(91 * DAY, 90), true)
  })
})

describe('purgeBin — the equivalent of find <bin> -type f -ctime +N -delete', () => {
  let dir: string

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('removes only files past their age, then prunes the emptied directories — never the bin itself', async () => {
    dir = mkdtempSync(join(tmpdir(), 'anas-recycle-purge-'))
    const bin = join(dir, '#recycle')
    mkdirSync(join(bin, 'docs/deep'), { recursive: true })
    mkdirSync(join(bin, 'young-stuff'), { recursive: true })
    writeFileSync(join(bin, 'docs/deep/old.txt'), 'x')
    writeFileSync(join(bin, 'docs/young.txt'), 'x')
    writeFileSync(join(bin, 'young-stuff/young.bin'), 'x')
    writeFileSync(join(bin, 'top-old.txt'), 'x')
    ageFile(join(bin, 'docs/deep/old.txt'), 40 * DAY)
    ageFile(join(bin, 'top-old.txt'), 40 * DAY)

    const { removed, prunedDirs } = await purgeBin(bin, 30, { now: () => NOW, ageOf: mtimeAge })
    assert.equal(removed, 2)
    // Only `deep` emptied out: `docs` still holds the young file,
    // `young-stuff` never held an aged one — both stay.
    assert.equal(prunedDirs, 1)
    assert.ok(existsSync(bin), 'the bin directory itself is never removed')
    assert.ok(!existsSync(join(bin, 'docs/deep')), 'the emptied directory is pruned')
    assert.ok(existsSync(join(bin, 'docs/young.txt')))
    assert.ok(existsSync(join(bin, 'young-stuff/young.bin')))
  })
})

describe('runRecyclePurge — the sweep over smb.conf', () => {
  let dir: string
  let confPath: string
  let logLines: string[]

  /** The [media] stanza + its tree: one aged file in a subdir, one young. */
  function setup(extra: string | ((paths: { root: string, mediaPath: string }) => string)): { mediaBin: string, mediaPath: string } {
    dir = mkdtempSync(join(tmpdir(), 'anas-recycle-run-'))
    confPath = join(dir, 'smb.conf')
    logLines = []
    const mediaPath = join(dir, 'srv/media')
    mkdirSync(join(mediaPath, '#recycle/sub'), { recursive: true })
    writeFileSync(join(mediaPath, '#recycle/sub/old.txt'), 'x')
    writeFileSync(join(mediaPath, '#recycle/young.txt'), 'x')
    ageFile(join(mediaPath, '#recycle/sub/old.txt'), 40 * DAY)
    writeFileSync(confPath, [
      '[media]',
      `\tpath = ${mediaPath}`,
      '\tvfs objects = recycle',
      '\trecycle:repository = #recycle',
      '\t# anas:recycle-purge-days = 30',
      '',
      typeof extra === 'function' ? extra({ root: dir, mediaPath }) : extra,
    ].join('\n'), 'utf8')
    return { mediaBin: join(mediaPath, '#recycle'), mediaPath }
  }

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const opts = {
    smbConfPath: () => confPath,
    now: () => NOW,
    ageOf: mtimeAge,
    log: (l: string) => logLines.push(l),
  }

  it('purges the aged file (+ its emptied directory) and keeps the young one; counts land in journald lines', async () => {
    const { mediaBin } = setup('[archive]\n\tpath = /nowhere\n\trecycle:repository = #recycle\n\t# anas:recycle-purge-days = 30\n')
    const result = await runRecyclePurge({ ...opts, smbConfPath: confPath })
    assert.deepEqual(result, { purged: 1, skipped: 1, failed: 0 })
    assert.ok(!existsSync(join(mediaBin, 'sub/old.txt')), 'the aged file is gone')
    assert.ok(!existsSync(join(mediaBin, 'sub')), 'its emptied directory is pruned')
    assert.ok(existsSync(join(mediaBin, 'young.txt')), 'the young file stays')
    assert.ok(existsSync(mediaBin), 'the bin itself stays')
    assert.ok(logLines.some(l => /^anas-recycle: share=media removed=1 pruned_dirs=1$/.test(l)), logLines.join('\n'))
    assert.ok(logLines.some(l => l.startsWith('anas-recycle: share=archive skipped')), logLines.join('\n'))
  })

  it('a share with `never` and one with no marker are skipped, their files untouched', async () => {
    // A SECOND tree, created inside the builder (setup owns the temp dir) and
    // only ever reached by the never/unmarked stanzas: whatever happens in it
    // is attributable to them alone ([media] purges its own).
    let otherPath = ''
    const { mediaBin } = setup((paths) => {
      otherPath = join(paths.root, 'srv/other')
      mkdirSync(join(otherPath, '#recycle/deep'), { recursive: true })
      writeFileSync(join(otherPath, '#recycle/deep/aged.txt'), 'x')
      writeFileSync(join(otherPath, '#recycle/fresh.txt'), 'x')
      ageFile(join(otherPath, '#recycle/deep/aged.txt'), 40 * DAY)
      return [
        '[never-share]',
        `\tpath = ${otherPath}`,
        '\trecycle:repository = #recycle',
        '\t# anas:recycle-purge-days = never',
        '',
        '[unmarked]',
        `\tpath = ${otherPath}`,
        '\trecycle:repository = #recycle',
      ].join('\n')
    })
    const result = await runRecyclePurge({ ...opts, smbConfPath: confPath })
    assert.deepEqual(result, { purged: 1, skipped: 2, failed: 0 })
    // [media]'s tree got its purge; the other tree stands untouched.
    assert.ok(!existsSync(join(mediaBin, 'sub/old.txt')))
    assert.ok(existsSync(join(otherPath, '#recycle/deep/aged.txt')), 'nothing deleted without a numeric marker')
    assert.ok(existsSync(join(otherPath, '#recycle/deep')), 'no pruning either')
    assert.ok(logLines.some(l => /share=never-share skipped/.test(l)), logLines.join('\n'))
    assert.ok(logLines.some(l => /share=unmarked skipped/.test(l)), logLines.join('\n'))
  })

  it('a share whose path is missing from the stanza, or whose bin does not exist, is skipped without error', async () => {
    setup([
      '[no-path]',
      '\trecycle:repository = #recycle',
      '\t# anas:recycle-purge-days = 30',
      '',
      '[no-bin]',
      `\tpath = ${join(dir, 'srv/empty-share')}`,
      '\trecycle:repository = #recycle',
      '\t# anas:recycle-purge-days = 30',
    ].join('\n'))
    mkdirSync(join(dir, 'srv/empty-share'), { recursive: true })
    const result = await runRecyclePurge({ ...opts, smbConfPath: confPath })
    assert.deepEqual(result, { purged: 1, skipped: 2, failed: 0 })
    assert.ok(logLines.some(l => /^anas-recycle: share=no-path skipped \(stanza sets no path\)$/.test(l)), logLines.join('\n'))
    assert.ok(logLines.some(l => /^anas-recycle: share=no-bin skipped \(#recycle does not exist\)$/.test(l)), logLines.join('\n'))
  })

  it('a foreign marker (not a policy value) is never a purge age', async () => {
    setup('[odd]\n\tpath = /x\n\trecycle:repository = #recycle\n\t# anas:recycle-purge-days = 45\n')
    const result = await runRecyclePurge({ ...opts, smbConfPath: confPath })
    assert.deepEqual(result, { purged: 1, skipped: 1, failed: 0 }, logLines.join('\n'))
    assert.ok(logLines.some(l => /share=odd skipped/.test(l)), logLines.join('\n'))
  })

  // ident.4 (f), audit #19: a share user can replace the bin with a symlink.
  it('a #recycle replaced by a symlink is SKIPPED with a note — nothing behind it is touched', async () => {
    let victim = ''
    setup((paths) => {
      victim = join(paths.root, 'victim')
      mkdirSync(victim, { recursive: true })
      writeFileSync(join(victim, 'precious.txt'), 'x')
      ageFile(join(victim, 'precious.txt'), 400 * DAY)
      const other = join(paths.root, 'srv/linked')
      mkdirSync(other, { recursive: true })
      symlinkSync(victim, join(other, '#recycle'))
      return `[linked]\n\tpath = ${other}\n\trecycle:repository = #recycle\n\t# anas:recycle-purge-days = 30\n`
    })
    const result = await runRecyclePurge({ ...opts, smbConfPath: confPath })
    assert.deepEqual(result, { purged: 1, skipped: 1, failed: 0 }, logLines.join('\n'))
    assert.ok(existsSync(join(victim, 'precious.txt')), 'the symlink was not followed')
    assert.ok(logLines.some(l => /^anas-recycle: share=linked skipped \(#recycle is a symbolic link - not followed\)$/.test(l)), logLines.join('\n'))
  })

  it('a repository that is not one directory name inside the share is skipped', async () => {
    setup('[escape]\n\tpath = /srv/x\n\trecycle:repository = ../../etc\n\t# anas:recycle-purge-days = 30\n')
    const result = await runRecyclePurge({ ...opts, smbConfPath: confPath })
    assert.deepEqual(result, { purged: 1, skipped: 1, failed: 0 }, logLines.join('\n'))
    assert.ok(logLines.some(l => /share=escape skipped \(repository '\.\.\/\.\.\/etc' is not a single directory name/.test(l)), logLines.join('\n'))
  })

  it('isSingleSegment', () => {
    for (const ok of ['#recycle', '.recycle', 'Recycle Bin'])
      assert.ok(isSingleSegment(ok), ok)
    for (const bad of ['', '.', '..', 'a/b', '../x', '/abs', 'a\\b'])
      assert.ok(!isSingleSegment(bad), bad)
  })

  it('a symlinked directory or file INSIDE the bin is left in place and counted, never followed', async () => {
    let victim = ''
    const { mediaBin } = setup((paths) => {
      victim = join(paths.root, 'victim')
      mkdirSync(victim, { recursive: true })
      writeFileSync(join(victim, 'precious.txt'), 'x')
      ageFile(join(victim, 'precious.txt'), 400 * DAY)
      return ''
    })
    symlinkSync(victim, join(mediaBin, 'link-dir'))
    symlinkSync(join(victim, 'precious.txt'), join(mediaBin, 'link-file'))
    const result = await runRecyclePurge({ ...opts, smbConfPath: confPath })
    assert.equal(result.purged, 1)
    assert.ok(existsSync(join(victim, 'precious.txt')))
    assert.ok(existsSync(join(mediaBin, 'link-dir')), 'the link itself is left alone')
    assert.ok(!existsSync(join(mediaBin, 'sub/old.txt')), 'the real aged file still goes')
  })

  it('purgeBin never walks a symlinked directory nested deep in the bin', async () => {
    // (The per-file realpath containment check is the backstop for a swap
    // between listing and unlink; the listing itself never descends a link.)
    const { mediaBin } = setup('')
    const outside = join(dir, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'precious.txt'), 'x')
    ageFile(join(outside, 'precious.txt'), 400 * DAY)
    symlinkSync(outside, join(mediaBin, 'sub', 'escape'))
    const r = await purgeBin(mediaBin, 30, { now: () => NOW, ageOf: mtimeAge })
    assert.ok(existsSync(join(outside, 'precious.txt')))
    assert.equal(r.removed, 1, 'only the real aged file inside the bin')
  })

  it('an unreadable smb.conf fails the run (the timer\'s unit result stays truthful)', async () => {
    setup('')
    const code = await main(['--smbconf', join(dir, 'does-not-exist.conf')])
    assert.equal(code, 1)
  })

  it('a purge that cannot walk the bin reports the share as failed and keeps sweeping', async () => {
    const { mediaBin } = setup('')
    // An unreadable subdirectory fails the walk (EACCES) — the share is
    // reported failed, the run continues, and the unit result stays truthful.
    const sub = join(mediaBin, 'sub')
    chmodSync(sub, 0o000)
    try {
      const result = await runRecyclePurge({ ...opts, smbConfPath: confPath })
      assert.equal(result.failed, 1)
      assert.ok(logLines.some(l => /^anas-recycle: share=media failed \(/.test(l)), logLines.join('\n'))
    }
    finally {
      chmodSync(sub, 0o755)
    }
  })
})

describe('purge runner argv', () => {
  it('defaults to /etc/samba/smb.conf and accepts --smbconf', () => {
    assert.deepEqual(parseRunnerArgs([]), { smbConfPath: '/etc/samba/smb.conf' })
    assert.deepEqual(parseRunnerArgs(['--smbconf', '/tmp/x.conf']), { smbConfPath: '/tmp/x.conf' })
    assert.throws(() => parseRunnerArgs(['--bogus']), /Missing value|--bogus/)
    assert.throws(() => parseRunnerArgs(['--bogus', 'x']), /Unknown argument/)
    assert.throws(() => parseRunnerArgs(['--smbconf']), /Missing value/)
  })
})
