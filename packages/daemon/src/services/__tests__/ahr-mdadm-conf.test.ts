import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MdadmForeignProgramError } from '../../parsers/mdadm-conf.js'
import {
  ANAS_MD_EVENT_HOOK,
  ARRAY_PIN_REQUIRES_INITRAMFS,
  DEFAULT_MDADM_CONF,
  installProgramHook,
  pinArrays,
  unpinArrays,
} from '../ahr-mdadm-conf.js'

const STOCK = `# mdadm.conf
#DEVICE partitions containers
HOMEHOST <system>
MAILADDR root
ARRAY /dev/md0 metadata=1.2 name=oldbox:0 UUID=11111111:22222222:33333333:44444444
`

const R1 = { name: 'tank-r1', uuid: '9f3c1a2b:4d5e6f70:8192a3b4:c5d6e7f8' }
const R2 = { name: 'tank-r2', uuid: '01234567:89abcdef:01234567:89abcdef' }

describe('ahr-mdadm-conf service', () => {
  let dir: string
  let conf: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-mdadm-'))
    conf = join(dir, 'mdadm.conf')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    delete process.env.ANAS_MDADM_CONF
  })

  it('documents the initramfs contract without running commands', () => {
    assert.equal(ARRAY_PIN_REQUIRES_INITRAMFS, true)
    assert.equal(DEFAULT_MDADM_CONF, '/etc/mdadm/mdadm.conf')
    assert.equal(ANAS_MD_EVENT_HOOK, '/usr/local/bin/anas-md-event')
  })

  it('pinArrays adds one ARRAY line per array, preserving the rest byte-for-byte', async () => {
    await writeFile(conf, STOCK)
    await pinArrays([R1, R2], conf)
    const out = await readFile(conf, 'utf8')
    assert.equal(out, `${STOCK}ARRAY /dev/md/${R1.name} metadata=1.2 UUID=${R1.uuid}\nARRAY /dev/md/${R2.name} metadata=1.2 UUID=${R2.uuid}\n`)
    // config-writer backed up the pre-edit content.
    assert.equal(await readFile(`${conf}.bak`, 'utf8'), STOCK)
  })

  it('pinArrays creates a missing conf and is idempotent (no rewrite on re-pin)', async () => {
    await pinArrays([R1], conf)
    const once = await readFile(conf, 'utf8')
    assert.equal(once, `ARRAY /dev/md/${R1.name} metadata=1.2 UUID=${R1.uuid}\n`)

    await pinArrays([R1], conf)
    assert.equal(await readFile(conf, 'utf8'), once)
    // Second call was a byte no-op — editConfig writes no backup for no-ops.
    await assert.rejects(readFile(`${conf}.bak`, 'utf8'))
  })

  it('pinArrays with an empty list touches nothing', async () => {
    await pinArrays([], conf)
    await assert.rejects(readFile(conf, 'utf8')) // still absent
  })

  it('unpinArrays removes only the named UUIDs — foreign ARRAY lines survive', async () => {
    await writeFile(conf, STOCK)
    await pinArrays([R1, R2], conf)
    await unpinArrays([R1.uuid, R2.uuid], conf)
    assert.equal(await readFile(conf, 'utf8'), STOCK)
  })

  // cr.31b: ANAS's monitor hook retires with its last pinned array — guest
  // philosophy, leave nothing behind that ANAS no longer needs.
  describe('unpinArrays retires the ANAS PROGRAM hook with the last AHR pin', () => {
    const R2POOL = { name: 'data-r1', uuid: 'deadbeef:00000000:00000000:00000001' }

    it('the last AHR pin going removes the PROGRAM line; every other byte survives', async () => {
      await writeFile(conf, STOCK)
      await pinArrays([R1], conf)
      await installProgramHook(undefined, conf)
      await unpinArrays([R1.uuid], conf)
      // Exactly STOCK again — the pin is gone, the hook is gone, and the
      // non-AHR foreign ARRAY (name=oldbox:0) never counted as a reason to
      // keep ANAS's monitor.
      assert.equal(await readFile(conf, 'utf8'), STOCK)
    })

    it('the hook stays while ANOTHER pool is still pinned, and goes with the last of its own', async () => {
      await writeFile(conf, STOCK)
      await pinArrays([R1, R2POOL], conf)
      await installProgramHook(undefined, conf)

      await unpinArrays([R1.uuid], conf)
      const mid = await readFile(conf, 'utf8')
      assert.ok(!mid.includes(R1.uuid))
      assert.ok(mid.includes(`ARRAY /dev/md/${R2POOL.name} metadata=1.2 UUID=${R2POOL.uuid}`))
      assert.ok(mid.includes(`PROGRAM ${ANAS_MD_EVENT_HOOK}`), 'hook stays while another pool is pinned')

      await unpinArrays([R2POOL.uuid], conf)
      assert.equal(await readFile(conf, 'utf8'), STOCK)
    })

    it('an operator\'s own PROGRAM line is never touched, even by the last unpin', async () => {
      const operatorHook = `${STOCK}PROGRAM /usr/sbin/handle-mdadm-events\n`
      await writeFile(conf, operatorHook)
      await pinArrays([R1], conf)
      await unpinArrays([R1.uuid], conf)
      assert.equal(await readFile(conf, 'utf8'), operatorHook)
    })

    it('with BOTH the operator\'s PROGRAM line and ANAS\'s hook present, the last unpin removes ONLY the ANAS line', async () => {
      // A conf that carries a foreign PROGRAM line while ANAS's own hook is
      // still installed: retiring ANAS's hook must remove exactly that line —
      // a pathless "remove whatever PROGRAM exists" would take the operator's
      // hook with it.
      const both = `${STOCK}PROGRAM /usr/sbin/handle-mdadm-events\nPROGRAM ${ANAS_MD_EVENT_HOOK}\n`
      await writeFile(conf, both)
      await pinArrays([R1], conf)
      await unpinArrays([R1.uuid], conf)
      const out = await readFile(conf, 'utf8')
      assert.ok(!out.includes(`PROGRAM ${ANAS_MD_EVENT_HOOK}`), 'ANAS\'s own hook retires')
      assert.ok(out.includes('PROGRAM /usr/sbin/handle-mdadm-events'), 'the operator\'s hook survives')
      assert.ok(!out.includes(R1.uuid), 'the pin is gone')
    })

    it('a pinned array ANAS did not write (hand-built, AHR-shaped name) keeps the hook', async () => {
      // Same naming convention, unknown to this pool's destroy: counting it
      // conservatively means the monitor keeps reporting for it.
      const handBuilt = `${STOCK}ARRAY /dev/md/handy-r1 metadata=1.2 UUID=cafe0000:00000000:00000000:00000001\n`
      await writeFile(conf, handBuilt)
      await pinArrays([R1], conf)
      await installProgramHook(undefined, conf)
      await unpinArrays([R1.uuid], conf)
      const out = await readFile(conf, 'utf8')
      assert.ok(out.includes(`PROGRAM ${ANAS_MD_EVENT_HOOK}`))
      assert.ok(!out.includes(R1.uuid))
    })
  })

  it('installProgramHook appends the PROGRAM line and is idempotent', async () => {
    await writeFile(conf, STOCK)
    await installProgramHook(undefined, conf)
    const out = await readFile(conf, 'utf8')
    assert.equal(out, `${STOCK}PROGRAM ${ANAS_MD_EVENT_HOOK}\n`)
    await installProgramHook(undefined, conf)
    assert.equal(await readFile(conf, 'utf8'), out)
  })

  it('installProgramHook refuses to overwrite a foreign PROGRAM (file untouched)', async () => {
    const foreign = `${STOCK}PROGRAM /usr/sbin/handle-mdadm-events\n`
    await writeFile(conf, foreign)
    await assert.rejects(installProgramHook(undefined, conf), MdadmForeignProgramError)
    assert.equal(await readFile(conf, 'utf8'), foreign)
  })

  it('resolves the conf path from ANAS_MDADM_CONF when no explicit path is given', async () => {
    process.env.ANAS_MDADM_CONF = conf
    await writeFile(conf, STOCK)
    await pinArrays([R1])
    const out = await readFile(conf, 'utf8')
    assert.ok(out.includes(`ARRAY /dev/md/${R1.name} metadata=1.2 UUID=${R1.uuid}`))
  })
})
