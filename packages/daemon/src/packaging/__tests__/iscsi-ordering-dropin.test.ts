/**
 * The SHIPPED iSCSI packaging assets, pinned (story `iscsi.5`).
 *
 * These are the two halves of "targets survive a reboot correctly", and neither
 * is reachable from a unit test of the daemon: they are a systemd drop-in and
 * two shell scripts. So this file reads the files the release tarball actually
 * carries and asserts the directives and the rules that must not drift —
 * following the `src/ui/__tests__` precedent of a test-only directory that pins
 * an asset living outside this package, so it rides in CI with everything else.
 *
 * What is being protected:
 *
 *  1. The drop-in orders the LIO restore after the ZFS volume links exist. The
 *     vendor unit's own ordering stops at `local-fs.target`, and NOTHING in that
 *     chain waits for `/dev/zvol/*` — while a restore whose backing device is
 *     missing exits 0 and is logged `Result=success` (GT-3/GT-20/GT-21).
 *  2. It is a DROP-IN, not an edit of the vendor unit (guest philosophy), and it
 *     uses `Wants=` rather than `Requires=` so a node with no ZFS still restores
 *     whatever LIO config it has.
 *  3. The uninstall removes the drop-in and NOTHING else about iSCSI — never the
 *     packages, never `saveconfig.json`. That file is the node's iSCSI
 *     configuration including every LUN's unit serial, which is the identity
 *     initiators, ESXi, Windows and PVE volids key on. It is data.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packagingDir = join(__dirname, '../../../../../packaging')

const DROPIN_PATH = join(packagingDir, 'systemd/rtslib-fb-targetctl.service.d/anas-ordering.conf')
const dropin = readFileSync(DROPIN_PATH, 'utf-8')
const installSh = readFileSync(join(packagingDir, 'install.sh'), 'utf-8')
const uninstallSh = readFileSync(join(packagingDir, 'uninstall.sh'), 'utf-8')
const makeRelease = readFileSync(join(packagingDir, 'make-release.sh'), 'utf-8')

/** The drop-in's directive lines, comments and blanks stripped. */
function directives(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'))
}

describe('the rtslib-fb-targetctl ordering drop-in (iscsi.5)', () => {
  it('is a [Unit] section and nothing else — it must not redefine the service', () => {
    const lines = directives(dropin)
    assert.equal(lines[0], '[Unit]')
    assert.equal(lines.filter(l => l.startsWith('[')).length, 1, `sections: ${lines.filter(l => l.startsWith('['))}`)
    // No ExecStart/ExecStop: the vendor unit owns what the service DOES.
    assert.ok(!lines.some(l => l.startsWith('Exec')), 'a drop-in must not redefine ExecStart/ExecStop')
  })

  it('orders after the ZFS volume anchors — the ones that wait for /dev/zvol/*', () => {
    const after = directives(dropin)
      .filter(l => l.startsWith('After='))
      .flatMap(l => l.slice('After='.length).split(/\s+/))
    // zfs-volume-wait.service runs `zvol_wait`; zfs-volumes.target requires it.
    assert.ok(after.includes('zfs-volume-wait.service'), `After=: ${after.join(' ')}`)
    assert.ok(after.includes('zfs-volumes.target'), `After=: ${after.join(' ')}`)
    // A fileio LUN's image lives on a mounted dataset.
    assert.ok(after.includes('zfs-mount.service'), `After=: ${after.join(' ')}`)
    // Covers zfs-import-cache AND the per-pool zfs-import@<pool>.service ANAS's
    // own zfs-import-unit.ts enables (issue #22).
    assert.ok(after.includes('zfs-import.target'), `After=: ${after.join(' ')}`)
    // The AHR half: an AHR pool is an ordinary fstab mount of its btrfs LV.
    assert.ok(after.includes('local-fs.target'), `After=: ${after.join(' ')}`)
  })

  it('pulls the ZFS anchors in with Wants=, never Requires= (fail-open)', () => {
    const lines = directives(dropin)
    const wants = lines.filter(l => l.startsWith('Wants=')).flatMap(l => l.slice('Wants='.length).split(/\s+/))
    assert.ok(wants.includes('zfs-volume-wait.service'), `Wants=: ${wants.join(' ')}`)
    assert.ok(wants.includes('zfs-volumes.target'), `Wants=: ${wants.join(' ')}`)
    // A node with no ZFS, or a failed zvol_wait, must still restore whatever LIO
    // config it has — never "no iSCSI at all".
    assert.ok(!lines.some(l => l.startsWith('Requires=')), 'Requires= would make a ZFS failure fatal to iSCSI')
  })

  it('states that After= is also stop-before, which is the shutdown half', () => {
    // No separate Before= is needed: systemd stops a unit before the units it is
    // ordered after, so `ExecStop=targetctl clear` runs before the pools go
    // away — which is what keeps a shutdown export off `dataset is busy`.
    assert.match(dropin, /stop BEFORE/i)
    assert.ok(!directives(dropin).some(l => l.startsWith('Before=')), 'the shutdown half comes from After=, not a Before=')
  })

  it('records the honest AHR limit rather than implying an anchor it does not have', () => {
    // AHR mounts are `nofail`, and systemd deliberately does not order a
    // `nofail` mount before local-fs.target. There is no per-node-invariant
    // "AHR is mounted" unit, and pretending otherwise would be worse than
    // saying so.
    assert.match(dropin, /nofail/)
    assert.match(dropin, /health\/repair|iscsi\/health/)
  })
})

describe('install.sh ships and installs the drop-in and the two packages', () => {
  it('preflights targetcli-fb AND python3-rtslib-fb, the same way it does samba', () => {
    assert.match(installSh, /NEED_TARGETCLI_INSTALL=0/)
    // Both halves are probed: the CLI and the python module that owns the
    // restore service.
    assert.match(installSh, /command -v targetcli/)
    assert.match(installSh, /import rtslib_fb/)
    assert.match(installSh, /targetcli-fb\/python3-rtslib-fb missing — will auto-install/)
  })

  it('installs them with apt and refuses to continue if that fails', () => {
    assert.match(installSh, /apt-get install -y targetcli-fb python3-rtslib-fb/)
    assert.match(installSh, /hard dependency, not optional/)
    assert.match(installSh, /Nothing on this node was modified/)
  })

  it('does NOT enable or start rtslib-fb-targetctl — the postinst already did', () => {
    assert.match(installSh, /python3-rtslib-fb enables and starts rtslib-fb-targetctl\.service itself/)
    assert.ok(
      !/systemctl (?:enable|start|restart)[^\n]*rtslib-fb-targetctl/.test(installSh),
      'install.sh must never enable/start/restart the vendor restore service',
    )
  })

  it('lays the drop-in down idempotently and reloads systemd', () => {
    assert.match(installSh, /ISCSI_DROPIN_DIR="rtslib-fb-targetctl\.service\.d"/)
    assert.match(installSh, /ISCSI_DROPIN_FILE="anas-ordering\.conf"/)
    assert.match(installSh, /install_iscsi_dropin\(\) \{/)
    // Called from install_units, which Phase 1 follows with a daemon-reload —
    // so a re-run (upgrade) re-applies the current content.
    assert.match(installSh, /install_units\(\) \{[\s\S]*?install_iscsi_dropin\n\}/)
    assert.match(installSh, /install_units\n {2}info "installed iSCSI ordering drop-in[\s\S]*?systemctl daemon-reload/)
  })

  it('fails preflight when the release does not carry the drop-in', () => {
    assert.match(installSh, /release incomplete: systemd\/\$\{ISCSI_DROPIN_DIR\}\/\$\{ISCSI_DROPIN_FILE\}/)
  })

  it('make-release.sh copies it into the tarball', () => {
    assert.match(makeRelease, /systemd\/rtslib-fb-targetctl\.service\.d\/anas-ordering\.conf/)
  })
})

describe('uninstall.sh removes the drop-in and NOTHING else about iSCSI', () => {
  it('removes the drop-in, and the directory only when it is empty', () => {
    assert.match(uninstallSh, /rm -f "\$\{SYSTEMD_DIR\}\/\$\{ISCSI_DROPIN_DIR\}\/\$\{ISCSI_DROPIN_FILE\}"/)
    assert.match(uninstallSh, /rmdir "\$\{SYSTEMD_DIR\}\/\$\{ISCSI_DROPIN_DIR\}"/)
  })

  it('never removes the packages', () => {
    assert.ok(!/apt-get\s+(?:remove|purge)/.test(uninstallSh), 'uninstall must never remove a dependency package')
    assert.ok(!/\bpurge\b/.test(uninstallSh))
  })

  it('never touches saveconfig.json, its backups, or the live LIO tree', () => {
    // The file IS the node's iSCSI configuration — every target, every LUN, and
    // every LUN's unit serial. Deleting it would silently change the identity of
    // every disk this node serves.
    assert.ok(!/rm[^\n]*rtslib-fb-target/.test(uninstallSh))
    assert.ok(!/saveconfig\.json[^\n]*rm|rm[^\n]*saveconfig/.test(uninstallSh))
    // No invocation of the LIO tools at all — the mention of the package names
    // in the explanatory `info` line is the only occurrence allowed.
    // No INVOCATION of the LIO tools — `rtslib-fb-targetctl.service.d` and the
    // explanatory comments naming the packages are the only occurrences allowed.
    assert.ok(!/^\s*targetc(?:li|tl)\s/m.test(uninstallSh), 'uninstall must not drive targetcli/targetctl')
    assert.ok(!/kernel\/config\/target/.test(uninstallSh))
    // …and it says so, so the next reader does not "tidy up".
    assert.match(uninstallSh, /saveconfig\.json/)
    assert.match(uninstallSh, /It is data, and it stays\./)
  })
})
