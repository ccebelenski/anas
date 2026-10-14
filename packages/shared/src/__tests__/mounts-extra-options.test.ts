import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CreateMountRequest, MountExtraOptions, UpdateMountRequest } from '../schemas/mounts.js'

/**
 * cr.2 (review C2): the mounts `extraOptions` field is a strict comma-separated
 * option TOKEN list, validated at the request boundary, and credential-carrying
 * token keys are refused — secrets live in the write-only Credentials fields,
 * never on an fstab line (ruling (i), §2 Secrets).
 */

const VALID_BASE = {
  type: 'nfs',
  server: 'nas.example.com',
  remotePath: '/export',
  mountpoint: '/mnt/x',
  persistent: false,
}

describe('MountExtraOptions — token list + credential refusal', () => {
  it('accepts the empty list and well-formed option tokens', () => {
    for (const s of ['', 'nofail', 'vers=4.2,x-systemd.requires=/opt', 'x-systemd.idle-timeout=60'])
      assert.equal(MountExtraOptions.safeParse(s).success, true, JSON.stringify(s))
  })

  it('refuses a newline, whitespace, commas-in-tokens and the escape-requiring set', () => {
    for (const s of ['nofail\nnofail', 'nofail nofail', 'a, b', 'a,,b', 'a#b', 'a"b', 'a\\b'])
      assert.equal(MountExtraOptions.safeParse(s).success, false, JSON.stringify(s))
  })

  it('refuses every credential-carrying key, case-insensitively, with a message naming it', () => {
    for (const s of ['credentials=/etc/foo', 'password=sekrit', 'PASSWORD=sekrit', 'pass=sekrit', 'username=alice', 'User=alice', 'user=alice', 'domain=WORKGROUP'])
      assert.equal(MountExtraOptions.safeParse(s).success, false, JSON.stringify(s))
    const bad = MountExtraOptions.safeParse('credentials=/etc/foo')
    assert.ok(!bad.success)
    assert.match(bad.error.issues[0].message, /Credentials fields/)
  })

  it('allows the safe near-misses: `users`, `nouser`, `noexec` stay valid', () => {
    for (const s of ['users', 'nouser', 'noexec,x-systemd.automount'])
      assert.equal(MountExtraOptions.safeParse(s).success, true, JSON.stringify(s))
  })
})

describe('the request schemas gate extraOptions at the boundary', () => {
  it('CreateMountRequest: a newline is refused, the story\'s accepted list passes', () => {
    const bad = CreateMountRequest.safeParse({ ...VALID_BASE, extraOptions: 'nofail\nnofail' })
    assert.equal(bad.success, false)
    const good = CreateMountRequest.safeParse({ ...VALID_BASE, extraOptions: 'vers=4.2,x-systemd.requires=/opt' })
    assert.equal(good.success, true)
  })

  it('UpdateMountRequest: `credentials=/x` is refused with the field named', () => {
    const parsed = UpdateMountRequest.safeParse({ extraOptions: 'credentials=/x' })
    assert.equal(parsed.success, false)
    assert.match((parsed as { error: { issues: Array<{ path: unknown[] }> } }).error.issues[0].path.join('.'), /extraOptions/)
  })

  // cr.2 audit (ruling (i)): `options.domain` is written VERBATIM as one fstab
  // option token, so the REQUEST value is the token shape too — a space or `#`
  // inside it would split the OPTIONS column exactly like the extraOptions
  // injection. The persistence schema stays lenient; only this write door gates.
  it('CreateMountRequest: `options.domain` is a token — spacing refused, plain names accepted', () => {
    const bad = CreateMountRequest.safeParse({ ...VALID_BASE, type: 'cifs', server: 'nas', remotePath: 'share', options: { domain: 'My Corp' } })
    assert.equal(bad.success, false)
    const ok = CreateMountRequest.safeParse({ ...VALID_BASE, type: 'cifs', server: 'nas', remotePath: 'share', options: { domain: 'WORKGROUP' } })
    assert.equal(ok.success, true)
  })
})
