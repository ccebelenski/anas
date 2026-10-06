import type { CloudProvider, CloudRemote } from '@anas/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeTasks, destinationChanges, isDestinationOption, remotesReaching, tasksReachingRemote } from '../cloud-retarget.js'

/**
 * Story ident.4 (b), audit #15 — which remote updates re-point a task, and
 * which tasks they re-point (directly or through a wrapper).
 */

const S3: CloudRemote = {
  name: 'b2s3',
  type: 's3',
  options: { provider: 'Other', endpoint: 's3.a.example', region: 'eu', acl: 'private' },
  secretsSet: ['secret_access_key'],
}

/** A provider catalogue where one `endpoint`-suffixed option is a switch. */
const PROVIDERS = [{
  name: 's3',
  description: 'S3',
  options: [
    { name: 'use_accelerate_endpoint', type: 'bool' },
    { name: 'endpoint', type: 'string' },
  ],
}] as unknown as CloudProvider[]

describe('cloud retarget guard (ident.4 (b))', () => {
  it('destination options are named by suffix; a bool switch is not a place', () => {
    for (const key of ['endpoint', 'host', 'url', 'bucket', 'remote', 'upstreams', 'region', 'provider', 'root_folder_id', 'storage_url', 'port'])
      assert.ok(isDestinationOption(key, 's3', PROVIDERS), key)
    for (const key of ['acl', 'user', 'chunk_size', 'upload_cutoff', 'pass'])
      assert.ok(!isDestinationOption(key, 's3', PROVIDERS), key)
    assert.ok(!isDestinationOption('use_accelerate_endpoint', 's3', PROVIDERS))
  })

  it('a change is a value that differs from the stored one; \'\' removes; secrets and other options never count', () => {
    assert.deepEqual(destinationChanges(S3, { endpoint: 's3.b.example', acl: 'public-read' }, PROVIDERS), [
      { key: 'endpoint', from: 's3.a.example', to: 's3.b.example' },
    ])
    assert.deepEqual(destinationChanges(S3, { endpoint: 's3.a.example' }, PROVIDERS), [], 'unchanged value')
    assert.deepEqual(destinationChanges(S3, { region: '' }, PROVIDERS), [{ key: 'region', from: 'eu', to: '' }], 'removal')
    assert.deepEqual(destinationChanges(S3, { secret_access_key: 'new' }, PROVIDERS), [], 'a secret')
    assert.deepEqual(destinationChanges(S3, { use_accelerate_endpoint: 'true' }, PROVIDERS), [], 'a switch')
  })

  it('wrappers reach the remote transitively (crypt over alias over the remote)', () => {
    const remotes: CloudRemote[] = [
      { name: 'base', type: 'sftp', options: { host: 'h' }, secretsSet: [] },
      { name: 'al', type: 'alias', options: { remote: 'base:dir' }, secretsSet: [] },
      { name: 'cr', type: 'crypt', options: { remote: 'al:enc' }, secretsSet: ['password'] },
      { name: 'other', type: 'sftp', options: { host: 'base:not-a-ref-shape-but-is' }, secretsSet: [] },
    ]
    assert.deepEqual(remotesReaching(remotes, 'base'), ['base', 'al', 'cr'])
  })

  it('tasks are named once, with the wrapper they reach the remote through', async () => {
    const remotes: CloudRemote[] = [
      { name: 'base', type: 'sftp', options: {}, secretsSet: [] },
      { name: 'cr', type: 'crypt', options: { remote: 'base:enc' }, secretsSet: [] },
    ]
    const tasks = await tasksReachingRemote(remotes, 'base', async r => (r === 'base' ? ['direct'] : r === 'cr' ? ['offsite', 'direct'] : []))
    assert.deepEqual(tasks, [{ task: 'direct' }, { task: 'offsite', via: 'cr' }])
    assert.equal(describeTasks(tasks), 'direct, offsite (through cr)')
  })
})
