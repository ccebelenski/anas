import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AbsolutePath,
  CreateMountRequest,
  CreateNfsExportRequest,
  CreateSmbShareRequest,
  DatasetPath,
  MountCredentials,
  MountEntry,
  MountMode,
  MountRequestOptions,
  MountTestRequest,
  MountVers,
  ReplicatePlanRequest,
  ReplicateRequest,
  ReplicationRemote,
  ReplicationTask,
  UpdateSmbGlobalConfigRequest,
} from '@anas/shared'

/**
 * Security hardening (command / config injection cluster). Every field that
 * flows verbatim into a config file (fstab, smb.conf, /etc/exports, a systemd
 * unit) or a shell-reachable argv (`ssh <peer> zfs …`) must REJECT control
 * characters and shell metacharacters while PRESERVING every legitimate value.
 * Each case asserts BOTH directions: a realistic legit value passes; the audit's
 * injection payload fails.
 */

// The control-character injection payloads the audit flagged.
const NL = '\n'
const CR = '\r'
const TAB = '\t'
const NUL = '\0'

describe('AbsolutePath — control characters rejected, spaces/punctuation kept', () => {
  it('accepts legitimate paths including spaces and punctuation', () => {
    for (const p of ['/mnt/data', '/mnt/My Data', '/srv/nfs/export-1', '/tank/Bob\'s files', '/mnt/a.b_c']) {
      assert.equal(AbsolutePath.safeParse(p).success, true, `should accept ${JSON.stringify(p)}`)
    }
  })
  it('rejects the smb.conf line-injection payload and every control char', () => {
    assert.equal(AbsolutePath.safeParse(`/srv/x${NL}${TAB}root preexec=/bin/sh -c id`).success, false)
    assert.equal(AbsolutePath.safeParse(`/srv/x${CR}foo`).success, false)
    assert.equal(AbsolutePath.safeParse(`/srv/x${TAB}foo`).success, false)
    assert.equal(AbsolutePath.safeParse(`/srv/x${NUL}foo`).success, false)
  })
})

describe('DatasetPath — legal ZFS names widened, injection rejected', () => {
  it('accepts real-world ZFS dataset names (incl. new legal chars . and :)', () => {
    for (const d of ['media/movies', 'tank/vm-100-disk-0', 'pool/data.backup', 'rpool/nfs:share', '_boot/root', 'a/b/c']) {
      assert.equal(DatasetPath.safeParse(d).success, true, `should accept ${JSON.stringify(d)}`)
    }
  })
  it('is a superset of the OLD regex for every legitimate old-style name', () => {
    const OLD = /^[\w-]+(?:\/[\w-]+)*$/
    // Names that the old regex accepted AND begin with an alphanumeric/underscore
    // (i.e. every real ZFS name — ZFS forbids a leading hyphen anyway).
    const oldStyle = ['media', 'media/movies', 'a_b', 'a-b', 'A1/B2', 'x/y/z', '_hidden', '0leading']
    for (const d of oldStyle) {
      assert.equal(OLD.test(d), true, `fixture ${JSON.stringify(d)} must be old-valid`)
      assert.equal(DatasetPath.safeParse(d).success, true, `widened regex must still accept ${JSON.stringify(d)}`)
    }
  })
  it('rejects shell-metacharacter and control-char injection', () => {
    for (const d of ['x; touch /tmp/p', 'a/b$(id)', 'a b', `a${NL}b`, 'a/../b', '-rf', './evil']) {
      assert.equal(DatasetPath.safeParse(d).success, false, `should reject ${JSON.stringify(d)}`)
    }
  })
})

describe('Replication dataset fields — DatasetPath applied, pool-root "" preserved', () => {
  it('source.dataset "" (pool root) stays valid; a real name is accepted', () => {
    assert.equal(ReplicationTask.safeParse({
      name: 'nightly',
      source: { pool: 'tank', dataset: '' },
      target: { pool: 'backup' },
      schedule: 'daily',
    }).success, true)
    assert.equal(ReplicationTask.safeParse({
      name: 'nightly',
      source: { pool: 'tank', dataset: 'vm-100-disk-0' },
      target: { pool: 'backup' },
      schedule: 'daily',
    }).success, true)
  })
  it('rejects an RCE payload in source.dataset (→ ssh <peer> zfs recv)', () => {
    assert.equal(ReplicationTask.safeParse({
      name: 'nightly',
      source: { pool: 'tank', dataset: 'x; touch /tmp/pwn' },
      target: { pool: 'backup' },
      schedule: 'daily',
    }).success, false)
    assert.equal(ReplicationTask.safeParse({
      name: 'nightly',
      source: { pool: 'tank', dataset: `x${NL}ExecStart=/bin/sh` },
      target: { pool: 'backup' },
      schedule: 'daily',
    }).success, false)
  })
  it('target.dataset accepts "" and a real name, rejects injection', () => {
    assert.equal(ReplicateRequest.safeParse({ target: { pool: 'backup', dataset: '' } }).success, true)
    assert.equal(ReplicateRequest.safeParse({ target: { pool: 'backup', dataset: 'archive/2026' } }).success, true)
    assert.equal(ReplicateRequest.safeParse({ target: { pool: 'backup', dataset: 'x; rm -rf /' } }).success, false)
  })
})

describe('SMB fields — comment / validUsers / hostsAllow / hostsDeny single-line', () => {
  it('accepts a realistic share with an apostrophe comment and normal ACLs', () => {
    assert.equal(CreateSmbShareRequest.safeParse({
      name: 'media',
      path: '/mnt/media',
      comment: 'Bob\'s share',
      validUsers: ['bob', '@staff'],
      hostsAllow: ['10.0.0.0/24', '192.168.1.5'],
      hostsDeny: ['badhost'],
    }).success, true)
  })
  it('rejects a newline (smb.conf param injection, incl. `root preexec`)', () => {
    assert.equal(CreateSmbShareRequest.safeParse({ name: 'm', path: '/mnt/m', comment: `ok${NL}root preexec = id` }).success, false)
    assert.equal(CreateSmbShareRequest.safeParse({ name: 'm', path: '/mnt/m', validUsers: [`bob${NL}root preexec=id`] }).success, false)
    assert.equal(CreateSmbShareRequest.safeParse({ name: 'm', path: '/mnt/m', hostsAllow: [`10.0.0.0/24${NL}guest ok=yes`] }).success, false)
  })
})

describe('NFS fields — spec / options single-line', () => {
  it('accepts realistic client specs and option lists', () => {
    assert.equal(CreateNfsExportRequest.safeParse({
      path: '/srv/nfs/export1',
      clients: [{ spec: '10.0.0.0/24', options: ['rw', 'sync', 'no_subtree_check', 'root_squash'] }, { spec: '*', options: [] }],
    }).success, true)
  })
  it('rejects a newline in a client spec or option (/etc/exports line injection)', () => {
    assert.equal(CreateNfsExportRequest.safeParse({ path: '/srv/x', clients: [{ spec: `10.0.0.0/24${NL}/etc *(rw)`, options: [] }] }).success, false)
    assert.equal(CreateNfsExportRequest.safeParse({ path: '/srv/x', clients: [{ spec: '*', options: [`rw${NL}/etc *(rw)`] }] }).success, false)
  })
})

describe('Mount vers / spec / server — numeric vers, single-line spec', () => {
  it('accepts realistic version tokens (incl. the documented CIFS "default")', () => {
    for (const v of ['4.2', '3.1.1', '3', '1.0', 'default']) {
      assert.equal(MountVers.safeParse(v).success, true, `should accept ${v}`)
    }
  })
  it('rejects the comma option-injection version payload and other non-numeric words', () => {
    // `default` is the ONLY non-numeric word admitted; everything else — comma
    // injection, whitespace, control chars, other words — stays rejected.
    for (const v of ['4.2,exec', '3.1.1,suid', `4.2${NL}`, 'default,exec', 'defaults', 'auto', '4 2', ' default']) {
      assert.equal(MountVers.safeParse(v).success, false, `should reject ${JSON.stringify(v)}`)
    }
  })
  it('MountTestRequest.vers is numeric-only; server rejects control chars', () => {
    assert.equal(MountTestRequest.safeParse({ type: 'nfs', server: 'nas.local', vers: '4.2' }).success, true)
    assert.equal(MountTestRequest.safeParse({ type: 'nfs', server: 'nas.local', vers: '4.2,exec' }).success, false)
    assert.equal(MountTestRequest.safeParse({ type: 'cifs', server: `nas${NL}evil` }).success, false)
  })
  it('MountEntry.spec accepts a real cifs/nfs spec, rejects a newline', () => {
    assert.equal(MountEntry.safeParse({ spec: '//10.0.0.1/share', mountpoint: '/mnt/s', fstype: 'cifs', options: { common: baseCommon(), passthrough: '' }, dump: 0, pass: 0 }).success, true)
    assert.equal(MountEntry.safeParse({ spec: `//10.0.0.1/share${NL}UUID=x /etc/cron.d`, mountpoint: '/mnt/s', fstype: 'cifs', options: { common: baseCommon(), passthrough: '' }, dump: 0, pass: 0 }).success, false)
  })
  it('CreateMountRequest.server / remotePath reject control chars', () => {
    assert.equal(CreateMountRequest.safeParse({ type: 'nfs', server: 'nas.local', remotePath: '/export/data', mountpoint: '/mnt/x' }).success, true)
    assert.equal(CreateMountRequest.safeParse({ type: 'nfs', server: `nas${NL}0.0.0.0`, mountpoint: '/mnt/x' }).success, false)
    assert.equal(CreateMountRequest.safeParse({ type: 'nfs', server: 'nas', remotePath: `/e${NL}x`, mountpoint: '/mnt/x' }).success, false)
  })
})

describe('ReplicationRemote.host — single-line (known_hosts / ssh argv)', () => {
  it('accepts hostnames and IPs, rejects a newline', () => {
    assert.equal(ReplicationRemote.safeParse({ name: 'nas', host: 'nas.example.com' }).success, true)
    assert.equal(ReplicationRemote.safeParse({ name: 'nas', host: '10.0.0.9' }).success, true)
    assert.equal(ReplicationRemote.safeParse({ name: 'nas', host: `10.0.0.9${NL}evil.example.com ssh-rsa AAAA` }).success, false)
  })
})

// ---- Extended class: adjacent verbatim-to-config / argv fields --------------

describe('SMB global — workgroup / serverString / interfaces single-line', () => {
  it('accepts realistic global settings (spaces and %v macro included)', () => {
    assert.equal(UpdateSmbGlobalConfigRequest.safeParse({
      workgroup: 'WORKGROUP',
      serverString: 'ANAS NAS %v',
      interfaces: ['eth0', '10.0.0.5', '192.168.1.0/24'],
    }).success, true)
  })
  it('rejects a newline (forges another [global] parameter)', () => {
    assert.equal(UpdateSmbGlobalConfigRequest.safeParse({ workgroup: `WG${NL}guest ok = yes` }).success, false)
    assert.equal(UpdateSmbGlobalConfigRequest.safeParse({ serverString: `srv${NL}root preexec = id` }).success, false)
    assert.equal(UpdateSmbGlobalConfigRequest.safeParse({ interfaces: [`eth0${NL}bind interfaces only = no`] }).success, false)
  })
})

describe('CIFS options — domain single-line, file/dir mode octal', () => {
  it('MountMode accepts 3–4 octal digits, rejects comma-injection / non-octal', () => {
    for (const m of ['755', '0644', '0777', '700']) {
      assert.equal(MountMode.safeParse(m).success, true, `should accept ${m}`)
    }
    for (const m of ['0644,exec', '755;id', '888', `755${NL}`, '75', '0o644']) {
      assert.equal(MountMode.safeParse(m).success, false, `should reject ${JSON.stringify(m)}`)
    }
  })
  it('MountRequestOptions: legit domain/modes pass, injection fails', () => {
    assert.equal(MountRequestOptions.safeParse({ domain: 'CORP', fileMode: '0644', dirMode: '0755' }).success, true)
    assert.equal(MountRequestOptions.safeParse({ domain: `CORP${NL}injected=1` }).success, false)
    assert.equal(MountRequestOptions.safeParse({ fileMode: '0644,exec' }).success, false)
    assert.equal(MountRequestOptions.safeParse({ dirMode: '0755,suid' }).success, false)
  })
})

describe('CIFS credentials — written verbatim into a 0600 creds file', () => {
  it('accepts a normal credential with a symbol-rich password', () => {
    assert.equal(MountCredentials.safeParse({ username: 'svc-backup', password: 'p@ss w0rd!#$%', domain: 'CORP' }).success, true)
  })
  it('rejects a newline in username / password / domain (creds-line injection)', () => {
    assert.equal(MountCredentials.safeParse({ username: `u${NL}password=leak`, password: 'x' }).success, false)
    assert.equal(MountCredentials.safeParse({ username: 'u', password: `x${NL}username=root` }).success, false)
    assert.equal(MountCredentials.safeParse({ username: 'u', password: 'x', domain: `d${NL}password=leak` }).success, false)
  })
})

describe('Replication snapshot / location.name — safe ZFS/argv charsets', () => {
  it('snapshot fields accept a real ZFS snapshot name, reject argv injection', () => {
    assert.equal(ReplicatePlanRequest.safeParse({ target: { pool: 'backup' }, snapshot: 'auto-2026-07-20_03:00:00' }).success, true)
    assert.equal(ReplicateRequest.safeParse({ target: { pool: 'backup' }, snapshot: 'repl-base' }).success, true)
    assert.equal(ReplicateRequest.safeParse({ target: { pool: 'backup' }, snapshot: 'snap; rm -rf /' }).success, false)
    assert.equal(ReplicateRequest.safeParse({ target: { pool: 'backup' }, snapshot: 'x@evil' }).success, false)
    assert.equal(ReplicateRequest.safeParse({ target: { pool: 'backup' }, snapshot: `s${NL}x` }).success, false)
  })
  it('location.name accepts a nodename, rejects control chars', () => {
    assert.equal(ReplicateRequest.safeParse({ target: { pool: 'backup', location: { kind: 'peer', name: 'pve-node2' } } }).success, true)
    assert.equal(ReplicateRequest.safeParse({ target: { pool: 'backup', location: { kind: 'peer', name: `node2${NL}root@evil` } } }).success, false)
  })
})

/** A neutral MountCommonOptions bundle for MountEntry construction. */
function baseCommon(): Record<string, unknown> {
  return { readOnly: false, nofail: true, noauto: false, automount: false, noatime: false, nosuid: false, nodev: false, netdev: false }
}
