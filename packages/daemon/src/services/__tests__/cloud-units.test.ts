import type { CloudSyncTask, TaskCadence } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { BACKUP_SKIP_EXIT_CODE, CloudSyncTask as CloudSyncTaskSchema } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { BACKUP_UNIT_KIND } from '../backup-units.js'
import {
  buildCloudWarnings,
  CLOUD_UNIT_KIND,
  collectCloudWarnings,
  effectiveSchedule,
  parseServiceUnit,
  readAllTasks,
  readTask,
  removeTaskUnits,
  renderServiceUnit,
  renderTimerUnit,
  runnerArgs,
  serviceUnitName,
  superviseRun,
  taskFileExists,
  tasksReferencingRemote,
  timerUnitName,
  writeTaskUnits,
} from '../cloud-units.js'
import { withStampDir } from './stamp-dir.js'

/**
 * The cloud sync unit store (rclone.2) — what is genuinely THIS store's: the
 * unit text it renders, the CloudSyncTask it parses back, and the store verbs.
 * The systemd/journald machinery under it is proven once in task-units.test.ts
 * against this very descriptor.
 */

const SYSTEMCTL = '/usr/bin/systemctl'
const JOURNALCTL = '/usr/bin/journalctl'

const TASK: CloudSyncTask = CloudSyncTaskSchema.parse({
  name: 'offsite',
  source: '/tank/pictures',
  remote: 'backblaze',
  path: 'pve1/pictures',
  mode: 'copy',
  excludes: ['*.tmp', 'Cache/**'],
  bwlimit: '8M',
  schedule: 'Tue *-*-* 02:00:00',
})

function task(over: Partial<CloudSyncTask> = {}): CloudSyncTask {
  return CloudSyncTaskSchema.parse({ ...TASK, ...over })
}

function ok(stdout = ''): { stdout: string, stderr: string, exitCode: number } {
  return { stdout, stderr: '', exitCode: 0 }
}

/** A mock that answers every systemctl call with success. */
function systemctlMock(): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: SYSTEMCTL, result: ok('') })
  return mock
}

describe('cloud sync units (rclone.2)', () => {
  describe('the descriptor', () => {
    it('names the anas-cloud prefix, the cloud warning category and the cloud runner', () => {
      assert.deepEqual(
        {
          prefix: CLOUD_UNIT_KIND.prefix,
          warningCategory: CLOUD_UNIT_KIND.warningCategory,
          runnerScript: CLOUD_UNIT_KIND.runnerScript,
          label: CLOUD_UNIT_KIND.label,
        },
        {
          prefix: 'anas-cloud-',
          warningCategory: 'cloud',
          runnerScript: '/opt/anas/packages/daemon/dist/cloud-task.js',
          label: 'cloud sync',
        },
      )
    })

    it('its prefix is DISJOINT from backup\'s, in both directions', () => {
      // The store reads itself by listing `<prefix>*.service`; an overlap would
      // make each store adopt — and then rewrite — the other's units.
      assert.ok(!CLOUD_UNIT_KIND.prefix.startsWith(BACKUP_UNIT_KIND.prefix))
      assert.ok(!BACKUP_UNIT_KIND.prefix.startsWith(CLOUD_UNIT_KIND.prefix))
    })

    it('unit names are anas-cloud-<name>.service / .timer', () => {
      assert.equal(serviceUnitName('offsite'), 'anas-cloud-offsite.service')
      assert.equal(timerUnitName('offsite'), 'anas-cloud-offsite.timer')
    })
  })

  describe('rendering', () => {
    it('the service embeds the canonical JSON, the skip code and the runner argv', () => {
      const unit = renderServiceUnit(TASK)
      assert.match(unit, /^\[Unit\]\nDescription=ANAS cloud sync task offsite\n/)
      assert.match(unit, /^# X-ANAS-Task=\{.*\}$/m)
      assert.match(unit, /^Type=oneshot$/m)
      assert.match(unit, new RegExp(`^SuccessExitStatus=${BACKUP_SKIP_EXIT_CODE}$`, 'm'))
      assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/anas\/packages\/daemon\/dist\/cloud-task\.js --name offsite$/m)
      // pbc's fd knob is backup's problem, not every task kind's.
      assert.ok(!unit.includes('LimitNOFILE'))
    })

    it('runnerArgs is just the task name', () => {
      assert.deepEqual(runnerArgs(TASK), ['--name', 'offsite'])
    })

    it('the timer carries the schedule and Persistent=true', () => {
      const timer = renderTimerUnit(TASK)
      assert.match(timer, /^OnCalendar=Tue \*-\*-\* 02:00:00$/m)
      assert.match(timer, /^Persistent=true$/m)
      assert.match(timer, /^WantedBy=timers\.target$/m)
    })

    it('a cadence GENERATES the timer expression, overriding the stored schedule', () => {
      const cadence: TaskCadence = { kind: 'weekly', days: ['Thu', 'Tue'], time: '03:30' }
      const t = task({ cadence, schedule: 'Mon *-*-* 09:00:00' })
      // Days come back in ISO order — the cadence normalises on the way in.
      assert.equal(effectiveSchedule(t), 'Tue,Thu 03:30')
      assert.match(renderTimerUnit(t), /^OnCalendar=Tue,Thu 03:30$/m)
    })

    it('a biweekly cadence still generates a WEEKLY expression (the gate skips off weeks)', () => {
      const cadence: TaskCadence = { kind: 'biweekly', days: ['Tue'], time: '02:00', parity: 'even' }
      assert.equal(effectiveSchedule(task({ cadence })), 'Tue 02:00')
    })
  })

  describe('parse (the marker is the only source of truth)', () => {
    it('round-trips every field of a task through the unit text', () => {
      const parsed = parseServiceUnit(renderServiceUnit(TASK))
      assert.deepEqual(parsed, TASK)
    })

    it('round-trips a cadence task, an empty remote path and no bandwidth limit', () => {
      const t = CloudSyncTaskSchema.parse({
        name: 'offsite',
        source: '/tank/pictures',
        remote: 'backblaze',
        path: '',
        mode: 'sync',
        enabled: false,
        schedule: 'Sun *-*-01..07 04:00',
        cadence: { kind: 'monthly', days: ['Sun'], time: '04:00' },
      })
      assert.equal(t.bwlimit, undefined, 'an absent limit stays absent')
      assert.deepEqual(parseServiceUnit(renderServiceUnit(t)), t)
    })

    it('returns null without the marker, and on JSON that is not a valid task', () => {
      assert.equal(parseServiceUnit('[Unit]\nDescription=something else\n'), null)
      assert.equal(parseServiceUnit('# X-ANAS-Task={"name":"x"}\n'), null, 'missing required fields')
      assert.equal(parseServiceUnit('# X-ANAS-Task={not json}\n'), null)
    })

    it('never adopts a BACKUP unit: its JSON is not a CloudSyncTask', () => {
      const backupUnit = '# X-ANAS-Task={"name":"nightly","repository":"pbs","backupId":"host",'
        + '"archives":[{"name":"etc","path":"/etc","excludes":[]}],"changeDetectionMode":"default",'
        + '"notify":"always","schedule":"daily","enabled":true,"limitNofile":1024}\n'
      assert.equal(parseServiceUnit(backupUnit), null)
    })
  })

  describe('the store is the files', () => {
    it('write → read → remove, and the timer is enabled to match', async () => {
      // The removal deletes systemd's Persistent stamp — the stamp dir MUST be
      // pointed at a scratch dir first, or the unlink reaches the real
      // /var/lib/systemd/timers (review D1: this test omitted the override).
      await withStampDir(async (stampDir) => {
        const dir = await mkdtemp(join(tmpdir(), 'anas-cloudunits-'))
        try {
          const mock = systemctlMock()
          await writeTaskUnits(mock, dir, TASK)
          await writeFile(join(stampDir, `stamp-${timerUnitName('offsite')}`), '')
          // Another task's stamp — one removal must not reach past its own name.
          await writeFile(join(stampDir, 'stamp-anas-cloud-other.timer'), '')

          assert.equal(await taskFileExists(dir, 'offsite'), true)
          assert.deepEqual(await readTask(dir, 'offsite'), TASK)
          assert.deepEqual(await readAllTasks(dir), [TASK])

          const argv = mock.calls.filter(c => c.command === SYSTEMCTL).map(c => c.args.join(' '))
          assert.deepEqual(argv, ['daemon-reload', 'enable --now anas-cloud-offsite.timer'])

          await removeTaskUnits(mock, dir, 'offsite')
          assert.deepEqual(await readdir(dir), [])
          assert.equal(await taskFileExists(dir, 'offsite'), false)
          assert.equal(await readTask(dir, 'offsite'), null)
          assert.deepEqual(await readdir(stampDir), ['stamp-anas-cloud-other.timer'])
          // The reset-failed goes out per unit (review R2), exits ignored.
          const after = mock.calls.filter(c => c.command === SYSTEMCTL).map(c => c.args.join(' '))
          assert.ok(after.includes(`reset-failed ${serviceUnitName('offsite')}`))
          assert.ok(after.includes(`reset-failed ${timerUnitName('offsite')}`))
          assert.ok(after.includes('daemon-reload'))
        }
        finally {
          await rm(dir, { recursive: true, force: true })
        }
      })
    })

    it('a DISABLED task disables its timer instead of enabling it', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'anas-cloudunits-'))
      try {
        const mock = systemctlMock()
        await writeTaskUnits(mock, dir, task({ enabled: false }))
        const argv = mock.calls.filter(c => c.command === SYSTEMCTL).map(c => c.args.join(' '))
        assert.deepEqual(argv, ['daemon-reload', 'disable --now anas-cloud-offsite.timer'])
      }
      finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('reads only anas-cloud-*.service, and skips an unparseable one fail-open', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'anas-cloudunits-'))
      try {
        await writeFile(join(dir, 'anas-cloud-offsite.service'), renderServiceUnit(TASK), 'utf-8')
        await writeFile(join(dir, 'anas-cloud-broken.service'), '[Unit]\nDescription=no marker\n', 'utf-8')
        await writeFile(join(dir, 'anas-backup-nightly.service'), '# X-ANAS-Task={"name":"nightly"}\n', 'utf-8')
        await writeFile(join(dir, 'unrelated.service'), 'x', 'utf-8')
        assert.deepEqual((await readAllTasks(dir)).map(t => t.name), ['offsite'])
      }
      finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('an unreadable unit dir is an EMPTY store, not an error', async () => {
      assert.deepEqual(await readAllTasks('/nonexistent/systemd'), [])
    })
  })

  describe('tasksReferencingRemote (the remotes DELETE refusal)', () => {
    it('names every task pointing at the remote, sorted; none for an unused one', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'anas-cloudunits-'))
      try {
        const mock = systemctlMock()
        await writeTaskUnits(mock, dir, task({ name: 'zeta', remote: 'backblaze' }))
        await writeTaskUnits(mock, dir, task({ name: 'alpha', remote: 'backblaze' }))
        await writeTaskUnits(mock, dir, task({ name: 'other', remote: 'wasabi' }))
        assert.deepEqual(await tasksReferencingRemote(dir, 'backblaze'), ['alpha', 'zeta'])
        assert.deepEqual(await tasksReferencingRemote(dir, 'wasabi'), ['other'])
        assert.deepEqual(await tasksReferencingRemote(dir, 'nobody-uses-this'), [])
      }
      finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  describe('dashboard warnings', () => {
    it('an enabled failing task warns in the cloud category and names the Cloud Sync view', () => {
      const warnings = buildCloudWarnings([{ name: 'offsite', enabled: true, lastRunResult: 'failure', overdue: false }])
      assert.equal(warnings.length, 1)
      assert.equal(warnings[0].category, 'cloud')
      assert.equal(warnings[0].ref, 'offsite')
      assert.match(warnings[0].message, /^Cloud sync task 'offsite' last run failed — check the Cloud Sync view$/)
    })

    it('an overdue enabled task warns; disabled and healthy ones do not', () => {
      assert.equal(buildCloudWarnings([{ name: 'a', enabled: true, lastRunResult: 'success', overdue: true }]).length, 1)
      assert.equal(buildCloudWarnings([{ name: 'a', enabled: false, lastRunResult: 'failure', overdue: true }]).length, 0)
      assert.equal(buildCloudWarnings([{ name: 'a', enabled: true, lastRunResult: 'success', overdue: false }]).length, 0)
      assert.equal(buildCloudWarnings([{ name: 'a', enabled: true, lastRunResult: 'skipped', overdue: false }]).length, 0)
    })

    it('collectCloudWarnings reads the real store and fails open', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'anas-cloudunits-'))
      try {
        const write = systemctlMock()
        await writeTaskUnits(write, dir, TASK)
        const mock = new MockExecutor()
        mock.addFixture({
          command: SYSTEMCTL,
          args: ['show', 'anas-cloud-offsite.service', '-p', 'ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,InactiveEnterTimestamp'],
          result: ok('ActiveState=failed\nResult=exit-code\nExecMainStatus=7\nExecMainExitTimestamp=\nInactiveEnterTimestamp=\n'),
        })
        mock.addFixture({ command: SYSTEMCTL, result: ok('') })
        const warnings = await collectCloudWarnings(mock, dir)
        assert.equal(warnings.length, 1)
        assert.equal(warnings[0].category, 'cloud')
        // No store at all → no warnings, never an exception.
        assert.deepEqual(await collectCloudWarnings(mock, '/nonexistent/systemd'), [])
      }
      finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  describe('superviseRun mapping', () => {
    const FAST = { pollIntervalMs: 0, timeoutMs: 100, sleep: async () => {}, now: () => Date.now() }

    it('carries rclone\'s counters back from the runner\'s journal result', async () => {
      const service = 'anas-cloud-offsite.service'
      const mock = new MockExecutor()
      mock.addFixture({
        command: SYSTEMCTL,
        args: ['show', service, '-p', 'ActiveState,Result,ExecMainStatus,InvocationID'],
        results: [
          ok('ActiveState=inactive\nResult=success\nInvocationID=OLD\n'),
          ok('ActiveState=activating\nResult=success\nInvocationID=NEW\n'),
          ok('ActiveState=inactive\nResult=success\nExecMainStatus=0\nInvocationID=NEW\n'),
        ],
      })
      mock.addFixture({ command: SYSTEMCTL, args: ['start', '--no-block', service], result: ok('') })
      mock.addFixture({
        command: JOURNALCTL,
        args: ['-u', service, '-n', '200', '-o', 'short-iso', '--no-pager'],
        result: ok('2026-09-24T02:00:07+0000 pve1 anas-cloud-offsite[999]: '
          + '{"task":"offsite","result":{"status":"success","mode":"copy","bytes":4096,"transfers":3,"errors":0}}'),
      })
      const run = await superviseRun(mock, 'offsite', FAST)
      assert.equal(run.status, 'success')
      assert.equal(run.alreadyRunning, false)
      assert.deepEqual(
        { bytes: run.run?.bytes, transfers: run.run?.transfers, mode: run.run?.mode },
        { bytes: 4096, transfers: 3, mode: 'copy' },
      )
    })

    it('a failed run throws rclone\'s own line, not systemd\'s trailer', async () => {
      const service = 'anas-cloud-offsite.service'
      const mock = new MockExecutor()
      mock.addFixture({
        command: SYSTEMCTL,
        args: ['show', service, '-p', 'ActiveState,Result,ExecMainStatus,InvocationID'],
        results: [
          ok('ActiveState=inactive\nResult=success\nInvocationID=OLD\n'),
          ok('ActiveState=failed\nResult=exit-code\nExecMainStatus=1\nInvocationID=NEW\n'),
        ],
      })
      mock.addFixture({ command: SYSTEMCTL, args: ['start', '--no-block', service], result: ok('') })
      mock.addFixture({
        command: JOURNALCTL,
        args: ['-u', service, '-n', '200', '-o', 'short-iso', '--no-pager'],
        result: ok([
          '2026-09-24T02:00:01+0000 pve1 anas-cloud-offsite[9]: Failed to create file system for "backblaze:": '
          + 'NewFs: couldn\'t connect SSH: ssh: handshake failed',
          '2026-09-24T02:00:02+0000 pve1 systemd[1]: anas-cloud-offsite.service: Failed with result \'exit-code\'.',
        ].join('\n')),
      })
      await assert.rejects(superviseRun(mock, 'offsite', FAST), /Failed to create file system/)
    })
  })
})
