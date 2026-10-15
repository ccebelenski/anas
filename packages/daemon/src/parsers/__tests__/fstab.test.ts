import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { X_ANAS_DISABLED_KEPT_TOKEN, X_ANAS_DISABLED_TOKEN } from '@anas/shared'
import {
  addMount,
  addMountOption,
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

  it('consumes `guest` structurally — a credential-less line round-trips exactly one', () => {
    const { options, credentialsFile } = classifyOptions('cifs', 'guest,x-anas-note=keepme'.split(','))
    assert.equal(credentialsFile, undefined)
    assert.equal(options.passthrough, 'x-anas-note=keepme') // guest is NOT parked in passthrough
    const line = serializeMountLine({ spec: '//nas/share', mountpoint: '/mnt/g', fstype: 'cifs', options, dump: 0, pass: 0 })
    assert.equal(line, '//nas/share /mnt/g cifs guest,x-anas-note=keepme 0 0')
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
    // cache=strict and forceuid are now MODELED into the CIFS tier (18.9), so
    // nothing unrecognized remains — passthrough is empty.
    assert.equal(options.cifs?.cache, 'strict')
    assert.equal(options.cifs?.forceuid, true)
    assert.equal(options.passthrough, '')
  })

  it('options AFTER a `#`-bearing password are still parsed (no mid-field comment truncation)', () => {
    const { options } = classifyOptions('cifs', tokens)
    assert.equal(options.cifs?.uid, 1000)
    assert.equal(options.cifs?.gid, 100) // past the password — proves BUG-2 does not bite the option list
    assert.equal(options.common.readOnly, true)
    assert.equal(options.common.noatime, true)
  })
})

describe('18.9 — common CIFS/NFS option tiers round-trip (parse → build → parse)', () => {
  // Classify a comma option string, serialize the entry, re-parse it, and return
  // both structured views — a proof the new options land in their tier and
  // survive serialization identically (no drift into passthrough).
  function roundtrip(fstype: string, spec: string, optStr: string) {
    const { options, credentialsFile } = classifyOptions(fstype, optStr.split(','))
    const entry = {
      spec,
      mountpoint: '/mnt/rt',
      fstype,
      options,
      dump: 0,
      pass: 0,
      ...(credentialsFile !== undefined ? { credentialsFile } : {}),
    }
    const line = serializeMountLine(entry)
    const reparsed = getMount(line, '/mnt/rt')!
    return { options, line, reparsed }
  }

  it('a rich CIFS line: cache/mfsymlinks/forceuid/rsize/sec land in the CIFS tier, not passthrough', () => {
    const { options, reparsed } = roundtrip(
      'cifs',
      '//nas/share',
      'ro,nofail,vers=3.1.1,cache=strict,mfsymlinks,forceuid,forcegid,noserverino,nobrl,rsize=1048576,wsize=1048576,actimeo=30,sec=ntlmssp,iocharset=utf8,uid=1000,gid=100,file_mode=0644,dir_mode=0755,noexec',
    )
    assert.equal(options.cifs?.cache, 'strict')
    assert.equal(options.cifs?.mfsymlinks, true)
    assert.equal(options.cifs?.forceuid, true)
    assert.equal(options.cifs?.forcegid, true)
    assert.equal(options.cifs?.noserverino, true)
    assert.equal(options.cifs?.nobrl, true)
    assert.equal(options.cifs?.rsize, 1048576)
    assert.equal(options.cifs?.wsize, 1048576)
    assert.equal(options.cifs?.actimeo, 30)
    assert.equal(options.cifs?.sec, 'ntlmssp')
    assert.equal(options.cifs?.iocharset, 'utf8')
    assert.equal(options.common.noexec, true)
    assert.equal(options.passthrough, '') // every option recognized into a tier
    // parse → build → parse identity.
    assert.deepEqual(reparsed.options, options)
  })

  it('a rich NFS line: proto/soft/sec/nconnect land in the NFS tier, not passthrough', () => {
    const { options, reparsed } = roundtrip(
      'nfs4',
      'nas:/export/data',
      'nofail,_netdev,vers=4.2,soft,proto=tcp,sec=sys,nconnect=8,actimeo=60,noac,bg,lookupcache=pos,timeo=150,retrans=3,rsize=1048576,wsize=1048576',
    )
    assert.equal(options.nfs?.hard, false) // soft
    assert.equal(options.nfs?.proto, 'tcp')
    assert.equal(options.nfs?.sec, 'sys')
    assert.equal(options.nfs?.nconnect, 8)
    assert.equal(options.nfs?.actimeo, 60)
    assert.equal(options.nfs?.noac, true)
    assert.equal(options.nfs?.bg, true)
    assert.equal(options.nfs?.lookupcache, 'pos')
    assert.equal(options.common.netdev, true)
    assert.equal(options.passthrough, '')
    assert.deepEqual(reparsed.options, options)
  })

  it('an unrecognized enum value round-trips verbatim in passthrough (schema-safe)', () => {
    const { options } = classifyOptions('cifs', 'nofail,cache=bogus,sec=weird,iocharset=bad$char'.split(','))
    assert.equal(options.cifs?.cache, undefined)
    assert.equal(options.cifs?.sec, undefined)
    assert.equal(options.cifs?.iocharset, undefined)
    // Each unrecognized value survives verbatim — never a schema violation on return.
    assert.equal(options.passthrough, 'cache=bogus,sec=weird,iocharset=bad$char')
  })
})

describe('fstab field escaping (cr.2, review C2)', () => {
  const NOFAIL_COMMON = {
    readOnly: false,
    nofail: true,
    noauto: false,
    automount: false,
    noatime: false,
    nosuid: false,
    nodev: false,
    noexec: false,
    netdev: false,
  }

  it('a hand-written `\\040` line parses to the real path (getmntent semantics)', () => {
    const text = '//nas/My\\040Share  /mnt/My\\040Share  cifs  credentials=/etc/anas/creds/x.cred,nofail  0  0\n'
    const entry = getMount(text, '/mnt/My Share')!
    assert.equal(entry.spec, '//nas/My Share')
    assert.equal(entry.mountpoint, '/mnt/My Share')
    assert.equal(entry.options.common.nofail, true)
    // The document round-trip stays byte-identical: only the interpreted view
    // unescapes; the raw line is untouched.
    assert.equal(serializeFstabDoc(parseFstabDoc(text)), text)
  })

  it('adding an entry with a space in the mountpoint writes `\\040` and reads back the same entry', () => {
    const before = loadFixture('fstab-anas-managed')
    const entry = {
      spec: '//nas/My Share',
      mountpoint: '/mnt/My Share',
      fstype: 'cifs',
      options: { common: NOFAIL_COMMON, passthrough: '' },
      dump: 0,
      pass: 0,
    }
    const added = addMount(before, entry)
    assert.ok(added.includes('//nas/My\\040Share /mnt/My\\040Share cifs guest,nofail 0 0'), added)
    const reparsed = getMount(added, '/mnt/My Share')!
    assert.equal(reparsed.mountpoint, '/mnt/My Share')
    assert.equal(reparsed.spec, '//nas/My Share')
    // The fixture's own lines are untouched.
    for (const l of before.split('\n'))
      assert.ok(added.includes(l), `fixture line must survive: ${l}`)
  })

  it('the review\'s hostile mountpoint becomes ONE line, right field count, nofail kept', () => {
    const hostile = '/usr nfs4 rw 0 0 #' // C2: spaces + `#` shifting the fields
    const entry = {
      spec: '//10.0.0.5/public',
      mountpoint: hostile,
      fstype: 'cifs',
      options: { common: NOFAIL_COMMON, passthrough: '' },
      dump: 0,
      pass: 0,
    }
    const line = serializeMountLine(entry)
    // `guest` is the structural CIFS auth token (no creds file here).
    assert.equal(line, '//10.0.0.5/public /usr\\040nfs4\\040rw\\0400\\0400\\040# cifs guest,nofail 0 0')
    assert.ok(!line.includes('\n'), 'no forged extra line')
    assert.equal(line.split(/\s+/).length, 6, 'one six-field entry, not a shifted one')
    // Every field the hostile string wanted to forge (`nfs4`, `rw`, `0 0`)
    // is inside the escaped mountpoint, not a real column.
    assert.ok(!line.split(/\s+/).includes('nfs4'), 'fstype is cifs — the hostile tokens are escaped into the mountpoint')
    const parsed = getMount(`${line}\n`, hostile)!
    assert.equal(parsed.mountpoint, hostile)
    assert.equal(parsed.fstype, 'cifs')
    assert.equal(parsed.options.common.nofail, true) // never dropped
    // And a real re-serialize of the parsed entry reproduces the same text.
    assert.equal(serializeMountLine(parsed), line)
  })

  it('re-serializing an escaped entry round-trips the escape (parse → build → parse)', () => {
    const text = '//nas/My\\040Share /mnt/My\\040Share cifs nofail 0 0\n'
    const first = getMount(text, '/mnt/My Share')!
    const again = getMount(`${serializeMountLine(first)}\n`, '/mnt/My Share')!
    assert.equal(again.spec, '//nas/My Share')
    assert.equal(again.mountpoint, '/mnt/My Share')
    assert.deepEqual(again.options, first.options)
  })

  it('the disable path works on the UNESCAPED value and never rewrites the escape', () => {
    const text = '//nas/My\\040Share /mnt/My\\040Share cifs guest,nofail 0 0\n'
    const disabled = disableMount(text, '/mnt/My Share')
    assert.ok(disabled.includes('guest,nofail,noauto,x-anas.disabled'), disabled)
    assert.ok(disabled.includes('\\040'), 'the escaped fields survive the surgical disable')
    // The disabled line still parses as one escaped entry → unescaped identity.
    const parsed = getMount(disabled, '/mnt/My Share')!
    assert.equal(parsed.mountpoint, '/mnt/My Share')
    assert.equal(parsed.disabled, true)
    // A surgical addMountOption targets it by the UNESCAPED mountpoint and
    // leaves the disable tokens + the escape spellings intact.
    const once = addMountOption(disabled, '/mnt/My Share', 'x-anas-note=keep')
    assert.ok(once.includes('x-anas-note=keep'))
    assert.ok(once.includes('\\040'), 'the escaped field must not be re-escaped')
    assert.ok(!once.includes('My\\040Share /mnt/My Share'), 'no partial unescape')
    // Enabling removes exactly what disable added, keeping escaped fields + the note.
    const enabled = enableMount(once, '/mnt/My Share')!
    assert.ok(!enabled.includes('x-anas.disabled'), enabled)
    assert.ok(enabled.includes('x-anas-note=keep') && enabled.includes('\\040'), enabled)
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
    const entry = { spec: 'UUID=xyz', mountpoint: '/mnt/new', fstype: 'ext4', options: { common: { readOnly: false, nofail: true, noauto: false, automount: false, noatime: false, nosuid: false, nodev: false, noexec: false, netdev: false }, passthrough: '' }, dump: 0, pass: 2 }
    const added = addMount(before, entry)
    assert.ok(hasMount(added, '/mnt/new'))
    assert.equal(serializeMountLine(entry), 'UUID=xyz /mnt/new ext4 nofail 0 2')
    const removed = removeMount(added, '/mnt/new')
    assert.equal(removed, before) // adding then removing is a no-op on the bytes
  })
})

describe('addMountOption — one option, in place, byte-surgically (story iscsi.8)', () => {
  const OPT = 'x-systemd.before=rtslib-fb-targetctl.service'

  it('adds the token to the options column and touches NOTHING else', () => {
    const before = loadFixture('fstab-handedited-sample')
    const after = addMountOption(before, '/mnt/spare', OPT)

    const beforeLines = before.split('\n')
    const afterLines = after.split('\n')
    assert.equal(afterLines.length, beforeLines.length)
    for (let i = 0; i < beforeLines.length; i++) {
      if (beforeLines[i].includes('/mnt/spare')) {
        // The tab-separated hand alignment survives verbatim; only the fourth
        // column grew. A `replaceMount` here would have reflowed the whole line.
        assert.equal(afterLines[i], `UUID=1b3e6c9a-2f44-4d8e-91aa-77c0de3f1a2b\t/mnt/spare\txfs\tdefaults,nofail,noatime,${OPT}\t0\t2`)
      }
      else {
        assert.equal(afterLines[i], beforeLines[i], `line ${i} must be untouched`)
      }
    }
  })

  it('is a byte-identical no-op the second time — safe on every LUN placement', () => {
    const before = loadFixture('fstab-handedited-sample')
    const once = addMountOption(before, '/mnt/spare', OPT)
    assert.notEqual(once, before)
    assert.equal(addMountOption(once, '/mnt/spare', OPT), once)
  })

  it('keeps an inline trailing comment where it was', () => {
    const before = loadFixture('fstab-handedited-sample')
    const after = addMountOption(before, '/mnt/media', OPT)
    const line = after.split('\n').find(l => l.includes('/mnt/media'))!
    assert.ok(line.includes(`retrans=3,_netdev,${OPT}`), line)
    assert.ok(line.endsWith('# media library, read-mostly'), line)
  })

  it('does not disturb an unknown option a human put there', () => {
    const before = loadFixture('fstab-handedited-sample')
    const after = addMountOption(before, '/mnt/weird', OPT)
    const line = after.split('\n').find(l => l.includes('/mnt/weird'))!
    assert.ok(line.includes('x-anas-note=keep-this-unknown-option'), line)
    assert.ok(line.includes('comment=cloudconfig'), line)
    assert.ok(line.endsWith(`comment=cloudconfig,${OPT}   0 0`), line)
  })

  it('a mountpoint with no line is left alone, byte for byte', () => {
    const before = loadFixture('fstab-handedited-sample')
    assert.equal(addMountOption(before, '/mnt/nothing-here', OPT), before)
  })

  it('a DISABLED entry (option form) still gains the option and stays disabled', () => {
    const before = loadFixture('fstab-anas-managed')
    const disabled = disableMount(before, '/mnt/anas-nfs')
    const after = addMountOption(disabled, '/mnt/anas-nfs', OPT)
    const line = after.split('\n').find(l => l.includes('/mnt/anas-nfs'))!
    // The disable tokens survive the surgical add; the line is still disabled.
    assert.ok(line.includes(`noauto,${X_ANAS_DISABLED_TOKEN}`), line)
    assert.ok(line.includes(OPT), line)
    assert.equal(getMount(after, '/mnt/anas-nfs')!.disabled, true)
    // …and enabling it afterwards still yields a parseable, option-carrying line.
    const enabled = enableMount(after, '/mnt/anas-nfs')
    const entry = getMount(enabled, '/mnt/anas-nfs')!
    assert.equal(entry.options.passthrough.includes(OPT), true)
    assert.notEqual(entry.disabled, true)
  })
})

describe('cr.6 — disable/enable via `noauto` + `x-anas.disabled` (option form)', () => {
  const NFS = '127.0.0.1:/srv/nfs/export1  /mnt/anas-nfs  nfs4  defaults,nofail  0  0\n'

  it('disable appends noauto,x-anas.disabled and enable restores the EXACT bytes', () => {
    const disabled = disableMount(NFS, '/mnt/anas-nfs')
    assert.equal(disabled.trimEnd(), '127.0.0.1:/srv/nfs/export1  /mnt/anas-nfs  nfs4  defaults,nofail,noauto,x-anas.disabled  0  0')
    assert.equal(disabled, `127.0.0.1:/srv/nfs/export1  /mnt/anas-nfs  nfs4  defaults,nofail,noauto,x-anas.disabled  0  0\n`)
    assert.equal(enableMount(disabled, '/mnt/anas-nfs'), NFS)
  })

  it('a disabled line reads disabled, the operator\'s noauto is FALSE (ANAS forced it), token never in passthrough', () => {
    const disabled = disableMount(NFS, '/mnt/anas-nfs')
    const entry = getMount(disabled, '/mnt/anas-nfs')!
    assert.equal(entry.disabled, true)
    // The `noauto` on the line is DISABLE bookkeeping — the operator's own value
    // is false, so the boot-warning and source-guard derivations treat it as a
    // boot mount that is switched off, exactly like a legacy `#ANAS ` entry.
    assert.equal(entry.options.common.noauto, false)
    // …and the disable token is consumed, never passthrough.
    assert.equal(entry.options.passthrough, 'defaults')
    assert.ok(!entry.options.passthrough.includes('anas.disabled'))
  })

  it('pre-existing operator noauto → only x-anas.disabled=kept-noauto; enable keeps the noauto, byte-identical', () => {
    const before = '127.0.0.1:/srv/nfs/export1  /mnt/anas-nfs  nfs4  defaults,noauto,nofail  0  0\n'
    const disabled = disableMount(before, '/mnt/anas-nfs')
    assert.equal(disabled, '127.0.0.1:/srv/nfs/export1  /mnt/anas-nfs  nfs4  defaults,noauto,nofail,x-anas.disabled=kept-noauto  0  0\n')
    const entry = getMount(disabled, '/mnt/anas-nfs')!
    assert.equal(entry.disabled, true)
    assert.equal(entry.options.common.noauto, true) // the operator's OWN noauto survives
    const enabled = enableMount(disabled, '/mnt/anas-nfs')
    assert.equal(enabled, before) // byte-identical
    assert.equal(getMount(enabled, '/mnt/anas-nfs')!.options.common.noauto, true)
  })

  it('an inline comment stays after the options through disable→enable (byte-identical)', () => {
    const before = '192.168.1.50:/volume1/media     /mnt/media   nfs4   rw,nofail,_netdev   0 0   # media library, read-mostly\n'
    const disabled = disableMount(before, '/mnt/media')
    assert.ok(disabled.includes('_netdev,noauto,x-anas.disabled   0 0   # media library, read-mostly'))
    assert.equal(enableMount(disabled, '/mnt/media'), before)
  })

  it('an automount line parks its token for the disable and re-appears byte-identical on enable (cr.19)', () => {
    const before = '127.0.0.1:/srv/nfs/export1  /mnt/anas-auto  nfs4  defaults,nofail,x-systemd.automount,x-systemd.idle-timeout=60  0  0\n'
    const disabled = disableMount(before, '/mnt/anas-auto')
    // cr.19 (§2 Mounts automount ruling): the automount token is SWAPPED IN
    // PLACE for `x-anas.disabled-automount` — same position, and NO live token
    // left for the fstab-generator to arm behind the disable (node defect
    // R1-D1: `noauto` reaches only the `.mount` unit).
    assert.ok(disabled.includes('defaults,nofail,x-anas.disabled-automount,x-systemd.idle-timeout=60,noauto,x-anas.disabled'), disabled)
    assert.ok(!disabled.includes('x-systemd.automount'), disabled)
    assert.equal(getMount(disabled, '/mnt/anas-auto')!.options.common.automount, true)
    assert.equal(enableMount(disabled, '/mnt/anas-auto'), before)
  })

  it('a CIFS line keeps its credentials token and round-trips byte-identical', () => {
    const before = '//10.0.0.114/anastest  /mnt/anas-cifs  cifs  credentials=/etc/anas/creds/anastest.cred,vers=3.1.1,uid=1002,gid=1002,nofail  0  0\n'
    const disabled = disableMount(before, '/mnt/anas-cifs')
    assert.ok(disabled.includes('credentials=/etc/anas/creds/anastest.cred,vers=3.1.1,uid=1002,gid=1002,nofail,noauto,x-anas.disabled'))
    assert.equal(enableMount(disabled, '/mnt/anas-cifs'), before)
  })

  it('the managed fixture: disable→enable is byte-identical and only the one line changes', () => {
    const before = loadFixture('fstab-anas-managed')
    const disabled = disableMount(before, '/mnt/anas-nfs')
    assert.notEqual(disabled, before)
    const beforeLines = before.split('\n')
    for (const [i, l] of disabled.split('\n').entries()) {
      if (l.includes('/mnt/anas-nfs'))
        assert.ok(l.includes('noauto,x-anas.disabled'), l)
      else
        assert.equal(l, beforeLines[i], `line ${i} must be untouched`)
    }
    assert.equal(enableMount(disabled, '/mnt/anas-nfs'), before)
  })

  it('duplicate disable is a no-op; enable of an active line is a no-op', () => {
    const once = disableMount(NFS, '/mnt/anas-nfs')
    assert.equal(disableMount(once, '/mnt/anas-nfs'), once)
    assert.equal(enableMount(NFS, '/mnt/anas-nfs'), NFS)
  })
})

describe('cr.19 — disable/enable parks the automount token (§2 Mounts automount ruling)', () => {
  const AUTO = '127.0.0.1:/srv/nfs/export1  /mnt/anas-auto  nfs4  defaults,nofail,x-systemd.automount,x-systemd.idle-timeout=60  0  0\n'

  it('the managed fixture: disable swaps the token in place, enable restores the exact bytes, only the one line changes', () => {
    const before = loadFixture('fstab-anas-managed')
    const disabled = disableMount(before, '/mnt/anas-auto')
    const beforeLines = before.split('\n')
    for (const [i, l] of disabled.split('\n').entries()) {
      if (l.includes('/mnt/anas-auto')) {
        // same POSITION in the list (cr.6 rewrites the field surgically, so the
        // surrounding tokens, column alignment and dump/pass all survive)
        assert.ok(l.includes('defaults,nofail,x-anas.disabled-automount,x-systemd.idle-timeout=60,noauto,x-anas.disabled  0  0'), l)
        assert.ok(!l.includes('x-systemd.automount'), `no live automount may survive a disable: ${l}`)
      }
      else {
        assert.equal(l, beforeLines[i], `line ${i} must be untouched`)
      }
    }
    assert.equal(enableMount(disabled, '/mnt/anas-auto'), before)
  })

  it('the parked token reads automount=true, is consumed, never shown as passthrough, while disabled', () => {
    const entry = getMount(disableMount(AUTO, '/mnt/anas-auto'), '/mnt/anas-auto')!
    assert.equal(entry.disabled, true)
    assert.equal(entry.options.common.automount, true) // the operator's choice survives the disable
    assert.equal(entry.options.passthrough, 'defaults')
  })

  it('enable of a hand-written parked line returns the live-token line', () => {
    const parked = 'srv:/a  /mnt/anas-auto  nfs4  defaults,nofail,x-anas.disabled-automount,x-systemd.idle-timeout=60,noauto,x-anas.disabled  0  0\n'
    assert.equal(
      enableMount(parked, '/mnt/anas-auto'),
      'srv:/a  /mnt/anas-auto  nfs4  defaults,nofail,x-systemd.automount,x-systemd.idle-timeout=60  0  0\n',
    )
  })

  it('an already-disabled cr.6-era line is REPAIRED by re-disable; enable then returns those bytes', () => {
    // the exact shape node defect R1-D1 left behind: disabled per cr.6, still
    // armed at every boot by the live automount token.
    const legacyDisabled = 'srv:/a  /mnt/anas-auto  nfs4  defaults,nofail,x-systemd.automount,x-systemd.idle-timeout=60,noauto,x-anas.disabled  0  0\n'
    const repaired = disableMount(legacyDisabled, '/mnt/anas-auto')
    assert.equal(
      repaired,
      'srv:/a  /mnt/anas-auto  nfs4  defaults,nofail,x-anas.disabled-automount,x-systemd.idle-timeout=60,noauto,x-anas.disabled  0  0\n',
    )
    assert.equal(getMount(repaired, '/mnt/anas-auto')!.options.common.automount, true)
    assert.equal(disableMount(repaired, '/mnt/anas-auto'), repaired) // now the idempotent no-op
    // The `noauto` in the legacy line is ANAS's OWN bare-form noauto, so enable
    // correctly removes it — the line returns to its pre-disable active shape.
    assert.equal(enableMount(repaired, '/mnt/anas-auto'), 'srv:/a  /mnt/anas-auto  nfs4  defaults,nofail,x-systemd.automount,x-systemd.idle-timeout=60  0  0\n')
  })

  it('a live token hand-added while disabled: enable drops the marker, returns ONE automount option', () => {
    const both = 'srv:/a  /mnt/m  nfs4  x-anas.disabled-automount,x-systemd.automount,noauto,x-anas.disabled 0  0\n'
    assert.equal(enableMount(both, '/mnt/m'), 'srv:/a  /mnt/m  nfs4  x-systemd.automount 0  0\n')
  })

  it('case-shifted automount exotica is NOT swapped — unrecognized, verbatim round trip (parser AND generator ignore it)', () => {
    const upper = 'srv:/a  /mnt/m  nfs4  defaults,X-SYSTEMD.AUTOMOUNT 0  0\n'
    const disabled = disableMount(upper, '/mnt/m')
    assert.ok(disabled.includes('defaults,X-SYSTEMD.AUTOMOUNT,noauto,x-anas.disabled'), disabled)
    const entry = getMount(disabled, '/mnt/m')!
    assert.equal(entry.options.common.automount, false)
    assert.equal(entry.options.passthrough, 'defaults,X-SYSTEMD.AUTOMOUNT')
    assert.equal(enableMount(disabled, '/mnt/m'), upper)
  })

  it('the legacy `#ANAS ` → option-form conversion parks the automount too', () => {
    const marked = `${ANAS_MARKER}srv:/a  /mnt/m  nfs4  defaults,nofail,x-systemd.automount,x-systemd.idle-timeout=60  0  0\n`
    const after = disableMount(marked, '/mnt/m')
    const line = after.trimEnd()
    assert.ok(!line.startsWith('#'), line)
    assert.ok(line.includes('x-anas.disabled-automount,x-systemd.idle-timeout=60'), line)
    assert.ok(!line.includes('x-systemd.automount'), line)
    assert.equal(getMount(after, '/mnt/m')!.options.common.automount, true)
    assert.equal(getMount(after, '/mnt/m')!.disabled, true)
  })

  it('replaceMount of a disabled automount entry stays parked (the update path never re-arms)', () => {
    const before = loadFixture('fstab-anas-managed')
    const disabled = disableMount(before, '/mnt/anas-auto')
    const entry = getMount(disabled, '/mnt/anas-auto')!
    entry.options.common.noatime = true
    const after = replaceMount(disabled, '/mnt/anas-auto', entry)
    const line = after.split('\n').find(l => l.includes('/mnt/anas-auto'))!
    assert.ok(line.includes('x-anas.disabled-automount'), line)
    assert.ok(!line.includes('x-systemd.automount'), line)
    const reparsed = getMount(after, '/mnt/anas-auto')!
    assert.equal(reparsed.disabled, true)
    assert.equal(reparsed.options.common.automount, true)
  })

  it('classifyOptions consumes the parked token by key, case-insensitively, any value', () => {
    for (const tok of ['x-anas.disabled-automount', 'X-ANAS.DISABLED-AUTOMOUNT', 'x-anas.disabled-automount=whatever']) {
      const { options, disable } = classifyOptions('nfs4', `defaults,nofail,noauto,${tok},x-anas.disabled`.split(','))
      assert.equal(options.common.automount, true, tok)
      assert.equal(disable, 'bare', tok)
      assert.equal(options.passthrough, 'defaults', tok)
    }
  })
})

describe('cr.6 — classifyOptions consumes the disable token (operator noauto per form)', () => {
  it('bare form → operator noauto FALSE, token consumed, never passthrough', () => {
    const { options, disable } = classifyOptions('nfs4', 'defaults,nofail,noauto,x-anas.disabled'.split(','))
    assert.equal(disable, 'bare')
    assert.equal(options.common.noauto, false)
    assert.equal(options.common.nofail, true)
    assert.equal(options.passthrough, 'defaults')
  })

  it('kept-noauto form → operator noauto TRUE', () => {
    const { options, disable } = classifyOptions('nfs4', `defaults,noauto,nofail,${X_ANAS_DISABLED_KEPT_TOKEN}`.split(','))
    assert.equal(disable, 'kept-noauto')
    assert.equal(options.common.noauto, true)
    assert.equal(options.passthrough, 'defaults')
  })

  it('a reordered bare form cannot resurrect the ANAS-forced noauto (decided after the full list)', () => {
    const { options } = classifyOptions('nfs4', `x-anas.disabled,nofail,noauto,defaults`.split(','))
    assert.equal(options.common.noauto, false)
  })

  it('enable clears a hand-typed case-shifted or odd-valued token the reader honours (cr.6 review)', () => {
    for (const tok of ['X-ANAS.DISABLED', 'x-anas.disabled=whatever']) {
      const text = `srv:/a /mnt/a nfs4 nofail,noauto,${tok} 0 0\n`
      assert.equal(parseFstabDoc(text).some(l => l.kind === 'entry' && l.disabled), true, tok)
      assert.equal(enableMount(text, '/mnt/a'), 'srv:/a /mnt/a nfs4 nofail 0 0\n', tok)
    }
    const kept = 'srv:/a /mnt/a nfs4 noauto,nofail,X-ANAS.DISABLED=KEPT-NOAUTO 0 0\n'
    assert.equal(enableMount(kept, '/mnt/a'), 'srv:/a /mnt/a nfs4 noauto,nofail 0 0\n')
  })

  it('a hand-typed case-shifted token still reads disabled (fail-safe on the read side)', () => {
    const { options, disable } = classifyOptions('nfs4', 'defaults,noauto,X-ANAS.DISABLED'.split(','))
    assert.equal(disable, 'bare')
    assert.equal(options.common.noauto, false)
    assert.ok(!options.passthrough.includes('anas.disabled'))
  })
})

describe('cr.6 — legacy `#ANAS ` lines: read disabled, convert only when ANAS writes that line', () => {
  const MARKED = `${ANAS_MARKER}127.0.0.1:/srv/nfs/export1  /mnt/anas-nfs  nfs4  defaults,nofail  0  0\n`

  it('an #ANAS line still parses as a disabled entry (round-trips byte-identical)', () => {
    const doc = parseFstabDoc(MARKED)
    assert.equal(serializeFstabDoc(doc), MARKED)
    assert.equal(doc[0].kind, 'entry')
    assert.equal(getMount(MARKED, '/mnt/anas-nfs')!.disabled, true)
  })

  it('enable of an #ANAS line un-marks it: the original ACTIVE line returns', () => {
    assert.equal(enableMount(MARKED, '/mnt/anas-nfs'), '127.0.0.1:/srv/nfs/export1  /mnt/anas-nfs  nfs4  defaults,nofail  0  0\n')
  })

  it('an unrelated edit of ANOTHER line leaves the #ANAS line byte-identical', () => {
    const two = `${MARKED}//127.0.0.1/anastest  /mnt/anas-cifs  cifs  credentials=/etc/anas/creds/x.cred,nofail  0  0\n`
    const after = addMountOption(two, '/mnt/anas-cifs', 'x-systemd.before=x.service')
    const markedLine = after.split('\n').find(l => l.includes('/mnt/anas-nfs'))!
    assert.equal(markedLine, `${ANAS_MARKER}127.0.0.1:/srv/nfs/export1  /mnt/anas-nfs  nfs4  defaults,nofail  0  0`)
  })

  it('an edit of the #ANAS line itself converts it to the option form and still reads disabled', () => {
    const entry = getMount(MARKED, '/mnt/anas-nfs')!
    entry.options.common.readOnly = true
    const after = replaceMount(MARKED, '/mnt/anas-nfs', entry)
    const line = after.trimEnd()
    assert.ok(line.includes('ro,nofail,defaults,noauto,x-anas.disabled'), line)
    const reparsed = getMount(after, '/mnt/anas-nfs')!
    assert.equal(reparsed.disabled, true)
    assert.equal(reparsed.options.common.noauto, false)
    assert.equal(reparsed.options.common.readOnly, true)
  })

  it('disable-again of an #ANAS line converts it to the option form (still disabled)', () => {
    const after = disableMount(MARKED, '/mnt/anas-nfs')
    const line = after.trimEnd()
    assert.ok(!line.startsWith('#'), line)
    assert.ok(line.includes('nofail,defaults,noauto,x-anas.disabled'), line)
    assert.equal(getMount(after, '/mnt/anas-nfs')!.disabled, true)
    // Enabling the converted line returns its ACTIVE serialization.
    const active = getMount(enableMount(after, '/mnt/anas-nfs'), '/mnt/anas-nfs')!
    assert.equal(active.mountpoint, '/mnt/anas-nfs')
    assert.notEqual(active.disabled, true)
    assert.equal(active.options.common.noauto, false)
  })

  it('fail-open: a prose comment starting with #ANAS is an ordinary comment', () => {
    const text = '#ANAS this is just a human note, not an entry\n'
    const doc = parseFstabDoc(text)
    assert.equal(doc[0].kind, 'other')
    assert.equal(parseFstab(text).length, 0)
    assert.equal(serializeFstabDoc(doc), text) // still byte-identical
  })
})
