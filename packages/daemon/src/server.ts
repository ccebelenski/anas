import type { CommandExecutor } from './executor/types.js'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { AuditLogger } from './audit/logger.js'
import { MockExecutor } from './executor/mock.js'
import { ProdExecutor } from './executor/prod.js'
import { mockFixtures } from './fixtures/loader.js'
import { JobQueue } from './jobs/queue.js'
import { LSBLK_ARGS } from './parsers/lsblk.js'
import { zfsListArgs, zfsSnapshotDetailArgs } from './parsers/zfs-list.js'
import { backupRoutes } from './routes/backup.js'
import { dashboardRoutes } from './routes/dashboard.js'
import { datasetRoutes } from './routes/datasets.js'
import { diskRoutes } from './routes/disks.js'
import { healthRoutes } from './routes/health.js'
import { jobRoutes } from './routes/jobs.js'
import { mountsRoutes } from './routes/mounts.js'
import { poolRoutes } from './routes/pools.js'
import { replicationRemotesRoutes } from './routes/replication-remotes.js'
import { replicationTaskRoutes } from './routes/replication-tasks.js'
import { shareIdentityRoutes } from './routes/share-identity.js'
import { nfsExportRoutes } from './routes/shares-nfs.js'
import { smbShareRoutes } from './routes/shares-smb.js'
import { ConfirmStore } from './safety/confirm.js'
import { defaultBackupReposPaths } from './services/backup-repos.js'
import { DiskIdentityCache } from './services/disk-identity-cache.js'
import { defaultRemotesPaths } from './services/replication-remotes.js'
import { createTransport, defaultMembersFile } from './services/replication-transport.js'

export interface ServerOptions {
  /** Use mock executor instead of real commands. Default: false. */
  mock?: boolean
  /** Enable request logging. Default: true. Disable in unit tests. */
  logger?: boolean
  /**
   * Path to smb.conf (config IS the API — Principle 13). Defaults to
   * $SMB_CONF_PATH, else a throwaway temp copy of the dev fixture in mock mode,
   * else /etc/samba/smb.conf.
   */
  smbConfPath?: string
}

export function createServer(opts?: ServerOptions) {
  const server = Fastify({
    logger: opts?.logger ?? true,
  })

  const audit = new AuditLogger(server.log)
  const jobQueue = new JobQueue({ audit })
  const executor: CommandExecutor = opts?.mock
    ? new MockExecutor()
    : new ProdExecutor()

  // /etc/exports location (Epic 7). Override via ANAS_EXPORTS_PATH — tests point
  // it at a temp file; dev mock (without the override) seeds a writable copy of
  // the fixture below so reads show sample data and writes never touch the host.
  const envExportsPath = process.env.ANAS_EXPORTS_PATH
  let exportsPath = envExportsPath ?? '/etc/exports'

  // systemd unit directory — the store for recurring replication TASKS (Epic
  // 5.5.3). The units ARE the config; override via ANAS_SYSTEMD_DIR (tests point
  // it at a temp dir).
  const systemdDir = process.env.ANAS_SYSTEMD_DIR ?? '/etc/systemd/system'

  // /etc/fstab location (Epic 18). Config IS the API — surgical round-trip edits.
  // Override via ANAS_FSTAB_PATH (tests point it at a temp file; dev mock seeds a
  // writable copy of the sample fstab below). Credentials live in ANAS_CREDS_DIR
  // (per-mount 0600 root-only files); dev mock uses a throwaway temp dir. PVE
  // storage.cfg is parsed READ-ONLY for hands-off tagging.
  const envFstabPath = process.env.ANAS_FSTAB_PATH
  let fstabPath = envFstabPath ?? '/etc/fstab'
  const credsDir = process.env.ANAS_CREDS_DIR
    ?? (opts?.mock ? join(tmpdir(), `anas-mock-creds-${process.pid}`) : '/etc/anas/creds')
  let mountsStoragePath = process.env.ANAS_STORAGE_CFG // undefined = /etc/pve/storage.cfg default

  // Stage-3 remote replication (Epic 5.5.2): the corosync-store paths (registry /
  // keypair / known_hosts, all env-overridable) and the SSH transport bound to
  // them + the cluster members file. The transport resolves peer/remote targets
  // and runs the remote-side zfs ops for plan/run.
  // In dev mock mode (no explicit env), keep the corosync-store off the real
  // /etc/pve so a stray ensureKeypair / registry write never touches the host.
  const remotesPaths = (opts?.mock && !process.env.ANAS_REMOTES_FILE)
    ? {
        registryFile: join(tmpdir(), `anas-mock-remotes-${process.pid}.json`),
        keyPath: join(tmpdir(), `anas-mock-replkey-${process.pid}`),
        knownHostsFile: join(tmpdir(), `anas-mock-known_hosts-${process.pid}`),
      }
    : defaultRemotesPaths()
  const membersFile = (opts?.mock && !process.env.ANAS_PVE_MEMBERS)
    ? join(tmpdir(), `anas-mock-members-${process.pid}.json`)
    : defaultMembersFile()
  const transport = createTransport(executor, { paths: remotesPaths, membersFile })

  // PBS backup repositories registry + per-repo secret files (Epic 16.2). Same
  // shape as the remotes store; in dev mock (no explicit env) keep the registry
  // and creds off the real /etc/pve and /etc/anas so a stray write never touches
  // the host.
  const backupReposPaths = (opts?.mock && !process.env.ANAS_BACKUP_REPOS_FILE)
    ? {
        registryFile: join(tmpdir(), `anas-mock-backup-repos-${process.pid}.json`),
        credsDir: join(tmpdir(), `anas-mock-backup-creds-${process.pid}`),
        // Tier-1 PVE repos: read-only. In mock, point at non-existent temp paths
        // so detection fail-opens to empty and never touches the host's /etc/pve.
        pveStorageCfg: join(tmpdir(), `anas-mock-storage-${process.pid}.cfg`),
        pvePrivStorageDir: join(tmpdir(), `anas-mock-priv-storage-${process.pid}`),
      }
    : defaultBackupReposPaths()

  // Register mock fixtures for dev mode
  if (opts?.mock) {
    const mock = executor as MockExecutor
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['list', '-j'], result: mockFixtures.zpoolList() })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: mockFixtures.zpoolStatus() })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['get', 'all', '-j'], result: mockFixtures.zpoolGetAll('testpool') })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['scrub', 'testpool'], result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['scrub', '-s', 'testpool'], result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: mockFixtures.lsblk() })
    mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
    mock.addFixture({ command: '/usr/sbin/smartctl', result: mockFixtures.smartctl() })
    // Identity + health call used by DiskIdentityCache (smartctl -iH)
    const wdIdentity = { model_family: 'Western Digital Black', model_name: 'WDC WD2003FZEX-00SRLA0', form_factor: { name: '3.5 inches' }, firmware_version: '81.00A81', sata_version: { string: 'SATA 3.1, 6.0 Gb/s' }, smart_status: { passed: true } }
    mock.addFixture({ command: '/usr/sbin/smartctl', args: ['-iH', '--json', '/dev/sda'], result: {
      stdout: JSON.stringify({ model_family: 'Samsung 870 EVO', model_name: 'Samsung SSD 870 EVO 250GB', form_factor: { name: '2.5 inches' }, firmware_version: 'SVT02B6Q', sata_version: { string: 'SATA 3.2, 6.0 Gb/s' }, trim: { supported: true }, smart_status: { passed: true } }),
      stderr: '',
      exitCode: 0,
    } })
    for (const dev of ['/dev/sdb', '/dev/sdc', '/dev/sdd', '/dev/sde', '/dev/sdf']) {
      mock.addFixture({ command: '/usr/sbin/smartctl', args: ['-iH', '--json', dev], result: {
        stdout: JSON.stringify(wdIdentity),
        stderr: '',
        exitCode: 0,
      } })
    }
    // zpool set <prop>=<value> testpool — pool property updates (story 3.9)
    for (const kv of ['autoexpand=on', 'autoexpand=off', 'autoreplace=on', 'autoreplace=off', 'autotrim=on', 'autotrim=off', 'failmode=wait', 'failmode=continue', 'failmode=panic']) {
      mock.addFixture({ command: '/usr/sbin/zpool', args: ['set', kv, 'testpool'], result: { stdout: '', stderr: '', exitCode: 0 } })
    }
    // Export / destroy (stories 3.13/3.14)
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['export', 'testpool'], result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['export', '-f', 'testpool'], result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['destroy', 'testpool'], result: { stdout: '', stderr: '', exitCode: 0 } })
    // Disk cleanup after destroy (story 3.14 cleanup option) — wipefs any device.
    mock.addFixture({ command: '/usr/sbin/wipefs', result: { stdout: '', stderr: '', exitCode: 0 } })
    // Import scan (story 3.7): `zpool import` with no args lists one pool.
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['import'], result: {
      stdout: [
        '   pool: oldtank',
        '     id: 9876543210987654321',
        '  state: ONLINE',
        ' action: The pool can be imported using its name or numeric identifier.',
        ' config:',
        '',
        '\toldtank     ONLINE',
        '\t  mirror-0  ONLINE',
        '\t    sdg     ONLINE',
        '\t    sdh     ONLINE',
        '',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    // Dynamic-arg mutations (create, import-by-name, add-vdev, attach/replace)
    // take disk/target args, so a command-only fallback lets them succeed in dev
    // mock. Exact fixtures above still take priority (MockExecutor: exact first).
    mock.addFixture({ command: '/usr/sbin/zpool', result: { stdout: '', stderr: '', exitCode: 0 } })

    // --- Epic 4: ZFS datasets --------------------------------------------
    // Reads need real JSON, so register them exactly (they take priority over
    // the command-only fallback below).
    mock.addFixture({ command: '/usr/sbin/zfs', args: zfsListArgs('testpool'), result: mockFixtures.zfsList() })
    mock.addFixture({ command: '/usr/sbin/zfs', args: ['get', '-j', 'all', 'testpool/media'], result: mockFixtures.zfsGetMedia() })
    mock.addFixture({ command: '/usr/sbin/zfs', args: ['get', '-j', 'all', 'testpool'], result: mockFixtures.zfsGetAll() })
    // Mountpoint stat for the media dataset's permissions.
    mock.addFixture({ command: '/usr/bin/stat', args: ['-c', '%U %G %a', '/testpool/media'], result: { stdout: 'root root 755\n', stderr: '', exitCode: 0 } })
    // --- Epic 5: snapshots — testpool/media has two (snap1 older, snap2 newer).
    // Reads need real JSON; snapshot/rename/rollback/destroy mutations succeed
    // via the command-only `/usr/sbin/zfs` fallback registered below.
    mock.addFixture({ command: '/usr/sbin/zfs', args: zfsSnapshotDetailArgs('testpool/media'), result: mockFixtures.zfsSnapshotsMedia() })
    // chown / chmod succeed for any target in dev mock.
    mock.addFixture({ command: '/usr/bin/chown', result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/chmod', result: { stdout: '', stderr: '', exitCode: 0 } })

    // --- Epic 4.7.2: layered access / POSIX ACLs -------------------------
    // Feature-detect: the acl package is present (getfacl/setfacl available).
    mock.addFixture({ command: '/usr/bin/getfacl', args: ['--version'], result: {
      stdout: 'getfacl 2.3.1\n',
      stderr: '',
      exitCode: 0,
    } })
    // testpool/media starts with acltype=off so the GET reports mode-only and a
    // named grant exercises the auto-enable path (zfs set acltype=posixacl).
    mock.addFixture({ command: '/usr/sbin/zfs', args: ['get', '-Hp', '-o', 'value', 'acltype', 'testpool/media'], result: {
      stdout: 'off\n',
      stderr: '',
      exitCode: 0,
    } })
    // A representative ACL for /testpool/media (used when acltype is posixacl):
    // owner rwx, owning-group r-x, everyone ---, one named user (alice rwx),
    // managed mask, and a matching default ACL for inheritance.
    const getfaclMedia = [
      'user::rwx',
      'user:alice:rwx',
      'group::r-x',
      'mask::rwx',
      'other::---',
      'default:user::rwx',
      'default:user:alice:rwx',
      'default:group::r-x',
      'default:mask::rwx',
      'default:other::---',
      '',
    ].join('\n')
    mock.addFixture({ command: '/usr/bin/getfacl', args: ['-pcE', '/testpool/media'], result: {
      stdout: getfaclMedia,
      stderr: '',
      exitCode: 0,
    } })
    // Raw variant (keeps the `# file:/owner:/group:` header) for the Advanced panel.
    mock.addFixture({ command: '/usr/bin/getfacl', args: ['-pE', '/testpool/media'], result: {
      stdout: [
        '# file: /testpool/media',
        '# owner: root',
        '# group: root',
        getfaclMedia,
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    // setfacl mutations (--set access, -d default, -b -k clear) succeed for any
    // target in dev mock; command-only fallback covers the dynamic specs.
    mock.addFixture({ command: '/usr/bin/setfacl', result: { stdout: '', stderr: '', exitCode: 0 } })
    // acltype read for other datasets falls through to the command-only zfs
    // fallback below (empty stdout → not posixacl), which is the correct default.
    // --- Epic 8: identity (getent-backed, source-agnostic via nsswitch) ---
    // Representative sample: root (0), a local SMB-enabled share user (media,
    // uid 1000), a filtered service account (backup-svc keeps uid 1001 so it
    // stays share-relevant; sub-1000 daemon/bin/www-data are filtered out), and
    // a group with members (smbusers). In dev mock every user/group is "local".
    const getentPasswd = [
      'root:x:0:0:root:/root:/bin/bash',
      'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
      'bin:x:2:2:bin:/bin:/usr/sbin/nologin',
      'www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin',
      'media:x:1000:1000:Media User:/home/media:/usr/sbin/nologin',
      'backup-svc:x:1001:1001::/home/backup-svc:/usr/sbin/nologin',
      '',
    ].join('\n')
    const getentGroup = [
      'root:x:0:',
      'daemon:x:1:',
      'users:x:100:',
      'media:x:1000:media',
      'smbusers:x:1001:media,backup-svc',
      '',
    ].join('\n')
    mock.addFixture({ command: '/usr/bin/getent', args: ['passwd'], result: { stdout: getentPasswd, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/getent', args: ['group'], result: { stdout: getentGroup, stderr: '', exitCode: 0 } })
    // `-s files` = only the LOCAL DB (marks a user/group manageable vs directory).
    mock.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd'], result: { stdout: getentPasswd, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'group'], result: { stdout: getentGroup, stderr: '', exitCode: 0 } })
    // getent shadow — expiry drives the `locked` flag; backup-svc is expired.
    mock.addFixture({ command: '/usr/bin/getent', args: ['shadow'], result: {
      stdout: [
        'root:!:19000:0:99999:7:::',
        'media:!:19000:0:99999:7:::',
        'backup-svc:!:19000:0:99999:7::1:',
        '',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    // pdbedit -L — which users have a Samba passdb entry (SMB-enabled). Only media.
    mock.addFixture({ command: '/usr/bin/pdbedit', args: ['-L'], result: {
      stdout: 'media:1000:Media User\n',
      stderr: '',
      exitCode: 0,
    } })
    // Single-name getent lookups used by the detail GET + mutation existence
    // checks. Command-only fallbacks below return exit 0 for any other name,
    // which the routes read as "resolves / is local" — fine for dev mutations.
    mock.addFixture({ command: '/usr/bin/getent', args: ['passwd', 'media'], result: { stdout: 'media:x:1000:1000:Media User:/home/media:/usr/sbin/nologin\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/getent', args: ['group', 'smbusers'], result: { stdout: 'smbusers:x:1001:media,backup-svc\n', stderr: '', exitCode: 0 } })
    // Identity mutations (useradd/usermod/groupadd/gpasswd/smbpasswd) — dynamic
    // args, so command-only fallbacks let dev-mode mutations succeed.
    mock.addFixture({ command: '/usr/sbin/useradd', result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/sbin/usermod', result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/sbin/groupadd', result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/gpasswd', result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/smbpasswd', result: { stdout: '', stderr: '', exitCode: 0 } })
    // Command-only getent fallback (exit 0, non-parseable stdout). Registered
    // AFTER the exact fixtures so those still win. It makes the LOCAL check
    // (`getent -s files <db> <name>`, which only tests exit 0) pass for the
    // sample users/groups, so their mutations don't 409-as-directory in dev. It
    // does NOT resolve as a valid passwd/group line, so `resolveUser`/`resolveGroup`
    // still return null for unknown names → the 404/409 paths behave correctly.
    mock.addFixture({ command: '/usr/bin/getent', result: { stdout: 'x\n', stderr: '', exitCode: 0 } })
    // Dynamic-arg zfs mutations (create/set/destroy) — command-only fallback,
    // taking effect only when no exact read fixture above matches.
    mock.addFixture({ command: '/usr/sbin/zfs', result: { stdout: '', stderr: '', exitCode: 0 } })

    // --- Epic 6: SMB shares ----------------------------------------------
    // smbstatus --json: one live connection to the [media] share.
    mock.addFixture({ command: '/usr/bin/smbstatus', args: ['--json'], result: {
      stdout: JSON.stringify({
        sessions: {
          3410950666: { username: 'media', remote_machine: '10.0.0.50', hostname: 'ipv4:10.0.0.50:49610' },
        },
        tcons: {
          3813605233: { service: 'media', session_id: '3410950666', machine: '10.0.0.50' },
        },
      }),
      stderr: '',
      exitCode: 0,
    } })
    // smbstatus -S text fallback (unused when --json is available).
    mock.addFixture({ command: '/usr/bin/smbstatus', args: ['-S'], result: { stdout: '', stderr: '', exitCode: 0 } })
    // systemctl reload smbd — config-change side effect.
    mock.addFixture({ command: '/usr/bin/systemctl', args: ['reload', 'smbd'], result: { stdout: '', stderr: '', exitCode: 0 } })

    // --- Epic 2: Dashboard -----------------------------------------------
    // Service-active probes for the share status panel (GET /v1/status).
    mock.addFixture({ command: '/usr/bin/systemctl', args: ['is-active', 'smbd'], result: { stdout: 'active\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/systemctl', args: ['is-active', 'nfs-server'], result: { stdout: 'active\n', stderr: '', exitCode: 0 } })
    // Live per-pool/disk I/O sample for GET /v1/telemetry (two-sample window).
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['iostat', '-plv', 'testpool', '1', '2'], result: mockFixtures.zpoolIostat() })

    // --- Epic 7: NFS exports ---------------------------------------------
    // `exportfs -ra` reloads the kernel export table after each mutation.
    mock.addFixture({ command: '/usr/sbin/exportfs', args: ['-ra'], result: { stdout: '', stderr: '', exitCode: 0 } })
    // Seed a writable temp /etc/exports from the fixture (unless overridden), so
    // dev reads real sample exports and writes never touch the host's file.
    if (!envExportsPath) {
      exportsPath = join(tmpdir(), `anas-mock-exports-${process.pid}`)
      try {
        writeFileSync(exportsPath, mockFixtures.nfsExportsText())
      }
      catch {
        // best-effort seed — readConfig tolerates a missing file (empty list)
      }
    }

    // --- Epic 18: Mounts -------------------------------------------------
    // Seed a writable temp /etc/fstab from the sample, point storage.cfg at the
    // read-only fixture, and register findmnt + mount lifecycle command mocks so
    // dev reads real sample mounts and writes never touch the host.
    const mountsFixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/mounts')
    if (!envFstabPath) {
      fstabPath = join(tmpdir(), `anas-mock-fstab-${process.pid}`)
      try {
        copyFileSync(join(mountsFixtures, 'fstab-anas-managed'), fstabPath)
      }
      catch { /* best-effort seed */ }
    }
    if (!mountsStoragePath) {
      try {
        // Only expose the fixture when the real PVE file is absent (dev host).
        mountsStoragePath = join(mountsFixtures, 'storage.cfg')
      }
      catch { /* leave undefined */ }
    }
    // findmnt --json → the full sample mount tree.
    try {
      mock.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: {
        stdout: readFileSync(join(mountsFixtures, 'findmnt-full.json'), 'utf8'),
        stderr: '',
        exitCode: 0,
      } })
    }
    catch { /* fixture missing — GET /mounts still fail-opens to fstab-only */ }
    // `timeout 2 stat -f` health probe — a healthy answer with capacity.
    mock.addFixture({ command: '/usr/bin/timeout', result: { stdout: '4096 8203953 6637110 6291265\n', stderr: '', exitCode: 0 } })
    // Mount lifecycle side effects (daemon-reload / mount / umount) succeed.
    mock.addFixture({ command: '/usr/bin/systemctl', args: ['daemon-reload'], result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/mount', result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/umount', result: { stdout: '', stderr: '', exitCode: 0 } })
    // lsof (busy-unmount holder list) — nothing holding by default.
    mock.addFixture({ command: '/usr/bin/lsof', result: { stdout: '', stderr: '', exitCode: 1 } })
  }

  const confirmStore = new ConfirmStore()

  // Resolve the smb.conf path: explicit option > env > (mock: throwaway temp
  // copy of the dev fixture so mock writes never clobber the repo) > default.
  const smbConfPath = opts?.smbConfPath
    ?? process.env.SMB_CONF_PATH
    ?? (opts?.mock ? createMockSmbConf() : '/etc/samba/smb.conf')

  server.register(healthRoutes, { prefix: '/v1' })
  server.register(jobRoutes, { prefix: '/v1', jobQueue })
  server.register(poolRoutes, { prefix: '/v1', executor, jobQueue, confirmStore })
  // datasetRoutes also reads the share configs to report associated shares
  // (Epic 4.4) and warn on destroy — same paths the share routes edit.
  server.register(datasetRoutes, { prefix: '/v1', executor, jobQueue, confirmStore, smbConfPath, exportsPath, transport })
  server.register(smbShareRoutes, { prefix: '/v1', executor, jobQueue, confirmStore, smbConfPath })
  server.register(nfsExportRoutes, { prefix: '/v1', executor, jobQueue, confirmStore, exportsPath })
  server.register(shareIdentityRoutes, { prefix: '/v1', executor, jobQueue, confirmStore })
  // Recurring replication tasks (Epic 5.5.3) — units-as-store CRUD + status.
  server.register(replicationTaskRoutes, { prefix: '/v1', executor, jobQueue, systemdDir, transport })
  // Stage-3 remotes registry (Epic 5.5.2) — corosync-store CRUD + diagnostics.
  server.register(replicationRemotesRoutes, { prefix: '/v1', executor, jobQueue, paths: remotesPaths, transport, systemdDir })
  // PBS file backup (Epic 16) — repositories registry (CAS + creds + test) and
  // the systemd units-as-store task CRUD + LOCAL-ONLY status + Run-Now.
  server.register(backupRoutes, { prefix: '/v1', executor, jobQueue, paths: backupReposPaths, systemdDir })
  // Mounts (Epic 18) — external & local storage. fstab round-trip + findmnt
  // inventory + PVE-tagged hands-off + guarded status probe.
  server.register(mountsRoutes, { prefix: '/v1', executor, jobQueue, confirmStore, fstabPath, credsDir, storagePath: mountsStoragePath })
  const diskIdentityCache = new DiskIdentityCache(executor)
  server.register(diskRoutes, { prefix: '/v1', executor, diskIdentityCache })
  // Dashboard aggregate + live telemetry (Epic 2). Read-only; composes the pool,
  // disk, share, and job sources above, plus on-demand ARC/iostat/net sampling.
  server.register(dashboardRoutes, { prefix: '/v1', executor, jobQueue, diskIdentityCache, smbConfPath, exportsPath, systemdDir, fstabPath, storagePath: mountsStoragePath })

  server.decorate('jobQueue', jobQueue)
  server.decorate('executor', executor)

  return server
}

/**
 * Copy the dev smb.conf fixture to a throwaway temp file and return its path.
 * Mock-mode share mutations then edit this copy (surgical, atomic) instead of a
 * real system file or the repo fixture.
 */
function createMockSmbConf(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const fixture = join(here, 'fixtures/samba/smb.conf')
  const dest = join(tmpdir(), `anas-mock-smb-${process.pid}.conf`)
  copyFileSync(fixture, dest)
  return dest
}
