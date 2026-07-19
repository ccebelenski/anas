import type { BackupRepo } from '@anas/shared'
import type { BackupReposPaths } from '../backup-repos.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  BackupReposConflictError,
  isPveRepoName,
  pbsDefToRepo,
  pveRepoName,
  pveSecretPath,
  pveSecretSet,
  pveStorageId,
  readBackupRepos,
  readPveSecret,
  readRepoSecret,
  removeRepoSecret,
  repoSecretPath,
  repoSecretSet,
  writeBackupRepos,
  writeRepoSecret,
} from '../backup-repos.js'

function makeRepo(over: Partial<BackupRepo> = {}): BackupRepo {
  return {
    name: 'pbs-main',
    host: 'pbs.example.com',
    port: 8007,
    datastore: 'store1',
    authType: 'token',
    tokenId: 'root@pam!anas',
    fingerprint: 'cc:b8:a0',
    ...over,
  }
}

describe('backup repos registry — CAS store (Epic 16.2, remotes pattern)', () => {
  let dir: string
  let paths: BackupReposPaths

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-backup-repos-'))
    paths = {
      registryFile: join(dir, 'backup-repos.json'),
      credsDir: join(dir, 'creds'),
      pveStorageCfg: join(dir, 'storage.cfg'),
      pvePrivStorageDir: join(dir, 'priv-storage'),
    }
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('an absent registry reads as the empty registry (version 0)', async () => {
    const reg = await readBackupRepos(paths)
    assert.equal(reg.version, 0)
    assert.deepEqual(reg.repos, [])
  })

  it('an empty file reads as the empty registry', async () => {
    await writeFile(paths.registryFile, '   \n')
    const reg = await readBackupRepos(paths)
    assert.equal(reg.version, 0)
  })

  it('write bumps the version and round-trips the repos', async () => {
    const written = await writeBackupRepos(paths, 0, [makeRepo()])
    assert.equal(written.version, 1)
    const reg = await readBackupRepos(paths)
    assert.equal(reg.version, 1)
    assert.deepEqual(reg.repos, [makeRepo()])
    assert.ok(reg.updatedAt)
  })

  it('a stale expectedVersion throws BackupReposConflictError (CAS)', async () => {
    await writeBackupRepos(paths, 0, [makeRepo()]) // now at v1
    await assert.rejects(
      () => writeBackupRepos(paths, 0, [makeRepo({ name: 'other' })]),
      (err: unknown) => err instanceof BackupReposConflictError && err.currentVersion === 1,
    )
  })

  it('CAS catches a concurrent writer via the beforeRead hook', async () => {
    // Another CLUSTER NODE writes the registry file directly (no shared
    // in-process lock) between our read (v0) and our CAS re-read.
    const sneaky = {
      version: 1,
      updatedBy: 'other-node',
      updatedAt: new Date().toISOString(),
      repos: [makeRepo({ name: 'sneaky' })],
    }
    await assert.rejects(
      () => writeBackupRepos(paths, 0, [makeRepo()], {
        beforeRead: async () => { await writeFile(paths.registryFile, JSON.stringify(sneaky)) },
      }),
      (err: unknown) => err instanceof BackupReposConflictError && err.currentVersion === 1,
    )
    // The other node's write stands (version 1); ours was rejected.
    const reg = await readBackupRepos(paths)
    assert.equal(reg.version, 1)
    assert.equal(reg.repos[0].name, 'sneaky')
  })

  it('a present-but-invalid registry throws (never silently discarded)', async () => {
    await writeFile(paths.registryFile, JSON.stringify({ version: 'nope', repos: [] }))
    await assert.rejects(() => readBackupRepos(paths), /invalid/)
  })
})

describe('backup repos — per-repo secret files (0600 root-only)', () => {
  let dir: string
  let credsDir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-backup-creds-'))
    credsDir = join(dir, 'creds')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writeRepoSecret creates a 0600 file in a 0700 dir with the raw secret', async () => {
    const path = await writeRepoSecret(credsDir, 'pbs-main', 'super-secret-value')
    assert.equal(path, repoSecretPath(credsDir, 'pbs-main'))
    const fileStat = await stat(path)
    assert.equal(fileStat.mode & 0o777, 0o600)
    const dirStat = await stat(credsDir)
    assert.equal(dirStat.mode & 0o777, 0o700)
    // Read back verbatim (no key=value framing — the file IS the secret).
    assert.equal(await readRepoSecret(credsDir, 'pbs-main'), 'super-secret-value')
  })

  it('repoSecretSet reflects presence; removeRepoSecret deletes it', async () => {
    assert.equal(await repoSecretSet(credsDir, 'pbs-main'), false)
    await writeRepoSecret(credsDir, 'pbs-main', 's')
    assert.equal(await repoSecretSet(credsDir, 'pbs-main'), true)
    await removeRepoSecret(credsDir, 'pbs-main')
    assert.equal(await repoSecretSet(credsDir, 'pbs-main'), false)
    assert.equal(await readRepoSecret(credsDir, 'pbs-main'), null)
  })

  it('removeRepoSecret on a missing file is a no-op (best-effort)', async () => {
    await removeRepoSecret(credsDir, 'does-not-exist')
  })
})

describe('backup repos — tier-1 PVE-defined (Epic 16.8)', () => {
  it('pveRepoName / isPveRepoName / pveStorageId round-trip on the reserved namespace', () => {
    assert.equal(pveRepoName('anastest-pw'), 'pve:anastest-pw')
    assert.equal(isPveRepoName('pve:anastest-pw'), true)
    assert.equal(isPveRepoName('pbs-main'), false)
    assert.equal(pveStorageId('pve:anastest-pw'), 'anastest-pw')
  })

  it('pbsDefToRepo infers PASSWORD auth from a plain username (no ! suffix)', () => {
    const repo = pbsDefToRepo({
      id: 'anastest-pw',
      server: '127.0.0.1',
      datastore: 'anastest-store',
      username: 'root@pam',
      fingerprint: 'cc:b8:a0',
      namespace: 'anastest',
    })
    assert.equal(repo.name, 'pve:anastest-pw')
    assert.equal(repo.host, '127.0.0.1')
    assert.equal(repo.port, 8007) // default applied when the stanza omits port
    assert.equal(repo.authType, 'password')
    assert.equal(repo.username, 'root@pam')
    assert.equal(repo.tokenId, undefined)
    assert.equal(repo.namespace, 'anastest')
    assert.equal(repo.fingerprint, 'cc:b8:a0')
  })

  it('pbsDefToRepo infers TOKEN auth from a !tokenname username and carries the port', () => {
    const repo = pbsDefToRepo({
      id: 'anastest-tok',
      server: 'pbs.example.com',
      port: 8123,
      datastore: 'store1',
      username: 'root@pam!anas-test',
    })
    assert.equal(repo.authType, 'token')
    assert.equal(repo.tokenId, 'root@pam!anas-test')
    assert.equal(repo.username, undefined)
    assert.equal(repo.port, 8123)
  })

  it('readPveSecret reads the .pw file and strips the single trailing newline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-pve-priv-'))
    try {
      // Ground truth (16.8): PVE writes the bare secret + one trailing "\n".
      await writeFile(pveSecretPath(dir, 'anastest-pw'), 'AnasPbsTest123\n')
      assert.equal(await readPveSecret(dir, 'anastest-pw'), 'AnasPbsTest123')
      assert.equal(await pveSecretSet(dir, 'anastest-pw'), true)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('readPveSecret returns null for a missing .pw file; pveSecretSet is false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-pve-priv-'))
    try {
      assert.equal(await readPveSecret(dir, 'nope'), null)
      assert.equal(await pveSecretSet(dir, 'nope'), false)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
