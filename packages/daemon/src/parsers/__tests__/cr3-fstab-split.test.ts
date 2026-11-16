import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CreateMountRequest } from '@anas/shared'
import { entryFromRequest, fstabLineFor } from '../../services/mounts.js'
import { addMount, addMountOption, disableMount, enableMount, getMount, hasMount, parseFstab, removeMount } from '../fstab.js'

/**
 * cr3.mounts M3 — the fstab reader splits fields exactly where libmount does.
 *
 * libmount (mount, systemd's fstab generator) separates fields on ASCII SPACE
 * and TAB only; every other byte — NBSP, U+2003, U+3000, VT, FF, a CR inside a
 * field — is data. The reader used JavaScript's `\s` (all of them), so a line
 * ANAS itself wrote for a mountpoint or a CIFS share carrying a Unicode space
 * was unreadable to ANAS: Remove left the line (and said it was removed), Edit
 * answered 404, and a second create appended a duplicate line.
 *
 * The oracle is util-linux's own reader, run on a scratch file:
 *   findmnt --fstab -F fixtures/mounts/fstab-libmount-split --json
 *     > fixtures/mounts/findmnt-fstab-libmount-split.json
 * (util-linux 2.42.4, 2026-11-14; no system state read or changed).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures/mounts')

describe('cr3.mounts M3 — fstab fields split as libmount splits them', () => {
  it('reads every line of the libmount capture exactly as findmnt --fstab does', () => {
    const fstab = readFileSync(join(FIXTURES, 'fstab-libmount-split'), 'utf-8')
    const libmount = JSON.parse(readFileSync(join(FIXTURES, 'findmnt-fstab-libmount-split.json'), 'utf-8')) as {
      filesystems: { target: string, source: string, fstype: string }[]
    }
    const ours = parseFstab(fstab).map(e => ({ target: e.mountpoint, source: e.spec, fstype: e.fstype }))
    assert.deepEqual(ours, libmount.filesystems.map(f => ({ target: f.target, source: f.source, fstype: f.fstype })))
  })

  it('a mountpoint carrying NBSP that ANAS writes reads back as the same mount (probe p1 a)', () => {
    const req = CreateMountRequest.parse({ type: 'nfs', server: 'nas', remotePath: '/export', mountpoint: '/mnt/media old' })
    const { entry } = entryFromRequest(req, '/etc/anas/creds')
    const before = '# hand-written\nnas:/real /mnt/media nfs4 rw,nofail 0 0\n'
    const written = addMount(before, entry)
    const back = getMount(written, req.mountpoint)
    assert.ok(back, 'the line ANAS wrote is found by its mountpoint')
    assert.equal(back.spec, 'nas:/export')
    assert.equal(back.fstype, 'nfs4')
    // The hand-written `/mnt/media` line is still its own, untouched mount.
    assert.equal(getMount(written, '/mnt/media')?.spec, 'nas:/real')
    assert.equal(hasMount(written, req.mountpoint), true, 'the create collision gate sees the line')
    assert.equal(removeMount(written, req.mountpoint), before, 'Remove takes exactly that line out')
    assert.equal(fstabLineFor(written, req.mountpoint), written.split('\n')[2])
  })

  it('a CIFS share named with an ideographic space reads back (probe p1 b)', () => {
    const req = CreateMountRequest.parse({ type: 'cifs', server: 'nas', remotePath: '共有　写真', mountpoint: '/mnt/photos', credentials: { username: 'u', password: 'p' } })
    const { entry } = entryFromRequest(req, '/etc/anas/creds')
    const written = addMount('', entry)
    const back = getMount(written, '/mnt/photos')
    assert.ok(back, 'the CIFS line is read back')
    assert.equal(back.spec, '//nas/共有　写真')
    assert.equal(back.fstype, 'cifs')
    assert.equal(hasMount(written, '/mnt/photos'), true)
  })

  it('a CRLF line keeps its CR through the byte-surgical option writers', () => {
    const text = 'nas:/c /mnt/cr nfs4 nofail\r\n'
    assert.equal(getMount(text, '/mnt/cr')?.options.common.nofail, true, 'the CR is the line ending, not part of the options')
    const added = addMountOption(text, '/mnt/cr', 'x-systemd.before=a.service')
    assert.equal(added, 'nas:/c /mnt/cr nfs4 nofail,x-systemd.before=a.service\r\n')
    assert.equal(enableMount(disableMount(text, '/mnt/cr'), '/mnt/cr'), text, 'disable then enable is byte-identical')
  })
})
