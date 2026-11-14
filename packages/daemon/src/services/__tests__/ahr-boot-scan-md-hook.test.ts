import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { PVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { ahrBootScan, rewireMdHook } from '../ahr-boot-scan.js'

/**
 * cr3 "md hook re-wire": the uninstaller removes ANAS's PROGRAM line; after a
 * reinstall nothing put it back. At daemon start the boot scan writes it again
 * — through the real `installProgramHook` — only for a pool that is ANAS's own
 * by identity AND is the full md → LVM stack, and only when the conf carries
 * no PROGRAM line at all. Every other case leaves the file byte-identical.
 */
const HOOK = 'PROGRAM /usr/local/bin/anas-md-event'
const PIN = 'ARRAY /dev/md/tank-r1 metadata=1.2 UUID=aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa'
const MDSTAT = 'Personalities : [raid1]\nmd127 : active raid1 sdc1[1] sdb1[0]\n      2096128 blocks super 1.2 [2/2] [UU]\n\nunused devices: <none>\n'
const EXPORT = (name: string, uuid: string) => `MD_LEVEL=raid1\nMD_DEVICES=2\nMD_METADATA=1.2\nMD_UUID=${uuid}\nMD_DEVNAME=${name}\nMD_NAME=host:${name}\n`
const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 })
const TANK_PVS = JSON.stringify({ report: [{ pv: [{ pv_name: '/dev/md127', vg_name: 'tank', pv_size: '2146435072', pv_free: '0' }] }] })

describe('md hook re-wire (cr3)', () => {
  let dir: string
  let conf: string
  const lines: string[] = []
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-md-hook-'))
    await mkdir(join(dir, 'intents'))
    conf = join(dir, 'mdadm.conf')
    process.env.ANAS_MDADM_CONF = conf
    lines.length = 0
  })
  afterEach(async () => {
    delete process.env.ANAS_MDADM_CONF
    await rm(dir, { recursive: true, force: true })
  })

  /** A node with ONE live array named `<name>`, its detail, and the given pvs answer. */
  function node(name: string, uuid: string, pvs: string | null): MockExecutor {
    const m = new MockExecutor()
    m.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: ok(MDSTAT) })
    m.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: ok(EXPORT(name, uuid)) })
    m.addFixture({ command: '/usr/sbin/pvs', args: [...PVS_ARGS], result: pvs === null ? { stdout: '', stderr: '  Global lock failed', exitCode: 5 } : ok(pvs) })
    m.addFixture({ command: '/usr/sbin/vgs', args: [...VGS_ARGS], result: ok(JSON.stringify({ report: [{ vg: [{ vg_name: 'tank' }] }] })) })
    m.addFixture({ command: '/usr/bin/systemctl', result: ok('') })
    return m
  }
  const scan = (m: MockExecutor) => ahrBootScan(m, { intentDir: join(dir, 'intents'), log: l => lines.push(l), mdadmConfPath: conf })

  it('an ANAS pool (pinned AND a PV of its VG) with no PROGRAM line: the hook is written, mdmonitor try-restarted, no initramfs', async () => {
    await writeFile(conf, `# keep me\n${PIN}\n`)
    const m = node('tank-r1', 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa', TANK_PVS)
    const report = await scan(m)
    assert.equal(report.mdHook, 'installed')
    assert.equal(await readFile(conf, 'utf8'), `# keep me\n${PIN}\n${HOOK}\n`)
    assert.ok(m.calls.some(c => c.command === '/usr/bin/systemctl' && c.args.join(' ') === 'try-restart mdmonitor.service'))
    assert.ok(!m.calls.some(c => c.command === '/usr/sbin/update-initramfs'), 'a PROGRAM-only change does not concern early-boot assembly')
  })

  it('ANAS\'s line already present: nothing changes', async () => {
    await writeFile(conf, `${PIN}\n${HOOK}\n`)
    const report = await scan(node('tank-r1', 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa', TANK_PVS))
    assert.equal(report.mdHook, 'present')
    assert.equal(await readFile(conf, 'utf8'), `${PIN}\n${HOOK}\n`)
  })

  it('a FOREIGN PROGRAM line is left, and named in one log line', async () => {
    const text = `${PIN}\nPROGRAM /usr/local/sbin/site-raid-alert\n`
    await writeFile(conf, text)
    const report = await scan(node('tank-r1', 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa', TANK_PVS))
    assert.equal(report.mdHook, 'foreign')
    assert.equal(await readFile(conf, 'utf8'), text)
    assert.equal(lines.filter(l => l.includes('reason=foreign-program program=/usr/local/sbin/site-raid-alert')).length, 1)
  })

  it('ANAS\'s line COMMENTED OUT is the operator\'s opt-out: the file is left alone', async () => {
    const text = `${PIN}\n#PROGRAM /usr/local/bin/anas-md-event\n`
    await writeFile(conf, text)
    const report = await scan(node('tank-r1', 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa', TANK_PVS))
    assert.equal(report.mdHook, 'opted-out')
    assert.equal(await readFile(conf, 'utf8'), text)
    assert.equal(lines.filter(l => l.includes('reason=operator-opt-out')).length, 1)
  })

  // cr3 review2 4 (probe b-mdhook.mts B4c/B4d): the opt-out in every
  // spelling mdadm accepts for the live line.
  for (const optOut of ['#program /usr/local/bin/anas-md-event', '#PROGRAM /usr/local/bin/anas-md-event   # off while I test', '# prog /usr/local/bin/anas-md-event', '#PROGRAM /usr/local/bin/anas-md-event\r']) {
    it(`cr3 review2 4: the opt-out spelled ${JSON.stringify(optOut)} is seen — the file is left alone`, async () => {
      const text = `${PIN}\n${optOut}\n`
      await writeFile(conf, text)
      const report = await scan(node('tank-r1', 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa', TANK_PVS))
      assert.equal(report.mdHook, 'opted-out')
      assert.equal(await readFile(conf, 'utf8'), text)
    })
  }

  it('a hand-made `ARRAY /dev/md/backup-r1 ... name=host:backup-r1` on a node with NO AHR pool is not touched', async () => {
    // The operator's own mirror, in the same ARRAY form ANAS writes; no VG.
    const text = 'ARRAY /dev/md/backup-r1 metadata=1.2 UUID=bbbbbbbb:bbbbbbbb:bbbbbbbb:bbbbbbbb name=host:backup-r1\n'
    await writeFile(conf, text)
    const report = await scan(node('backup-r1', 'bbbbbbbb:bbbbbbbb:bbbbbbbb:bbbbbbbb', JSON.stringify({ report: [{ pv: [] }] })))
    assert.equal(report.mdHook, 'no-pools')
    assert.equal(await readFile(conf, 'utf8'), text)
  })

  it('no AHR array at all: nothing read, nothing written', async () => {
    await writeFile(conf, '# empty\n')
    const m = new MockExecutor()
    m.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: ok('Personalities : []\nunused devices: <none>\n') })
    const report = await scan(m)
    assert.equal(report.mdHook, 'no-pools')
    assert.equal(await readFile(conf, 'utf8'), '# empty\n')
  })

  it('mdadm.conf that cannot be read: logged, nothing done', async () => {
    await mkdir(conf) // a directory where the file should be: EISDIR
    const outcome = await rewireMdHook(node('tank-r1', 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa', TANK_PVS), { mdadmConfPath: conf, log: l => lines.push(l), ownedArrays: [{ pool: 'tank', band: 1, kernelName: 'md127' }] })
    assert.equal(outcome, 'unreadable')
    assert.ok(lines.some(l => l.includes('reason=conf-unreadable')))
  })

  it('a topology that could not be read (md view, or pvs at the edit) is no reason to edit', async () => {
    await writeFile(conf, `${PIN}\n`)
    assert.equal(await rewireMdHook(new MockExecutor(), { mdadmConfPath: conf, log: () => {}, ownedArrays: null }), 'unreadable')
    assert.equal(await rewireMdHook(node('tank-r1', 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa', null), { mdadmConfPath: conf, log: () => {}, ownedArrays: [{ pool: 'tank', band: 1, kernelName: 'md127' }] }), 'unreadable')
    // An unreadable mdstat in the full scan: the md view is unknown.
    const m = new MockExecutor()
    m.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: { stdout: '', stderr: 'cat: /proc/mdstat: Permission denied', exitCode: 1 } })
    assert.equal((await scan(m)).mdHook, 'unreadable')
    assert.equal(await readFile(conf, 'utf8'), `${PIN}\n`)
  })

  it('cr3 review2 6: a pvs that answers exit 0 in the wrong shape is unreadable — never "no pools"', async () => {
    await writeFile(conf, `${PIN}\n`)
    const m = node('tank-r1', 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa', TANK_PVS)
    m.prependFixture({ command: '/usr/sbin/pvs', args: [...PVS_ARGS], result: ok('  WARNING: something\n') })
    assert.equal((await scan(m)).mdHook, 'unreadable')
    assert.equal(await readFile(conf, 'utf8'), `${PIN}\n`)
  })

  // cr3 review2 12: the re-wire's cost, pinned — it runs at EVERY daemon start.
  it('cr3 review2 12: cost — no AHR arrays: zero commands; ANAS line present: zero; pool present + no line: exactly one pvs', async () => {
    await writeFile(conf, `${PIN}\n`)
    const none = new MockExecutor()
    assert.equal(await rewireMdHook(none, { mdadmConfPath: conf, log: () => {}, ownedArrays: [] }), 'no-pools')
    assert.equal(none.calls.length, 0)

    await writeFile(conf, `${PIN}\n${HOOK}\n`)
    const present = new MockExecutor()
    assert.equal(await rewireMdHook(present, { mdadmConfPath: conf, log: () => {}, ownedArrays: [{ pool: 'tank', band: 1, kernelName: 'md127' }] }), 'present')
    assert.equal(present.calls.length, 0)

    await writeFile(conf, `${PIN}\n`)
    const m = node('tank-r1', 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa', TANK_PVS)
    assert.equal(await rewireMdHook(m, { mdadmConfPath: conf, log: () => {}, ownedArrays: [{ pool: 'tank', band: 1, kernelName: 'md127' }] }), 'installed')
    assert.deepEqual(m.calls.map(c => c.command), ['/usr/sbin/pvs', '/usr/bin/systemctl'], 'one pvs read, then the mdmonitor try-restart')
  })

  // root writes through a read-only directory, so this half cannot be staged as root.
  it('a failure of the edit never fails the boot scan; a failed mdmonitor restart is logged beside a written line', { skip: process.getuid?.() === 0 }, async () => {
    // The conf's directory is read-only: the atomic write cannot land.
    const roDir = join(dir, 'ro')
    await mkdir(roDir)
    const roConf = join(roDir, 'mdadm.conf')
    await writeFile(roConf, `${PIN}\n`)
    await chmod(roDir, 0o555)
    try {
      process.env.ANAS_MDADM_CONF = roConf
      const report = await ahrBootScan(node('tank-r1', 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa', TANK_PVS), { intentDir: join(dir, 'intents'), log: l => lines.push(l), mdadmConfPath: roConf })
      assert.equal(report.mdHook, 'failed')
      assert.ok(lines.some(l => l.includes('md-hook=failed')))
      assert.equal(await readFile(roConf, 'utf8'), `${PIN}\n`)
    }
    finally {
      await chmod(roDir, 0o755)
    }
    await writeFile(conf, `${PIN}\n`)
    process.env.ANAS_MDADM_CONF = conf
    const m = node('tank-r1', 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa', TANK_PVS)
    m.prependFixture({ command: '/usr/bin/systemctl', throws: new Error('spawn systemctl ENOENT') })
    assert.equal((await scan(m)).mdHook, 'installed')
    assert.ok(lines.some(l => l.includes('mdmonitor-try-restart=failed(spawn systemctl ENOENT)')))
  })
})
