import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { kernelInfo, MD_MIXED_LBS_MIN_KERNEL, MD_MIXED_LBS_MIN_KERNEL_TEXT, parseKernelVersion, runningKernelRelease } from '../kernel-version.js'

/**
 * The kernel gate. ANAS checks the KERNEL, never the PVE version — PVE 9
 * shipped with 6.14.8, so a fully supported node can sit below a feature floor.
 */

describe('parseKernelVersion', () => {
  it('reads the real-world release forms', () => {
    assert.deepEqual(parseKernelVersion('6.14.8-1-pve'), { major: 6, minor: 14 })
    assert.deepEqual(parseKernelVersion('7.0.14-8-pve'), { major: 7, minor: 0 })
    assert.deepEqual(parseKernelVersion('6.19.0'), { major: 6, minor: 19 })
    assert.deepEqual(parseKernelVersion('6.8.12-4-generic'), { major: 6, minor: 8 })
    // A bare major.minor, and surrounding whitespace from a captured uname.
    assert.deepEqual(parseKernelVersion('6.19'), { major: 6, minor: 19 })
    assert.deepEqual(parseKernelVersion('  7.1.4-204.fc44.x86_64\n'), { major: 7, minor: 1 })
  })

  it('returns null rather than guessing a number', () => {
    for (const bad of ['', '   ', 'not-a-kernel', 'v6.19', '6', '6.x', 'linux'])
      assert.equal(parseKernelVersion(bad), null, `'${bad}' must not parse`)
  })

  it('parses the REAL running kernel (the parser must work on this host)', () => {
    assert.notEqual(parseKernelVersion(runningKernelRelease()), null)
  })
})

describe('kernelInfo — the md configurable-LBS floor', () => {
  it('the floor is 6.19, and its text form matches', () => {
    assert.deepEqual(MD_MIXED_LBS_MIN_KERNEL, { major: 6, minor: 19 })
    assert.equal(MD_MIXED_LBS_MIN_KERNEL_TEXT, '6.19')
  })

  it('below the floor is unsupported — including a shipping PVE 9 kernel', () => {
    // The exact kernel that made "any supported PVE qualifies" wrong.
    assert.equal(kernelInfo('6.14.8-1-pve').supportsMixedLbs, false)
    assert.equal(kernelInfo('6.18.99').supportsMixedLbs, false)
    assert.equal(kernelInfo('5.15.0-100-generic').supportsMixedLbs, false)
  })

  it('at or above the floor is supported, across a major bump', () => {
    assert.equal(kernelInfo('6.19.0').supportsMixedLbs, true)
    assert.equal(kernelInfo('6.20.1-1-pve').supportsMixedLbs, true)
    // Major comparison must win over minor: 7.0 > 6.19 despite 0 < 19.
    assert.equal(kernelInfo('7.0.14-8-pve').supportsMixedLbs, true)
    assert.equal(kernelInfo('8.1.0').supportsMixedLbs, true)
  })

  it('an unparseable release is NOT supported — fail-safe for a wiping op', () => {
    // Deliberate direction: the gate guards a destructive operation whose
    // premise is that pre-floor behavior is unproven. "We could not establish
    // that this kernel is new enough" must land on refuse, not proceed.
    for (const bad of ['', 'not-a-kernel', 'v6.19'])
      assert.equal(kernelInfo(bad).supportsMixedLbs, false, `'${bad}' must not be trusted`)
  })

  it('quotes the release verbatim so the operator sees what ANAS read', () => {
    assert.equal(kernelInfo('6.14.8-1-pve').release, '6.14.8-1-pve')
    assert.equal(kernelInfo('garbage').release, 'garbage')
  })

  it('defaults to the running kernel', () => {
    assert.equal(kernelInfo().release, runningKernelRelease())
  })
})
