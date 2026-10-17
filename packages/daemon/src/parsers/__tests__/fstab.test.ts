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
  carriesAutomount,
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

  it('cr.60 (M7): every spelling of the shared list lifts the same way — `user=`/`pass=`, any case, `dom=`/`workgroup=`', () => {
    for (const [u, p, d] of [['user', 'pass', 'dom'], ['USERNAME', 'PASSWORD', 'WORKGROUP'], ['User', 'Pass', 'workgroup']]) {
      const spelled = tokens.map(t => t.replace(/^username=/, `${u}=`).replace(/^password=/, `${p}=`).replace(/^domain=/, `${d}=`))
      const { options, inlineCredentials, secretOptions } = classifyOptions('cifs', spelled)
      assert.deepEqual(inlineCredentials, { username: 'ccebelenski', usernameKey: u, password: 'Xy#zzy!$', domain: 'CORP' }, spelled.join(','))
      assert.equal(options.cifs?.domain, 'CORP')
      assert.equal(options.passthrough, '')
      assert.equal(secretOptions, undefined)
    }
  })

  it('cr.60 (M7): `password2=` is hidden from the passthrough and kept verbatim; a line of another fstype hides its secret too', () => {
    const withTwo = classifyOptions('cifs', [...tokens, 'password2=R0tate#2'])
    assert.deepEqual(withTwo.secretOptions, ['password2=R0tate#2'])
    assert.equal(withTwo.options.passthrough, '')
    const smb3 = classifyOptions('smb3', tokens)
    assert.deepEqual(smb3.secretOptions, ['password=Xy#zzy!$'])
    assert.ok(!smb3.options.passthrough.includes('Xy#zzy'), smb3.options.passthrough)
    // A bare `user` is mount(8)'s "users may mount" flag — never a username.
    assert.equal(classifyOptions('cifs', ['user', 'vers=3.0']).options.passthrough, 'user')
  })

  it('cr.60 (M7): a rewritten line writes `password2=` back unchanged', () => {
    const entry = parseFstab(`//10.0.0.114/chiap2 /m cifs ${[...tokens, 'password2=R0tate#2'].join(',')} 0 0\n`)[0]
    assert.ok(serializeMountLine(entry).includes('password2=R0tate#2'), serializeMountLine(entry))
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

  it('x-systemd.automount is parked in place by disable and re-appears byte-identical on enable (cr.19)', () => {
    const before = '127.0.0.1:/srv/nfs/export1  /mnt/anas-auto  nfs4  defaults,nofail,x-systemd.automount,x-systemd.idle-timeout=60  0  0\n'
    const disabled = disableMount(before, '/mnt/anas-auto')
    assert.ok(disabled.includes('defaults,nofail,x-anas.disabled-automount,x-systemd.idle-timeout=60,noauto,x-anas.disabled  0  0'), disabled)
    assert.ok(!disabled.includes('x-systemd.automount'), 'a disabled line must not carry a live automount (R1-D1)')
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

// cr.19 (§2 Mounts automount ruling; node pass R1-D1): `noauto` does not stop
// systemd-fstab-generator wiring an `x-systemd.automount` line's `.automount`
// into remote-fs.target.wants, so a disabled automount line must not carry the
// live token. Disable parks it IN PLACE as `x-anas.disabled-automount`; Enable
// swaps it back, byte-identically.
describe('cr.19 — disable parks x-systemd.automount in place; enable restores it', () => {
  const AUTO = '/mnt/anas-auto'
  const autoLine = (text: string): string => text.split('\n').find(l => l.includes(AUTO))!

  it('the managed fixture: the automount line parks in place, only that line changes, enable is byte-identical', () => {
    const before = loadFixture('fstab-anas-managed')
    const disabled = disableMount(before, AUTO)
    assert.equal(autoLine(disabled), '127.0.0.1:/srv/nfs/export1  /mnt/anas-auto  nfs4  defaults,nofail,x-anas.disabled-automount,x-systemd.idle-timeout=60,noauto,x-anas.disabled  0  0')
    const beforeLines = before.split('\n')
    for (const [i, l] of disabled.split('\n').entries()) {
      if (!l.includes(AUTO))
        assert.equal(l, beforeLines[i], `line ${i} must be untouched`)
    }
    const entry = getMount(disabled, AUTO)!
    assert.equal(entry.disabled, true)
    assert.equal(entry.options.common.automount, true) // the operator's automount, parked
    assert.equal(entry.options.common.noauto, false) // bare form: ANAS forced the noauto
    assert.equal(entry.options.common.automountIdleTimeout, 60)
    assert.equal(enableMount(disabled, AUTO), before) // byte-identical
  })

  it('kept-noauto: the operator\'s noauto + automount line parks, keeps its noauto, and round-trips byte-identical', () => {
    const before = '10.0.0.9:/export  /mnt/lazy\tnfs4  defaults,noauto,nofail,x-systemd.automount  0  0   # lazy mount\n'
    const disabled = disableMount(before, '/mnt/lazy')
    assert.equal(disabled, `10.0.0.9:/export  /mnt/lazy\tnfs4  defaults,noauto,nofail,x-anas.disabled-automount,${X_ANAS_DISABLED_KEPT_TOKEN}  0  0   # lazy mount\n`)
    const entry = getMount(disabled, '/mnt/lazy')!
    assert.equal(entry.disabled, true)
    assert.equal(entry.options.common.noauto, true)
    assert.equal(entry.options.common.automount, true)
    assert.equal(enableMount(disabled, '/mnt/lazy'), before)
  })

  it('a token order where the automount is first keeps its position through the round trip', () => {
    const before = 'h:/e /mnt/first nfs4 x-systemd.automount,nofail,_netdev 0 0\n'
    const disabled = disableMount(before, '/mnt/first')
    assert.equal(disabled, 'h:/e /mnt/first nfs4 x-anas.disabled-automount,nofail,_netdev,noauto,x-anas.disabled 0 0\n')
    assert.equal(enableMount(disabled, '/mnt/first'), before)
  })

  it('the parked token is never passthrough (read, or as an orphan on an enabled line)', () => {
    const { options, disable, parkedAutomount } = classifyOptions('nfs4', 'defaults,nofail,x-anas.disabled-automount,noauto,x-anas.disabled'.split(','))
    assert.equal(disable, 'bare')
    assert.equal(parkedAutomount, true)
    assert.equal(options.common.automount, true)
    assert.equal(options.passthrough, 'defaults')
    // An orphan (a hand edit took the disable token off): inert to systemd, so
    // NOT an automount — and still consumed, never surfaced as an extra option.
    const orphan = classifyOptions('nfs4', 'defaults,nofail,x-anas.disabled-automount,noauto'.split(','))
    assert.equal(orphan.disable, undefined)
    assert.equal(orphan.options.common.automount, false)
    assert.equal(orphan.options.passthrough, 'defaults')
  })

  it('the parked token is matched like the disable token (by key, any case): read as automount, un-parked by enable', () => {
    const text = 'h:/e /mnt/odd nfs4 nofail,X-ANAS.DISABLED-AUTOMOUNT,noauto,x-anas.disabled 0 0\n'
    const entry = getMount(text, '/mnt/odd')!
    assert.equal(entry.options.common.automount, true)
    assert.equal(entry.options.passthrough, '')
    assert.equal(enableMount(text, '/mnt/odd'), 'h:/e /mnt/odd nfs4 nofail,x-systemd.automount 0 0\n')
  })

  it('a differently-cased X-SYSTEMD.AUTOMOUNT is not the generator\'s option: left alone as passthrough', () => {
    const before = 'h:/e /mnt/case nfs4 nofail,X-SYSTEMD.AUTOMOUNT 0 0\n'
    const disabled = disableMount(before, '/mnt/case')
    assert.equal(disabled, 'h:/e /mnt/case nfs4 nofail,X-SYSTEMD.AUTOMOUNT,noauto,x-anas.disabled 0 0\n')
    assert.equal(enableMount(disabled, '/mnt/case'), before)
  })

  it('a legacy #ANAS automount line is converted on disable with the automount parked; enable brings it back live', () => {
    const marked = `${ANAS_MARKER}127.0.0.1:/srv/nfs/export1  /mnt/anas-auto  nfs4  defaults,nofail,x-systemd.automount  0  0\n`
    assert.equal(getMount(marked, AUTO)!.options.common.automount, true)
    const converted = disableMount(marked, AUTO)
    const line = converted.trimEnd()
    assert.ok(!line.startsWith('#'), line)
    assert.ok(!line.includes('x-systemd.automount'), line)
    assert.ok(line.includes('nofail,x-anas.disabled-automount,defaults,noauto,x-anas.disabled'), line)
    const reparsed = getMount(converted, AUTO)!
    assert.equal(reparsed.disabled, true)
    assert.equal(reparsed.options.common.automount, true)
    const enabledText = enableMount(converted, AUTO)
    const enabled = getMount(enabledText, AUTO)!
    assert.notEqual(enabled.disabled, true)
    assert.equal(enabled.options.common.automount, true)
    assert.ok(enabledText.includes('x-systemd.automount'), enabledText)
  })

  it('an edit of a legacy #ANAS automount line converts it with the automount parked', () => {
    const marked = `${ANAS_MARKER}127.0.0.1:/srv/nfs/export1  /mnt/anas-auto  nfs4  defaults,nofail,x-systemd.automount  0  0\n`
    const entry = getMount(marked, AUTO)!
    entry.options.common.readOnly = true
    const after = replaceMount(marked, AUTO, entry)
    assert.ok(!after.includes('x-systemd.automount'), after)
    assert.ok(after.includes('x-anas.disabled-automount'), after)
    assert.equal(getMount(after, AUTO)!.options.common.automount, true)
  })

  it('an edit of an option-form disabled automount line keeps it parked (never re-armed by an edit)', () => {
    const disabled = disableMount(loadFixture('fstab-anas-managed'), AUTO)
    const entry = getMount(disabled, AUTO)!
    entry.options.common.noatime = true
    const after = replaceMount(disabled, AUTO, entry)
    const line = autoLine(after)
    assert.ok(!line.includes('x-systemd.automount'), line)
    assert.ok(line.includes('x-anas.disabled-automount'), line)
    const reparsed = getMount(after, AUTO)!
    assert.equal(reparsed.disabled, true)
    assert.equal(reparsed.options.common.automount, true)
    assert.equal(reparsed.options.common.noatime, true)
    // And the edited line enables back to its live automount.
    assert.ok(autoLine(enableMount(after, AUTO)).includes('x-systemd.automount'))
  })

  it('repair: re-disabling a cr.6-form disabled line that still carries a live automount parks it in place', () => {
    const cr6 = '127.0.0.1:/srv/nfs/export1 /mnt/anasproof-auto nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev,x-systemd.automount,noauto,x-anas.disabled 0 0\n'
    const repaired = disableMount(cr6, '/mnt/anasproof-auto')
    assert.equal(repaired, '127.0.0.1:/srv/nfs/export1 /mnt/anasproof-auto nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev,x-anas.disabled-automount,noauto,x-anas.disabled 0 0\n')
    // ...and enable returns the node pass's original CREATE line, byte for byte.
    assert.equal(enableMount(repaired, '/mnt/anasproof-auto'), '127.0.0.1:/srv/nfs/export1 /mnt/anasproof-auto nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev,x-systemd.automount 0 0\n')
    // Disable of an already-parked line is a byte-identical no-op.
    assert.equal(disableMount(repaired, '/mnt/anasproof-auto'), repaired)
  })

  it('an orphan parked token on an ENABLED line is dropped by disable, so enable cannot arm what was inert', () => {
    const orphan = 'h:/e /mnt/orphan nfs4 nofail,x-anas.disabled-automount,noauto 0 0\n'
    assert.equal(getMount(orphan, '/mnt/orphan')!.options.common.automount, false)
    const disabled = disableMount(orphan, '/mnt/orphan')
    assert.equal(disabled, `h:/e /mnt/orphan nfs4 nofail,noauto,${X_ANAS_DISABLED_KEPT_TOKEN} 0 0\n`)
    assert.equal(enableMount(disabled, '/mnt/orphan'), 'h:/e /mnt/orphan nfs4 nofail,noauto 0 0\n')
  })

  it('a plain line is untouched by the automount handling (cr.6 round trip unchanged)', () => {
    const before = '127.0.0.1:/srv/nfs/export1  /mnt/anas-nfs  nfs4  defaults,nofail  0  0\n'
    const disabled = disableMount(before, '/mnt/anas-nfs')
    assert.equal(disabled, `127.0.0.1:/srv/nfs/export1  /mnt/anas-nfs  nfs4  defaults,nofail,noauto,${X_ANAS_DISABLED_TOKEN}  0  0\n`)
    assert.equal(getMount(disabled, '/mnt/anas-nfs')!.options.common.automount, false)
    assert.equal(enableMount(disabled, '/mnt/anas-nfs'), before)
  })

  it('carriesAutomount: a live or parked token (incl. an orphan) counts; a plain or absent line does not', () => {
    const fixture = loadFixture('fstab-anas-managed')
    assert.equal(carriesAutomount(fixture, AUTO), true)
    assert.equal(carriesAutomount(disableMount(fixture, AUTO), AUTO), true)
    assert.equal(carriesAutomount(fixture, '/mnt/anas-nfs'), false)
    assert.equal(carriesAutomount(disableMount(fixture, '/mnt/anas-nfs'), '/mnt/anas-nfs'), false)
    assert.equal(carriesAutomount(fixture, '/mnt/nowhere'), false)
    assert.equal(carriesAutomount('h:/e /mnt/orphan nfs4 nofail,x-anas.disabled-automount,noauto 0 0\n', '/mnt/orphan'), true)
    assert.equal(carriesAutomount(`${ANAS_MARKER}h:/e /mnt/old nfs4 nofail,x-systemd.automount 0 0\n`, '/mnt/old'), true)
  })
})

// ---------------------------------------------------------------------------
// cr.60r (the cr.60 review's DEFECT + possible 2): a hand-written CIFS line
// with a username and NO password keeps the username through a save — it
// never becomes a `guest` mount — and octal escapes decode into the migrated
// credential, re-encoding if a token returns to the line. Probe line `i` and
// probe line `g` from the review, constructed over the real routes.
// ---------------------------------------------------------------------------

describe('cr.60r — a username with no password is never lost and never becomes guest (DEFECT)', () => {
  const lineI = '//h/s /mnt/q1i cifs user=bob,vers=3.0 0 0'

  it('probe i parses: the username lifts into the transient channel, the line keeps its other options', () => {
    const entry = parseFstab(`${lineI}\n`)[0]
    assert.deepEqual(entry.inlineCredentials, { username: 'bob', usernameKey: 'user' })
    assert.equal(entry.options.cifs?.vers, '3.0')
    assert.equal(entry.options.passthrough, '')
    assert.equal(entry.credentialsFile, undefined)
  })

  it('probe i serializes with `user=bob` on the line and NO `guest` (the DEFECT: the save wrote `guest`)', () => {
    const entry = parseFstab(`${lineI}\n`)[0]
    // The PUT merge's shape: ro set, no credentials supplied — nothing to migrate.
    const merged = { ...entry, options: { ...entry.options, common: { ...entry.options.common, readOnly: true, nofail: true } } }
    const line = serializeMountLine(merged)
    assert.ok(line.includes('user=bob'), `the username must ride the written line: ${line}`)
    assert.ok(!line.includes('guest'), `the line must not become a guest mount: ${line}`)
    assert.ok(!line.includes('credentials='), `no creds file was written, none may be named: ${line}`)
  })

  it('item 1b: `username=bob` stays spelled `username=bob` — never normalized to `user=bob` (config files are the API)', () => {
    const entry = parseFstab('//h/s /mnt/q1i cifs username=bob,vers=3.0 0 0\n')[0]
    assert.deepEqual(entry.inlineCredentials, { username: 'bob', usernameKey: 'username' })
    const line = serializeMountLine(entry)
    assert.ok(line.includes('username=bob'), `the operator's spelling must survive: ${line}`)
    assert.ok(!line.includes('user=bob'), `must not normalize to the short alias: ${line}`)
    assert.ok(!line.includes('guest'), line)
  })

  it('item 1b: `user=bob` stays `user=bob` — the short alias is not expanded', () => {
    const entry = parseFstab('//h/s /mnt/q1i cifs user=bob,vers=3.0 0 0\n')[0]
    const line = serializeMountLine(entry)
    assert.ok(line.includes('user=bob'), line)
    assert.ok(!line.includes('username='), `must not grow the long spelling: ${line}`)
  })

  it('item 1b: mixed case is the operator\'s too — `USERNAME=bob` is re-emitted as written', () => {
    const entry = parseFstab('//h/s /mnt/q1i cifs USERNAME=bob,vers=3.0 0 0\n')[0]
    assert.deepEqual(entry.inlineCredentials, { username: 'bob', usernameKey: 'USERNAME' })
    assert.ok(serializeMountLine(entry).includes('USERNAME=bob'))
  })

  it('item 1b: a credentials FILE plus a hand-written `username=bob` keeps the file spelling AND the long username token', () => {
    const entry = parseFstab('//h/s /mnt/q1i cifs credentials=/etc/x.cred,username=bob,vers=3.0 0 0\n')[0]
    const line = serializeMountLine(entry)
    assert.ok(line.includes('credentials=/etc/x.cred'), line)
    assert.ok(line.includes('username=bob'), line)
    assert.ok(!line.includes('guest'), line)
  })

  it('an EMPTY `user=` is not a username — the line falls back to guest, as a credential-less line does', () => {
    const entry = parseFstab('//h/s /mnt/q1e cifs user=,vers=3.0 0 0\n')[0]
    assert.ok(!serializeMountLine(entry).includes('user='), serializeMountLine(entry))
    assert.ok(serializeMountLine(entry).includes('guest'))
  })

  it('a username alongside a credentials FILE survives the rewrite (both stay; the file wins the auth slot)', () => {
    const entry = parseFstab('//h/s /mnt/q1f cifs credentials=/etc/x.cred,user=bob,vers=3.0 0 0\n')[0]
    assert.equal(entry.credentialsFile, '/etc/x.cred')
    assert.deepEqual(entry.inlineCredentials, { username: 'bob', usernameKey: 'user' })
    const line = serializeMountLine(entry)
    assert.ok(line.includes('credentials=/etc/x.cred'), line)
    assert.ok(line.includes('user=bob'), line)
    assert.ok(!line.includes('guest'), line)
  })
})

describe('cr.60r — fstab octal escapes across the migration seam (possible 2)', () => {
  it('probe g: a `\\054`-escaped secret decodes on the way into the creds channel', () => {
    const { inlineCredentials } = classifyOptions('cifs', ['pass=wo\\054rds'])
    assert.equal(inlineCredentials!.password, 'wo,rds')
  })

  it('every fstab octal escape decodes in the lifted credential — `\\040` space, `\\011` tab, `\\134` backslash', () => {
    const { inlineCredentials } = classifyOptions('cifs', ['user=a\\040b\\011c\\134d', 'pass=p\\134\\040q', 'dom=D\\040X'])
    assert.equal(inlineCredentials!.username, 'a b\tc\\d')
    assert.equal(inlineCredentials!.password, 'p\\ q')
    assert.equal(inlineCredentials!.domain, 'D X')
  })

  it('an escaped username with no password round-trips the ESCAPE byte-for-byte (decode → re-encode on the way back to the line)', () => {
    const line = '//h/s /mnt/q1r cifs user=bob\\054weird,vers=3.0 0 0'
    const entry = parseFstab(`${line}\n`)[0]
    assert.equal(entry.inlineCredentials!.username, 'bob,weird') // decoded in the channel
    const written = serializeMountLine(entry)
    assert.ok(written.includes('user=bob\\054weird'), `the comma must go back escaped: ${written}`)
    assert.ok(!written.includes('user=bob,weird'), `a raw comma would split the option list: ${written}`)
  })

  it('secretOptions and passthrough tokens are NOT decoded — they stay byte-identical (they never left the line)', () => {
    const { secretOptions, options } = classifyOptions('cifs', ['password2=a\\054b', 'x-fer=q\\040r'])
    assert.deepEqual(secretOptions, ['password2=a\\054b'])
    assert.equal(options.passthrough, 'x-fer=q\\040r')
  })
})
