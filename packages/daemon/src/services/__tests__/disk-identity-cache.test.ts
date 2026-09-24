import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { DiskIdentityCache } from '../disk-identity-cache.js'

/**
 * ANAS must never spin up a sleeping disk on its own: the identity cache runs
 * smartctl with `-n standby`, and a standby skip (disk was asleep, nothing was
 * read) must keep the LAST MEASURED identity — reported marked `standby` +
 * `stale` — instead of turning the disk's health into `unknown`. A disk never
 * seen awake is reported as `standby` with no health claim. A standby reading
 * is never a cache hit: the disk may wake at any time, so the next pass
 * retries.
 *
 * A probe FAILURE is not a measurement either: it keeps the disk's last known
 * reading and re-probes — one transient failure must not blank the identity
 * for the daemon's lifetime or end the re-probes. Re-probes are BOUNDED,
 * though: each consecutive failure doubles the delay (1, 2, 4, … passes,
 * capped at 8), so a disk that fails forever is not probed on every pass.
 * `stale` ("last known, not current") is only ever reported OVER A REAL
 * MEASURED READING — a never-measured disk whose probe fails is the plain
 * unknown, unmarked.
 *
 * Crucially, the failure must be classified FROM THE DOCUMENT, not from a
 * parse error: smartctl --json emits a VALID document on an open failure
 * (exit bit 1, a severity 'error' message, no device fields), and the
 * executor RESOLVES on a non-zero exit — so the document reaches the parser
 * as a "successful" read. A "measured" identity built from it is all null,
 * and caching that as a hit would blank the disk and never probe it again.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const SMARTCTL = '/usr/sbin/smartctl'
const ARGS = ['-n', 'standby', '-iH', '--json', '/dev/sdb']

const NORMAL_IDENTITY = JSON.stringify({
  model_family: 'Western Digital Red Pro',
  model_name: 'WDC WD2003FZEX-00SRLA0',
  form_factor: { name: '3.5 inches' },
  firmware_version: '81.00A81',
  sata_version: { string: 'SATA 3.2, 6.0 Gb/s' },
  smart_status: { passed: true },
})

/**
 * The exact document smartctl 7.5 (the PVE node's version) emits for a
 * standby skip — the "(OS)" wording the earlier pattern missed.
 */
const STANDBY_SKIP_75 = readFileSync(
  join(__dirname, '../../fixtures/system/smartctl-standby-skip.json'),
  'utf-8',
)

/**
 * The document smartctl --json emits when it cannot open the device —
 * SYNTHESIZED in the real 7.5 shape (the envelope mirrors
 * smartctl-standby-skip.json; the message is smartctl's own
 * `jerr("Smartctl open device: %s failed: %s")` line, severity 'error',
 * exit bit 1). A VALID document on a FAILED probe: the all-null-identity
 * bug's trigger.
 */
const OPEN_DEVICE_FAILED_75 = readFileSync(
  join(__dirname, '../../fixtures/system/smartctl-open-device-failed.json'),
  'utf-8',
)

function standbyResult(): { stdout: string, stderr: string, exitCode: number } {
  return {
    stdout: JSON.stringify({
      smartctl: { messages: [{ string: 'Device is in STANDBY mode, exit(2)', severity: 'information' }] },
    }),
    stderr: '',
    exitCode: 2,
  }
}

/** A genuine probe failure: non-standby exit, no readable JSON document. */
function failureResult(): { stdout: string, stderr: string, exitCode: number } {
  return {
    stdout: '',
    stderr: 'smartctl: Open \"/dev/sdb\" failed: Input/output error\n',
    exitCode: 1,
  }
}

function normalResult() {
  return { stdout: NORMAL_IDENTITY, stderr: '', exitCode: 0 }
}

/** A real-shape probe failure: VALID JSON, exit bit 1, no device fields. */
function openFailedResult() {
  return { stdout: OPEN_DEVICE_FAILED_75, stderr: '', exitCode: 2 }
}

describe('DiskIdentityCache — smartctl never wakes a sleeping disk', () => {
  it('(a) a standby skip never erases a measured identity — prior health is kept, not unknown', async () => {
    const executor = new MockExecutor()
    // asleep during the first two passes, awake on the third; the disk is
    // asleep again on the fourth (no probe happens — a measured identity is a
    // cache hit, and that is the point: its health is kept, not blanked)
    executor.addFixture({
      command: SMARTCTL,
      args: ARGS,
      results: [standbyResult(), standbyResult(), normalResult()],
    })
    const cache = new DiskIdentityCache(executor)

    const first = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(first.standby, true, 'first pass: asleep, nothing read')
    const second = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(second.standby, true, 'second pass: still asleep — retried, not cached')
    const measured = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(measured.deviceModel, 'WDC WD2003FZEX-00SRLA0')
    assert.equal(measured.smartHealthy, true)

    const kept = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(kept.deviceModel, 'WDC WD2003FZEX-00SRLA0', 'last measured identity is kept')
    assert.equal(kept.smartHealthy, true, 'last measured health is kept — never unknown')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 3, 'once measured, the identity is a cache hit')
  })

  it('(b) a first-seen standby disk is reported standby with no health claim, and retries next pass', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ARGS, result: standbyResult() })
    const cache = new DiskIdentityCache(executor)

    const identity = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(identity.deviceModel, null)
    assert.equal(identity.smartHealthy, null, 'no health claim — nothing was read')
    assert.equal(identity.standby, true)
    assert.equal(identity.stale, undefined, 'nothing was ever measured, so nothing is stale')
    assert.equal(identity.staleReason, undefined)

    await cache.get('ata-WDC_A', '/dev/sdb')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 2, 'a standby reading is not a cache hit — retry on next pass')
  })

  it('(c) a woken disk is re-read as a fresh measured reading', async () => {
    const executor = new MockExecutor()
    // asleep during the first pass, awake when the disk is next seen
    executor.addFixture({ command: SMARTCTL, args: ARGS, results: [standbyResult(), normalResult()] })
    const cache = new DiskIdentityCache(executor)

    const asleep = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(asleep.standby, true)

    const awake = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(awake.deviceModel, 'WDC WD2003FZEX-00SRLA0')
    assert.equal(awake.smartHealthy, true)
    assert.equal(awake.standby, undefined, 'the standby mark is gone once measured')
    assert.equal(awake.stale, undefined)
    assert.equal(cache.getCached('ata-WDC_A')?.standby, undefined)
  })

  it('(d) the smartctl 7.5 "(OS)" wording is a standby skip, not a failure', async () => {
    const executor = new MockExecutor()
    executor.addFixture({
      command: SMARTCTL,
      args: ARGS,
      result: { stdout: STANDBY_SKIP_75, stderr: '', exitCode: 2 },
    })
    const cache = new DiskIdentityCache(executor)

    const identity = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(identity.standby, true)
    assert.equal(identity.smartHealthy, null, 'no health claim, not a parsed header-as-identity')

    // the 47a61c4 bug: the "(OS)" wording missed the pattern, the header
    // document parsed as an all-null identity, and THAT got cached — a
    // permanent cache hit, so the disk never got measured, even awake.
    await cache.get('ata-WDC_A', '/dev/sdb')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 2, 'a 7.5 standby skip is retried, not cached as a measured identity')
  })

  it('(e) a plain-text skip (no JSON document) is still a standby reading', async () => {
    const executor = new MockExecutor()
    executor.addFixture({
      command: SMARTCTL,
      args: ARGS,
      result: {
        stdout: '',
        stderr: 'Device is in STANDBY (OS) mode, exit(2)\n',
        exitCode: 2,
      },
    })
    const cache = new DiskIdentityCache(executor)

    const identity = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(identity.standby, true)
    assert.equal(identity.smartHealthy, null)
  })

  it('(f) normal result → identity populated and cached (second get() does not call smartctl)', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ARGS, result: normalResult() })
    const cache = new DiskIdentityCache(executor)

    const identity = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(identity.deviceModel, 'WDC WD2003FZEX-00SRLA0')
    assert.equal(identity.modelFamily, 'Western Digital Red Pro')
    assert.equal(identity.smartHealthy, true)

    await cache.get('ata-WDC_A', '/dev/sdb')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 1, 'a read identity is cached')
  })

  it('(g) smartctl is invoked with -n standby so a sleeping disk is never spun up', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ARGS, result: normalResult() })
    const cache = new DiskIdentityCache(executor)

    await cache.get('ata-WDC_A', '/dev/sdb')
    const call = executor.calls.find(c => c.command === SMARTCTL)
    assert.ok(call)
    assert.deepEqual(call.args.slice(0, 2), ['-n', 'standby'])
  })

  it('(h) a first-ever probe failure is the plain unknown — unmarked, with backoff-bounded retries', async () => {
    const executor = new MockExecutor()
    // No fixture at all → mock's command-not-found (exit 127), invalid JSON.
    const cache = new DiskIdentityCache(executor)

    const identity = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(identity.smartHealthy, null)
    assert.equal(identity.standby, false, 'a failure is not a power-mode skip')
    assert.equal(identity.stale, undefined, 'there was no prior reading to be stale relative to')
    assert.equal(identity.staleReason, 'probe-failed', 'the re-probe duty rides on the reason, not the mark')

    // Bounded, not never, not every pass: failure 1 waits one pass, failure 2
    // waits two. (The old "cached so a never-answering disk is not re-probed
    // at all" left a transient first failure — a udev race at boot — blanking
    // the disk for the daemon's lifetime.)
    const smartCalls = () => executor.calls.filter(c => c.command === SMARTCTL).length
    await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(smartCalls(), 2, 'a failing disk is re-probed — failure 1 waited one pass')
    await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(smartCalls(), 2, 'failure 2 waits two passes — not probed on every pass')
  })

  it('(i) a probe failure on a seen disk keeps the last known reading, backs off, and recovers', async () => {
    const executor = new MockExecutor()
    // asleep, then a transient failure that STICKS across passes, then the
    // disk answers — the failure must neither blank the reading, nor become
    // an every-pass hammer
    executor.addFixture({
      command: SMARTCTL,
      args: ARGS,
      results: [standbyResult(), failureResult(), failureResult(), normalResult()],
    })
    const cache = new DiskIdentityCache(executor)

    const asleep = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(asleep.standby, true)

    const failed = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(failed.standby, false, 'the power mode is no longer known — the probe did not get to report it')
    assert.equal(failed.stale, undefined, 'nothing was ever MEASURED — "last known" would be a claim about a reading that never happened')
    assert.equal(failed.staleReason, 'probe-failed')
    assert.equal(failed.smartHealthy, null, 'nothing was ever measured — the unknown stands, unmarked')

    const failedAgain = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(failedAgain.staleReason, 'probe-failed', 'still unmarked-failed')
    let smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 3, 'failure 1 waited one pass — re-probed on the next')

    // the second failure waits two passes: this pass does not probe
    await cache.get('ata-WDC_A', '/dev/sdb')
    smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 3, 'backoff — a disk that keeps failing is not probed on every pass')

    const recovered = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(recovered.deviceModel, 'WDC WD2003FZEX-00SRLA0', 'once smartctl answers, the identity is measured for real')
    assert.equal(recovered.smartHealthy, true)
    assert.equal(recovered.stale, undefined, 'the stale mark is gone once a fresh reading lands')
    assert.equal(recovered.standby, undefined)
    smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 4)
  })

  it('(j) a probe failure after a MEASURED reading keeps the measured identity, stale', async () => {
    // The measured-then-failure state is reached through the cache's public
    // surface by a disk that measured, was pruned out of the topology, came
    // back, and failed its re-probe… which is a NEW key to the cache. The
    // keep-measured branch itself is exercised through the reading the cache
    // holds: seed it the way a measured probe would have (the map is the
    // cache's own bookkeeping, and the branch under test is the error path's
    // handling of a non-empty measured entry).
    const executor = new MockExecutor()
    executor.addFixture({
      command: SMARTCTL,
      args: ARGS,
      results: [normalResult(), failureResult(), normalResult()],
    })
    const cache = new DiskIdentityCache(executor)

    await cache.get('ata-WDC_A', '/dev/sdb')
    // A measured reading is a cache hit — the only live path to a failing
    // probe on a disk WITH a measured entry is through a standby phase, which
    // the due policy (test (a)) pins as "no re-probe". Drive the error branch
    // directly against the cache's own state:
    const cacheAny = cache as unknown as { reading: Map<string, object> }
    cacheAny.reading.set('ata-WDC_A', { standby: true })
    const failed = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(failed.deviceModel, 'WDC WD2003FZEX-00SRLA0', 'the measured identity survives the failed probe')
    assert.equal(failed.modelFamily, 'Western Digital Red Pro')
    assert.equal(failed.smartHealthy, true, 'the last measured health survives — never blanked')
    assert.equal(failed.stale, true)
    assert.equal(failed.staleReason, 'probe-failed')
    assert.equal(failed.standby, false)

    const recovered = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(recovered.deviceModel, 'WDC WD2003FZEX-00SRLA0')
    assert.equal(recovered.stale, undefined, 'fresh again once the probe succeeds')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 3, 'probe, failed re-probe, recovered re-probe')
  })

  it('(k) a device that leaves the topology is pruned only after three consecutive absent passes', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ['-n', 'standby', '-iH', '--json', '/dev/sdb'], result: normalResult() })
    executor.addFixture({ command: SMARTCTL, args: ['-n', 'standby', '-iH', '--json', '/dev/sdc'], result: normalResult() })
    const cache = new DiskIdentityCache(executor)

    await cache.loadMany([
      { id: 'ata-A', path: '/dev/sdb' },
      { id: 'ata-B', path: '/dev/sdc' },
    ])
    assert.ok(cache.getCached('ata-A'), 'both disks loaded')
    assert.ok(cache.getCached('ata-B'))

    // sdc is pulled: absent from the next refresh — one pass proves nothing
    // (a momentary enumeration glitch must not cost the fleet its entries)
    await cache.loadMany([{ id: 'ata-A', path: '/dev/sdb' }])
    assert.ok(cache.getCached('ata-B'), 'one absent pass: still kept')
    await cache.loadMany([{ id: 'ata-A', path: '/dev/sdb' }])
    assert.ok(cache.getCached('ata-B'), 'two absent passes: still kept')
    await cache.loadMany([{ id: 'ata-A', path: '/dev/sdb' }])
    assert.equal(cache.getCached('ata-B'), null, 'three absent passes: dropped')

    // The dropped device is re-probed if it comes back — no stale entry lingers.
    await cache.loadMany([{ id: 'ata-B', path: '/dev/sdc' }])
    assert.equal(cache.getCached('ata-B')?.deviceModel, 'WDC WD2003FZEX-00SRLA0')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 3)
  })

  it('(l) an open-failed DOCUMENT after a good reading keeps the measured identity, stale, and re-probes', async () => {
    // The T1 bug, end to end: the executor RESOLVES on the non-zero exit, so
    // smartctl's open-failure document (valid JSON, exit bit 1, severity
    // 'error', no device fields) reached JSON.parse "successfully" and came
    // back as a MEASURED all-null identity — overwriting the good one and
    // caching as a hit, so the disk was blank and never probed again.
    const executor = new MockExecutor()
    executor.addFixture({
      command: SMARTCTL,
      args: ARGS,
      results: [normalResult(), openFailedResult(), openFailedResult(), normalResult()],
    })
    const cache = new DiskIdentityCache(executor)

    await cache.get('ata-WDC_A', '/dev/sdb')
    // A measured reading is a cache hit — the only live path to a failing
    // probe on a disk WITH a measured entry is through a standby phase, so
    // drive the re-probe the way the cache would see it (test (j)'s path):
    const cacheAny = cache as unknown as { reading: Map<string, object> }
    cacheAny.reading.set('ata-WDC_A', { standby: true })

    const failed = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(failed.deviceModel, 'WDC WD2003FZEX-00SRLA0', 'the measured identity survives the open-failed document')
    assert.equal(failed.modelFamily, 'Western Digital Red Pro')
    assert.equal(failed.smartHealthy, true, 'the last measured health survives — never blanked')
    assert.equal(failed.stale, true, 'a REAL measured reading was taken — this one is last known')
    assert.equal(failed.staleReason, 'probe-failed')
    assert.equal(failed.standby, false)

    // failure 1 waited one pass: the disk is probed again — and it fails
    // again, still keeping the measured identity
    const failedAgain = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(failedAgain.deviceModel, 'WDC WD2003FZEX-00SRLA0')
    assert.equal(failedAgain.staleReason, 'probe-failed')
    let smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 3, 'a failed probe is not a cache hit — re-probed')

    // failure 2 waits two passes…
    await cache.get('ata-WDC_A', '/dev/sdb')
    smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 3, '…and is honored')

    // …and the disk answers: a fresh measured reading, the marks gone
    const recovered = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(recovered.stale, undefined, 'fresh again once the probe succeeds')
    assert.equal(recovered.smartHealthy, true)
    smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 4)
  })

  it('(m) an open-failed document on a never-measured disk is the plain unknown — no stale, retries alive', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ARGS, result: openFailedResult() })
    const cache = new DiskIdentityCache(executor)

    const identity = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(identity.deviceModel, null)
    assert.equal(identity.smartHealthy, null, 'unknown — and NOT a cached all-null "measurement"')
    assert.equal(identity.stale, undefined, 'nothing was ever measured — there is no reading to be stale relative to')
    assert.equal(identity.staleReason, 'probe-failed', 'the re-probe duty, without the mark')
    assert.equal(identity.standby, false)

    // The old bug: the valid failure document parsed as an all-null MEASURED
    // identity and cached as a hit — never probed again, even once smartctl
    // recovered. Now failure 1 waits one pass and the retry is alive.
    await cache.get('ata-WDC_A', '/dev/sdb')
    const smartCalls = executor.calls.filter(c => c.command === SMARTCTL)
    assert.equal(smartCalls.length, 2, 'the retry is alive — bounded, not dead')
  })

  it('(n) a disk that keeps failing backs off 1, 2, 4, … up to 8 passes between probes', async () => {
    const executor = new MockExecutor()
    // asleep once, then failing forever (the last result repeats)
    executor.addFixture({ command: SMARTCTL, args: ARGS, results: [standbyResult(), failureResult()] })
    const cache = new DiskIdentityCache(executor)

    const smartCalls = () => executor.calls.filter(c => c.command === SMARTCTL).length
    async function pass() {
      await cache.get('ata-WDC_A', '/dev/sdb')
    }

    await pass() // 1: asleep
    assert.equal(smartCalls(), 1)
    await pass() // 2: fails (1) — next attempt 1 pass later
    assert.equal(smartCalls(), 2)
    await pass() // 3: fails (2) — next attempt 2 passes later
    assert.equal(smartCalls(), 3)
    await pass() // 4: backoff
    assert.equal(smartCalls(), 3)
    await pass() // 5: fails (3) — next attempt 4 passes later
    assert.equal(smartCalls(), 4)
    await pass() // 6: backoff
    await pass() // 7: backoff
    await pass() // 8: backoff
    assert.equal(smartCalls(), 4)
    await pass() // 9: fails (4) — next attempt 8 passes later
    assert.equal(smartCalls(), 5)
    await pass() // 10: backoff
    await pass() // 11: backoff
    await pass() // 12: backoff
    await pass() // 13: backoff
    await pass() // 14: backoff
    await pass() // 15: backoff
    await pass() // 16: backoff
    assert.equal(smartCalls(), 5)
    await pass() // 17: fails (5) — capped at 8
    assert.equal(smartCalls(), 6)
  })

  it('(o) an empty or degraded enumeration prunes nothing — the fleet keeps its identities', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ['-n', 'standby', '-iH', '--json', '/dev/sdb'], result: normalResult() })
    executor.addFixture({ command: SMARTCTL, args: ['-n', 'standby', '-iH', '--json', '/dev/sdc'], result: normalResult() })
    const cache = new DiskIdentityCache(executor)

    await cache.loadMany([
      { id: 'ata-A', path: '/dev/sdb' },
      { id: 'ata-B', path: '/dev/sdc' },
    ])
    assert.ok(cache.getCached('ata-A'))
    assert.ok(cache.getCached('ata-B'))

    // The T3 bug, end to end: ls /dev/disk/by-id/ came back empty for one
    // pass, so every disk id fell back to the kernel name — pruning on such
    // a list would drop the WHOLE cache (the sleeping disks' preserved
    // identities included), and every id would re-fall-back next pass.
    await cache.loadMany(
      [
        { id: 'sdb', path: '/dev/sdb' },
        { id: 'sdc', path: '/dev/sdc' },
      ],
      { prunable: false },
    )
    assert.ok(cache.getCached('ata-A'), 'the by-id entries survive a degraded enumeration')
    assert.ok(cache.getCached('ata-B'))

    // and an empty enumeration (lsblk returned nothing) prunes nothing either
    await cache.loadMany([])
    assert.ok(cache.getCached('ata-A'))
    assert.ok(cache.getCached('ata-B'))

    // the next healthy pass re-establishes the by-id names; the fleet is intact
    await cache.loadMany([
      { id: 'ata-A', path: '/dev/sdb' },
      { id: 'ata-B', path: '/dev/sdc' },
    ])
    assert.ok(cache.getCached('ata-A'))
    assert.ok(cache.getCached('ata-B'))
  })

  it('(p) one fallback disk does not veto pruning for the rest of the fleet (fourth pass)', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ['-n', 'standby', '-iH', '--json', '/dev/sdb'], result: normalResult() })
    executor.addFixture({ command: SMARTCTL, args: ['-n', 'standby', '-iH', '--json', '/dev/sdc'], result: normalResult() })
    executor.addFixture({ command: SMARTCTL, args: ['-n', 'standby', '-iH', '--json', '/dev/sdd'], result: normalResult() })
    const cache = new DiskIdentityCache(executor)

    await cache.loadMany([
      { id: 'ata-A', path: '/dev/sdb' },
      { id: 'ata-B', path: '/dev/sdc' },
    ])
    assert.ok(cache.getCached('ata-A'))
    assert.ok(cache.getCached('ata-B'))

    // The by-id listing came back EMPTY (T3, unchanged): the route passes
    // prunable: false with no presentIds — nothing prunes. sdd's identity is
    // taken under its fallback kernel id, the only name such a pass has.
    await cache.loadMany(
      [
        { id: 'sdb', path: '/dev/sdb' },
        { id: 'sdd', path: '/dev/sdd' },
      ],
      { prunable: false },
    )
    assert.ok(cache.getCached('ata-A'), 'an empty by-id listing still names no fleet')
    assert.ok(cache.getCached('ata-B'))

    // Now the listing is HEALTHY, but sdd has no by-id symlink (virtio without
    // a serial, some USB bridges) and falls back to its kernel name every
    // pass. The old route gate (`disks.every(d => byIdMap.has(d.name))`) read
    // that ONE fallback as "the list cannot name the fleet" and pruning never
    // ran again — the cache grew without bound for the daemon's lifetime. The
    // gate is the LISTING; only ids that resolved through by-id count as
    // present, so the by-id fleet prunes normally — and a STILL-LISTED
    // fallback key is exactly the kind of entry that goes stale, so it does
    // not linger either.
    const pass = () => cache.loadMany(
      [
        { id: 'ata-A', path: '/dev/sdb' },
        { id: 'sdd', path: '/dev/sdd' },
      ],
      { prunable: true, presentIds: ['ata-A'] },
    )
    await pass()
    assert.ok(cache.getCached('ata-B'), 'one absent pass beside a fallback disk: still kept')
    await pass()
    assert.ok(cache.getCached('ata-B'), 'two absent passes: still kept')
    await pass()
    assert.equal(cache.getCached('ata-B'), null, 'three trusted absent passes: dropped, fallback disk notwithstanding')
    assert.ok(cache.getCached('ata-A'), 'the disk the listing names by id is untouched')
    // The fallback key's fate is only observable through its probes: dropped
    // at the third pass, re-measured in the same pass. Under the old shape
    // (presence = the whole list) its measured entry was cached for ever.
    const sddProbes = executor.calls.filter(c => c.command === SMARTCTL && c.args.includes('/dev/sdd')).length
    assert.equal(sddProbes, 2, 'the fallback entry was dropped and re-measured, not cached for ever')
  })
})

/**
 * disks.1 — a measured reading AGES OUT. A clean measured reading used to be a
 * cache hit for the daemon's lifetime, so a reallocated-sector count that
 * started climbing was invisible until the daemon restarted. Now a reading is
 * a hit only WITHIN the re-probe cadence (default 30 minutes — smartd's own
 * check interval, `ANAS_SMART_REPROBE_MS` to override for tests); past it the
 * next pull re-probes. The re-probe is the same `-n standby` call, so a disk
 * that fell asleep in the meantime is never woken — its last measured values
 * and their age are kept under the existing standby mark. A failed re-probe
 * keeps the values under the existing probe-failed mark and the EXISTING
 * backoff — aging must not have created a second, unbounded retry path.
 * The clock is injected: no test sleeps.
 */
describe('DiskIdentityCache — readings age out on the pull (disks.1)', () => {
  /** A mutable clock: tests age readings by moving `now`. */
  function clock() {
    const state = { now: 1_750_000_000_000 }
    return {
      now: () => state.now,
      advance: (ms: number) => { state.now += ms },
    }
  }

  function measuredWithPowerMode() {
    return { stdout: JSON.stringify({
      ...JSON.parse(NORMAL_IDENTITY),
      power_mode: { string: 'ACTIVE or IDLE' },
    }), stderr: '', exitCode: 0 }
  }

  const smartCalls = (executor: { calls: { command: string }[] }) =>
    executor.calls.filter(c => c.command === SMARTCTL).length

  it('(A) a fresh measured reading is a cache hit within the cadence', async () => {
    const clk = clock()
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ARGS, result: normalResult() })
    const cache = new DiskIdentityCache(executor, { now: clk.now })

    const first = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(first.measuredAt, clk.now(), 'the reading is dated at measurement time')
    clk.advance(29 * 60 * 1000) // one minute short of the cadence
    await cache.get('ata-WDC_A', '/dev/sdb')
    clk.advance(60 * 1000 - 1) // still a hair inside 30 minutes
    await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(smartCalls(executor), 1, 'a reading inside the cadence is a hit')
  })

  it('(B) a reading aged past the cadence is re-probed, with -n standby in the argv', async () => {
    const clk = clock()
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ARGS, results: [normalResult(), normalResult()] })
    const cache = new DiskIdentityCache(executor, { now: clk.now })

    await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(smartCalls(executor), 1)
    clk.advance(30 * 60 * 1000) // the cadence, exactly
    const second = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(smartCalls(executor), 2, 'an aged reading is due on the next pull')
    assert.equal(second.measuredAt, clk.now(), 'the fresh reading carries its own timestamp')

    const call = executor.calls.find(c => c.command === SMARTCTL)
    assert.ok(call)
    assert.deepEqual(call.args.slice(0, 2), ['-n', 'standby'], 'the re-probe never wakes the disk')
  })

  it('(C) an aged disk that fell asleep is not woken — values and reading age are kept', async () => {
    const clk = clock()
    const executor = new MockExecutor()
    executor.addFixture({
      command: SMARTCTL,
      args: ARGS,
      results: [measuredWithPowerMode(), {
        stdout: '',
        stderr: 'Device is in STANDBY (OS) mode, exit(2)\n',
        exitCode: 2,
      }],
    })
    const cache = new DiskIdentityCache(executor, { now: clk.now })

    const measured = await cache.get('ata-WDC_A', '/dev/sdb')
    const measuredAt = measured.measuredAt
    assert.equal(measured.powerMode, 'ACTIVE or IDLE', 'the power mode rides the measurement')
    clk.advance(45 * 60 * 1000)

    const stale = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(smartCalls(executor), 2, 'the aged reading was re-probed')
    assert.equal(stale.standby, true, 'the re-probe was a standby skip — the disk was not woken')
    assert.equal(stale.deviceModel, 'WDC WD2003FZEX-00SRLA0', 'the last measured values are kept')
    assert.equal(stale.smartHealthy, true)
    assert.equal(stale.powerMode, 'ACTIVE or IDLE', 'the power mode rides the identity it was measured with')
    assert.equal(stale.measuredAt, measuredAt, 'the reading reports the MEASURED reading\'s age')
    assert.equal(stale.stale, true)
    assert.equal(stale.staleReason, 'standby')
  })

  it('(D) a failed re-probe of an aged reading keeps the values and the existing backoff', async () => {
    const clk = clock()
    const executor = new MockExecutor()
    executor.addFixture({
      command: SMARTCTL,
      args: ARGS,
      results: [normalResult(), failureResult(), failureResult(), normalResult()],
    })
    const cache = new DiskIdentityCache(executor, { now: clk.now })

    await cache.get('ata-WDC_A', '/dev/sdb')
    clk.advance(31 * 60 * 1000)

    const failed = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(smartCalls(executor), 2, 'the aged reading was re-probed')
    assert.equal(failed.stale, true, 'a real measurement was taken — this one is last known')
    assert.equal(failed.staleReason, 'probe-failed')
    assert.equal(failed.deviceModel, 'WDC WD2003FZEX-00SRLA0', 'the measured identity survives')
    assert.equal(failed.smartHealthy, true)

    // The failure enters the SAME bounded backoff, not a fresh every-pass path
    // — the exact ladder test (i) pins: failure 1 re-probes on the next pass,
    // failure 2 waits two.
    await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(smartCalls(executor), 3, 'failure 1 re-probes on the next pass — the retry is alive, not dead')

    await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(smartCalls(executor), 3, 'failure 2 waits two passes — no hammering')

    const recovered = await cache.get('ata-WDC_A', '/dev/sdb')
    assert.equal(smartCalls(executor), 4, 'and the disk answers')
    assert.equal(recovered.stale, undefined, 'fresh once the probe answers')
    assert.equal(recovered.measuredAt, clk.now())
  })

  it('(E) two concurrent loadMany passes probe a due disk once', async () => {
    const clk = clock()
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ['-n', 'standby', '-iH', '--json', '/dev/sdb'], result: normalResult() })
    executor.addFixture({ command: SMARTCTL, args: ['-n', 'standby', '-iH', '--json', '/dev/sdc'], result: normalResult() })
    const cache = new DiskIdentityCache(executor, { now: clk.now })

    const fleet = [
      { id: 'ata-A', path: '/dev/sdb' },
      { id: 'ata-B', path: '/dev/sdc' },
    ]
    // Two consumers pull at once (Disks tab + dashboard) — the pending map
    // dedupes, one probe per disk.
    await Promise.all([cache.loadMany(fleet), cache.loadMany(fleet)])
    assert.equal(smartCalls(executor), 2, 'one probe per disk, not one per pull')

    // And the same again inside the cadence: still two.
    await Promise.all([cache.loadMany(fleet), cache.loadMany(fleet)])
    assert.equal(smartCalls(executor), 2, 'fresh readings are hits for both pulls')
  })

  it('(F) ANAS_SMART_REPROBE_MS overrides the cadence', async () => {
    const clk = clock()
    const executor = new MockExecutor()
    executor.addFixture({ command: SMARTCTL, args: ARGS, results: [normalResult(), normalResult()] })
    const old = process.env.ANAS_SMART_REPROBE_MS
    process.env.ANAS_SMART_REPROBE_MS = '5000'
    try {
      const cache = new DiskIdentityCache(executor, { now: clk.now })
      await cache.get('ata-WDC_A', '/dev/sdb')
      clk.advance(5 * 1000)
      await cache.get('ata-WDC_A', '/dev/sdb')
      assert.equal(smartCalls(executor), 2, 'aged past the 5 s override — re-probed')

      // A cache that names its own cadence is not moved by the env.
      const executor2 = new MockExecutor()
      executor2.addFixture({ command: SMARTCTL, args: ARGS, result: normalResult() })
      const pinned = new DiskIdentityCache(executor2, { now: clk.now, reprobeMs: 60 * 60 * 1000 })
      await pinned.get('ata-WDC_B', '/dev/sdb')
      clk.advance(30 * 60 * 1000)
      await pinned.get('ata-WDC_B', '/dev/sdb')
      assert.equal(
        executor2.calls.filter(c => c.command === SMARTCTL).length,
        1,
        'an explicit reprobeMs option wins over the env',
      )
    }
    finally {
      if (old === undefined) {
        delete process.env.ANAS_SMART_REPROBE_MS
      }
      else {
        process.env.ANAS_SMART_REPROBE_MS = old
      }
    }
  })
})
