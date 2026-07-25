import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  addMount,
  ANAS_MARKER,
  classifyOptions,
  disableMount,
  enableMount,
  getMount,
  hasMount,
  inlineCommentIndex,
  parseFstab,
  parseFstabDoc,
  removeMount,
  replaceMount,
  serializeFstabDoc,
  serializeMountLine,
} from '../fstab.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/mounts')
function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('fstab round-trip (byte identity)', () => {
  it('reproduces the hand-edited torture fstab BYTE-FOR-BYTE', () => {
    const text = loadFixture('fstab-handedited-sample')
    assert.equal(serializeFstabDoc(parseFstabDoc(text)), text)
  })

  it('reproduces the ANAS-managed and stock fstabs byte-for-byte', () => {
    for (const name of ['fstab-anas-managed', 'fstab-stock', 'fstab-boot-test.txt']) {
      const text = loadFixture(name)
      assert.equal(serializeFstabDoc(parseFstabDoc(text)), text, name)
    }
  })

  it('round-trips a file with no trailing newline', () => {
    const text = 'UUID=abc /mnt/x ext4 defaults,nofail 0 2'
    assert.equal(serializeFstabDoc(parseFstabDoc(text)), text)
  })
})

describe('parseFstab — which lines are entries', () => {
  const doc = parseFstab(loadFixture('fstab-handedited-sample'))

  it('parses the manageable entries and skips comments / commented-out', () => {
    const mps = doc.map(e => e.mountpoint)
    // The commented-out USB line (#UUID=…) must NOT be revived.
    assert.ok(!mps.includes('/mnt/usb'))
    // Real entries (incl. bind + tmpfs) are present.
    assert.deepEqual(mps, ['/', '/boot/efi', '/mnt/spare', '/mnt/weird', '/mnt/media', '/export/shared', '/scratch'])
  })

  it('carries unknown/exotic options verbatim in passthrough', () => {
    const weird = getMount(loadFixture('fstab-handedited-sample'), '/mnt/weird')!
    assert.equal(weird.options.common.nofail, true)
    // defaults + the three exotic options round-trip verbatim, in order.
    assert.equal(weird.options.passthrough, 'defaults,x-gvfs-show,x-anas-note=keep-this-unknown-option,comment=cloudconfig')
  })

  it('splits NFS options into the structured tier', () => {
    const media = getMount(loadFixture('fstab-handedited-sample'), '/mnt/media')!
    assert.equal(media.fstype, 'nfs4')
    assert.equal(media.options.common.nofail, true)
    assert.equal(media.options.common.netdev, true)
    assert.equal(media.options.nfs?.hard, false) // soft
    assert.equal(media.options.nfs?.timeo, 150)
    assert.equal(media.options.nfs?.retrans, 3)
  })
})

describe('classifyOptions — CIFS credentials + tiers', () => {
  it('extracts the credentials file path (never a secret) and cifs tier', () => {
    const tokens = 'credentials=/etc/anas/creds/anastest.cred,vers=3.1.1,uid=1002,gid=1002,nofail'.split(',')
    const { options, credentialsFile, inlineCredentials } = classifyOptions('cifs', tokens)
    assert.equal(credentialsFile, '/etc/anas/creds/anastest.cred')
    assert.equal(options.cifs?.vers, '3.1.1')
    assert.equal(options.cifs?.uid, 1002)
    assert.equal(options.common.nofail, true)
    assert.equal(options.passthrough, '')
    assert.equal(inlineCredentials, undefined) // secure entry — no inline creds
  })
})

describe('classifyOptions — inline plaintext CIFS credentials (BUG-1 security)', () => {
  // The production shape: username/password INLINE, password containing `#` and
  // other specials, options both BEFORE and AFTER the credentials.
  const tokens = 'ro,nofail,noatime,vers=3.1.1,cache=strict,username=ccebelenski,password=Xy#zzy!$,domain=CORP,uid=1000,forceuid,gid=100'.split(',')

  it('extracts username/password/domain into the structured channel — NOT passthrough', () => {
    const { options, inlineCredentials } = classifyOptions('cifs', tokens)
    assert.ok(inlineCredentials)
    assert.equal(inlineCredentials!.username, 'ccebelenski')
    assert.equal(inlineCredentials!.password, 'Xy#zzy!$') // the `#`/specials survive WHOLE
    assert.equal(inlineCredentials!.domain, 'CORP')
    // The secret must never ride the verbatim passthrough (returned to clients).
    assert.ok(!options.passthrough.includes('password'))
    assert.ok(!options.passthrough.includes('username'))
    assert.ok(!options.passthrough.includes('Xy#zzy'))
    // Genuinely-unrecognized options DO round-trip in passthrough.
    assert.equal(options.passthrough, 'cache=strict,forceuid')
  })

  it('options AFTER a `#`-bearing password are still parsed (no mid-field comment truncation)', () => {
    const { options } = classifyOptions('cifs', tokens)
    assert.equal(options.cifs?.uid, 1000)
    assert.equal(options.cifs?.gid, 100) // past the password — proves BUG-2 does not bite the option list
    assert.equal(options.common.readOnly, true)
    assert.equal(options.common.noatime, true)
  })
})

describe('inlineCommentIndex — token-starting `#` only (BUG-2)', () => {
  it('finds a whitespace-preceded `#` (a genuine trailing comment)', () => {
    assert.equal(inlineCommentIndex('a b c 0 0   # note'), 12)
  })
  it('ignores a `#` embedded inside a field (a password value)', () => {
    assert.equal(inlineCommentIndex('//h/s /m cifs username=u,password=Xy#zzy,uid=1 0 0'), -1)
  })
  it('a leading `#` is column 0', () => {
    assert.equal(inlineCommentIndex('# whole-line comment'), 0)
  })
})

describe('a fstab line with a `#` inside the password parses whole + round-trips', () => {
  const line = '//10.0.0.114/chiap2 /chiapools/chiap2 cifs ro,nofail,username=u,password=Xy#zzy,uid=1000,gid=100 0 0\n'

  it('parseFstabDoc → serializeFstabDoc is byte-identical (raw preserved)', () => {
    assert.equal(serializeFstabDoc(parseFstabDoc(line)), line)
  })

  it('the entry parses through the `#` — mountpoint, uid, gid, and inline creds all intact', () => {
    const entry = getMount(line, '/chiapools/chiap2')!
    assert.equal(entry.fstype, 'cifs')
    assert.equal(entry.options.cifs?.uid, 1000)
    assert.equal(entry.options.cifs?.gid, 100)
    assert.equal(entry.inlineCredentials?.password, 'Xy#zzy')
    assert.equal(entry.inlineCredentials?.username, 'u')
  })
})

describe('surgical edits touch only the targeted line', () => {
  it('replaceMount rewrites only the media line and keeps its inline comment', () => {
    const before = loadFixture('fstab-handedited-sample')
    const media = getMount(before, '/mnt/media')!
    media.options.common.readOnly = true
    const after = replaceMount(before, '/mnt/media', media)

    const beforeLines = before.split('\n')
    const afterLines = after.split('\n')
    assert.equal(afterLines.length, beforeLines.length)
    for (let i = 0; i < beforeLines.length; i++) {
      if (beforeLines[i].includes('/mnt/media')) {
        assert.notEqual(afterLines[i], beforeLines[i]) // the one changed line
        assert.ok(afterLines[i].startsWith('ro ') || afterLines[i].includes(' ro,') || afterLines[i].includes(',ro'))
        assert.ok(afterLines[i].endsWith('# media library, read-mostly')) // comment kept
      }
      else {
        assert.equal(afterLines[i], beforeLines[i], `line ${i} must be untouched`)
      }
    }
  })

  it('addMount appends before the trailing newline; removeMount drops one line', () => {
    const before = loadFixture('fstab-anas-managed')
    const entry = { spec: 'UUID=xyz', mountpoint: '/mnt/new', fstype: 'ext4', options: { common: { readOnly: false, nofail: true, noauto: false, automount: false, noatime: false, nosuid: false, nodev: false, netdev: false }, passthrough: '' }, dump: 0, pass: 2 }
    const added = addMount(before, entry)
    assert.ok(hasMount(added, '/mnt/new'))
    assert.equal(serializeMountLine(entry), 'UUID=xyz /mnt/new ext4 nofail 0 2')
    const removed = removeMount(added, '/mnt/new')
    assert.equal(removed, before) // adding then removing is a no-op on the bytes
  })
})

describe('disable / enable marker (byte-identical both directions)', () => {
  it('disable prefixes #ANAS  and enable restores the original bytes exactly', () => {
    const before = loadFixture('fstab-anas-managed')
    const disabled = disableMount(before, '/mnt/anas-nfs')
    assert.notEqual(disabled, before)
    // The disabled line is `#ANAS ` + the original verbatim.
    const origLine = before.split('\n').find(l => l.includes('/mnt/anas-nfs'))!
    assert.ok(disabled.split('\n').includes(`${ANAS_MARKER}${origLine}`))
    // Enabling restores the exact original file.
    assert.equal(enableMount(disabled, '/mnt/anas-nfs'), before)
  })

  it('a disabled line parses as a disabled entry (round-trips byte-identical)', () => {
    const text = `${ANAS_MARKER}127.0.0.1:/srv/nfs/export1  /mnt/z  nfs4  defaults,nofail  0  0\n`
    const doc = parseFstabDoc(text)
    assert.equal(serializeFstabDoc(doc), text) // byte identity
    assert.equal(doc[0].kind, 'entry')
    const entries = parseFstab(text)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].mountpoint, '/mnt/z')
    assert.equal(entries[0].disabled, true)
    assert.ok(getMount(text, '/mnt/z'))
  })

  it('fail-open: a prose comment starting with #ANAS is an ordinary comment', () => {
    const text = '#ANAS this is just a human note, not an entry\n'
    const doc = parseFstabDoc(text)
    assert.equal(doc[0].kind, 'other')
    assert.equal(parseFstab(text).length, 0)
    assert.equal(serializeFstabDoc(doc), text) // still byte-identical
  })
})
