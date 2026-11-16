import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { explainRestoreFailure, imageBytesWritten, parseRestoreProgress } from '../backup-restore.js'

/*
 * Node capture 2026-11-15 (fixtures/backup/img-restore-complete-pbc-4.2.0.txt):
 * proxmox-backup-client 4.2.0 ends a whole-image restore with
 * `restore image complete (bytes=N, duration=..., speed=...)` as its only line.
 * The stderr fed here is the capture's own line, padding included.
 */
const CAPTURE = readFileSync(new URL('../../fixtures/backup/img-restore-complete-pbc-4.2.0.txt', import.meta.url), 'utf-8')
const STDERR = `${CAPTURE.split('\n').filter(l => l !== '' && !l.startsWith('#')).join('\r')}\r`
const IMAGE = 536870912

describe('the image completion line of proxmox-backup-client 4.2.0', () => {
  it('the capture holds exactly the one line', () => {
    assert.equal(STDERR, 'restore image complete (bytes=536870912, duration=5.43s, speed=94.28MB/s)    \r')
  })

  it('is read as the client reporting the restore complete, with its exact byte count', () => {
    const p = parseRestoreProgress(STDERR)
    assert.equal(p.complete, 'restore image complete (bytes=536870912, duration=5.43s, speed=94.28MB/s)')
    assert.equal(p.completeBytes, IMAGE)
    assert.equal(p.percent, null)
    assert.equal(p.lastLine, null)
  })

  it('counts the whole image as written on exit 0, and nothing on a non-zero exit', () => {
    assert.deepEqual(imageBytesWritten(0, parseRestoreProgress(STDERR), IMAGE, 0), { bytes: IMAGE, estimated: false })
    assert.notDeepEqual(imageBytesWritten(0, parseRestoreProgress(STDERR), IMAGE, 1), { bytes: IMAGE, estimated: false })
  })

  it('a completion line whose count is not the image size is not counted as the whole image', () => {
    const short = parseRestoreProgress('restore image complete (bytes=1048576, duration=0.1s, speed=10MB/s)\r')
    assert.deepEqual(imageBytesWritten(0, short, IMAGE, 0), { bytes: 1048576, estimated: false })
  })

  it('the older shape still reads complete and carries no byte count', () => {
    const p = parseRestoreProgress('restore complete (512 MiB processed in 0.4s, average 1.15 GiB/s)    \r')
    assert.equal(p.complete, 'restore complete (512 MiB processed in 0.4s, average 1.15 GiB/s)')
    assert.equal(p.completeBytes, undefined)
    assert.deepEqual(imageBytesWritten(0, p, IMAGE, 0), { bytes: IMAGE, estimated: false })
  })

  it('a completion line carrying a count ANAS cannot read is a state, never "no count" (cr4.lun D-6)', () => {
    // Only the two CAPTURED shapes count (fixtures/backup/): the countless
    // old line and the 4.2.0 `bytes=N` line. A line that puts anything else
    // where the count belongs states a count ANAS could not read, which is
    // not the same as the old line that states none.
    for (const inner of [
      'bytes=1048576 duration=1s', // no comma after the count
      'bytes=1.0M, duration=1s, speed=1MB/s', // not a byte integer
      'bytes=-5, duration=1s, speed=1MB/s',
      'xbytes=5, duration=1s, speed=1MB/s',
      'bytes=99999999999999999999, duration=1s, speed=1MB/s', // beyond a safe integer
    ]) {
      const p = parseRestoreProgress(`restore image complete (${inner})    \r`)
      assert.equal(p.complete, `restore image complete (${inner})`, inner)
      assert.equal(p.completeBytes, 'unreadable', inner)
    }
  })

  it('a line that only resembles it is not a completion', () => {
    for (const line of ['restore image incomplete (bytes=1)', 'xrestore image complete (bytes=1)', 'restore image complete', 'Error: restore image complete (bytes=1)'])
      assert.equal(parseRestoreProgress(`${line}\r`).complete, null, line)
  })

  it('a killed client that printed no progress is not said to have a last progress line', () => {
    const none = explainRestoreFailure('', 'SIGKILL')
    assert.equal(none, 'The image restore was interrupted - the client was killed by SIGKILL and reported no error of its own and no progress, so how much reached the target is not known.')
    const some = explainRestoreFailure('progress 17% (43.939 MiB of 250.001 MiB in 16.1s, 3.1 MiB/s)    \r', 'SIGKILL')
    assert.equal(some, 'The image restore was interrupted - the client was killed by SIGKILL and reported no error of its own; what reached the target is at least what its last progress line claimed.')
  })
})
