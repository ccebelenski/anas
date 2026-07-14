import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSmbStatusJson, parseSmbStatusText } from '../smbstatus.js'

describe('parseSmbStatusJson', () => {
  const json = JSON.stringify({
    sessions: {
      111: { username: 'alice', remote_machine: '10.0.0.5', hostname: 'ipv4:10.0.0.5:49610' },
      222: { username: 'bob', remote_machine: '10.0.0.6', hostname: 'ipv4:10.0.0.6:50123' },
    },
    tcons: {
      1: { service: 'media', session_id: '111', machine: '10.0.0.5' },
      2: { service: 'media', session_id: '222', machine: '10.0.0.6' },
      3: { service: 'archive', session_id: '111', machine: '10.0.0.5' },
      4: { service: 'IPC$', session_id: '111', machine: '10.0.0.5' },
    },
  })

  it('maps tree-connects to per-service connections with resolved users', () => {
    const byService = parseSmbStatusJson(json)
    assert.equal(byService.media.length, 2)
    assert.deepEqual(byService.media, [
      { user: 'alice', machine: '10.0.0.5' },
      { user: 'bob', machine: '10.0.0.6' },
    ])
    assert.deepEqual(byService.archive, [{ user: 'alice', machine: '10.0.0.5' }])
  })

  it('skips the IPC$ pseudo-share', () => {
    assert.equal(parseSmbStatusJson(json).IPC$, undefined)
  })

  it('falls back to guest and hostname when the session/machine is missing', () => {
    const j = JSON.stringify({ tcons: { 1: { service: 'media', session_id: '999' } }, sessions: {} })
    assert.deepEqual(parseSmbStatusJson(j).media, [{ user: 'guest', machine: '' }])
  })

  it('strips the ipv4:addr:port form to a bare address', () => {
    const j = JSON.stringify({
      sessions: { 1: { username: 'x', hostname: 'ipv4:192.168.1.9:445' } },
      tcons: { 1: { service: 's', session_id: '1' } },
    })
    assert.equal(parseSmbStatusJson(j).s[0].machine, '192.168.1.9')
  })
})

describe('parseSmbStatusText fallback', () => {
  it('parses the connected-services listing', () => {
    const out = [
      'Samba version 4.19.5',
      '',
      'Service      pid     Machine       Connected at',
      '-------------------------------------------------------',
      'media        12345   10.0.0.50     Mon Jul 13 10:00:00 2026 UTC',
      'archive      12346   10.0.0.51     Mon Jul 13 10:01:00 2026 UTC',
      'IPC$         12347   10.0.0.50     Mon Jul 13 10:00:00 2026 UTC',
      '',
    ].join('\n')
    const byService = parseSmbStatusText(out)
    assert.deepEqual(byService.media, [{ user: 'guest', machine: '10.0.0.50' }])
    assert.deepEqual(byService.archive, [{ user: 'guest', machine: '10.0.0.51' }])
    assert.equal(byService.IPC$, undefined)
  })
})
