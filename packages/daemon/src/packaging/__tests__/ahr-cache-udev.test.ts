/**
 * The SHIPPED AHR read-cache removal hook, pinned (story ahrcache.1 slice 2,
 * AHR-DESIGN §13 "Resolved 2026-09-24").
 *
 * Two files the daemon's own tests can never reach — a udev rule and a POSIX
 * shell script — and between them they are the whole difference between a dead
 * cache device repairing itself in the same second and a pool that returns EIO
 * on every read until a human finds a button (GT-19: dm-cache does NOT fall
 * through to the origin). So this file reads what the release tarball actually
 * carries and asserts the properties that must not drift, on the
 * `iscsi-ordering-dropin.test.ts` precedent.
 *
 * What is being protected:
 *
 *  1. The rule matches ONLY a `<pool>-cacheN` GPT partition name on a REMOVE,
 *     and it does so with a literal udev pattern — there is no interpolation
 *     anywhere in it, and no pool name is compiled into it.
 *  2. It can NEVER match an AHR band member slice (`<pool>-dN-bM`). A pulled
 *     pool disk is mdadm's event, and it reaches ANAS through anas-md-event;
 *     routing it into the cache recovery rung would run `lvconvert --uncache`
 *     over a pool whose cache is fine.
 *  3. The script decides nothing and destroys nothing: it posts a report to
 *     the daemon over the root-only socket and exits 0 whatever happens. The
 *     verdict is the daemon's `dmsetup status` read, because that is the ONE
 *     honest health signal (`lvs` counters go stale, not absent — GT-23).
 *  4. install.sh installs both and removes both on rollback; uninstall.sh
 *     removes both and nothing else in /etc/udev/rules.d; make-release.sh puts
 *     both in the tarball and install.sh's preflight refuses a release without
 *     them.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packagingDir = join(__dirname, '../../../../../packaging')

const rules = readFileSync(join(packagingDir, 'anas-cache.rules'), 'utf-8')
const hook = readFileSync(join(packagingDir, 'anas-cache-event.sh'), 'utf-8')
const installSh = readFileSync(join(packagingDir, 'install.sh'), 'utf-8')
const uninstallSh = readFileSync(join(packagingDir, 'uninstall.sh'), 'utf-8')
const makeRelease = readFileSync(join(packagingDir, 'make-release.sh'), 'utf-8')

/** The rule file's actual rules — comments and blank lines dropped. */
function ruleLines(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'))
}

/**
 * udev's match patterns are shell-style globs (`*`, `?`, `[]`), the same
 * dialect `fnmatch(3)` implements. This is a faithful-enough evaluator for the
 * three constructs the shipped rule uses, so the test can ask the question that
 * matters — "does this rule fire for THIS label?" — instead of asserting the
 * pattern's spelling and hoping.
 */
function udevGlobMatches(pattern: string, value: string): boolean {
  let re = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      re += '.*'
    }
    else if (c === '?') {
      re += '.'
    }
    else if (c === '[') {
      const close = pattern.indexOf(']', i + 1)
      assert.ok(close > i, `unterminated [ in udev pattern ${pattern}`)
      re += `[${pattern.slice(i + 1, close)}]`
      i = close
    }
    else {
      re += c.replace(/[.+^${}()|\\]/g, '\\$&')
    }
  }

  return new RegExp(`${re}$`).test(value)
}

/** Every `ENV{ID_PART_ENTRY_NAME}=="…"` pattern the shipped rule file carries. */
function labelPatterns(): string[] {
  return ruleLines(rules).map((line) => {
    const m = line.match(/ENV\{ID_PART_ENTRY_NAME\}=="([^"]*)"/)
    assert.ok(m, `every rule must match on ID_PART_ENTRY_NAME: ${line}`)
    return m![1]
  })
}

/** Would ANY shipped rule fire for this GPT partition name? */
function ruleFiresFor(label: string): boolean {
  return labelPatterns().some(p => udevGlobMatches(p, label))
}

describe('the AHR cache-removal udev rule (ahrcache.1 slice 2)', () => {
  it('fires on REMOVE of a block PARTITION, and on nothing else', () => {
    const lines = ruleLines(rules)
    assert.ok(lines.length > 0, 'the rule file must carry at least one rule')
    for (const line of lines) {
      assert.match(line, /ACTION=="remove"/, line)
      assert.match(line, /SUBSYSTEM=="block"/, line)
      assert.match(line, /ENV\{DEVTYPE\}=="partition"/, line)
      // An `add` rung would arm the recovery on a disk coming BACK, which is
      // the attach path's business (it re-wipes the outdated PV label).
      assert.ok(!line.includes('ACTION=="add"'), line)
      assert.ok(!line.includes('ACTION=="change"'), line)
    }
  })

  it('is a literal udev pattern — no shell interpolation anywhere in the file', () => {
    // A rule is read by udev, not by a shell. `$var`, backticks and `$(…)`
    // would be taken literally at best; at worst they would be a pool name
    // compiled into a pattern, which is the trap `matchCachePartitionLabel`
    // avoids on the TypeScript side (prefix-then-tail, never an interpolated
    // regex). The only `%` escapes allowed are udev's own substitutions.
    for (const line of ruleLines(rules)) {
      assert.ok(!line.includes('`'), `no backticks in a udev rule: ${line}`)
      assert.ok(!line.includes('$('), `no command substitution in a udev rule: ${line}`)
      assert.ok(!line.includes('${'), `no shell parameter expansion in a udev rule: ${line}`)
      for (const esc of line.match(/%./g) ?? [])
        assert.ok(['%E', '%k'].includes(esc), `unexpected udev substitution ${esc} in: ${line}`)
    }
  })

  it('matches the cache slice labels the attach step actually writes', () => {
    // `cachePartitionLabel(pool, n)` = `<pool>-cache<n>`, 1-based in attach
    // order. One slice per cache disk is the rule (GT-21), so single digits are
    // the real world — two digits are covered because a pattern that stops at
    // nine would silently stop protecting an eleven-disk cache.
    for (const label of ['gtcache-cache1', 'tank-cache1', 'tank-cache2', 'a-cache9', 'big-cache10'])
      assert.ok(ruleFiresFor(label), `the rule must fire for ${label}`)
  })

  it('NEVER matches an AHR band member slice — those are mdadm\'s event', () => {
    // `matchPartitionLabel` shape: `<pool>-d<disk>-b<band>`. Routing one of
    // these into the cache rung would run the cache recovery over a pool whose
    // cache is healthy (or absent) because a POOL DISK was pulled.
    for (const label of ['tank-d1-b1', 'tank-d12-b3', 'gtcache-d2-b1'])
      assert.ok(!ruleFiresFor(label), `the rule must NOT fire for band member ${label}`)
  })

  it('NEVER matches a foreign or empty partition name', () => {
    for (const label of ['', 'cache1', 'EFI System Partition', 'primary', 'tank-cache', 'tank-cacheX'])
      assert.ok(!ruleFiresFor(label), `the rule must NOT fire for ${JSON.stringify(label)}`)
  })

  it('runs the installed hook, passing the label and the kernel name', () => {
    for (const line of ruleLines(rules)) {
      assert.match(line, /RUN\+="\/usr\/local\/bin\/anas-cache-event %E\{ID_PART_ENTRY_NAME\} %k"/, line)
      // `+=`, never `=`: an assignment would DROP every RUN another rule on
      // this node had already queued for the same event (guest philosophy).
      assert.ok(!/RUN="/.test(line), `RUN must be appended, never assigned: ${line}`)
    }
  })
})

describe('the AHR cache-event hook script (ahrcache.1 slice 2)', () => {
  it('is POSIX sh and exits 0 on every path but a usage error', () => {
    assert.match(hook, /^#!\/bin\/sh\n/)
    // A udev RUN that fails is noise in the event loop and changes nothing —
    // the anas-md-event posture, for the same reason.
    assert.match(hook, /exit 64/)
    assert.match(hook, /exit 0/)
  })

  it('runs NO storage command — the daemon owns every mutation', () => {
    // The whole safety story of an unattended repair is that ONE code path
    // performs it, behind ONE guard (`vgreduce --removemissing` would drop a
    // stopped band array's PV as readily as a dead cache device's — GT-19).
    // A shell script reaching for lvconvert would be a second path with none.
    for (const forbidden of ['lvconvert', 'vgreduce', 'pvremove', 'sgdisk', 'wipefs', 'mount ', 'umount'])
      assert.ok(!hook.includes(forbidden), `the hook must not run ${forbidden.trim()}`)
  })

  it('posts to the daemon over the root-only socket with identity headers', () => {
    // The socket IS the trust boundary (Principle 9): /run/anas/anasd.sock is
    // 0600 root, so a caller that reaches the handler is local root and the
    // X-Anas-* headers are trusted because of that.
    assert.match(hook, /--unix-socket "\$SOCKET"/)
    assert.match(hook, /ANASD_SOCKET:-\/run\/anas\/anasd\.sock/)
    assert.match(hook, /x-anas-user: system:udev-cache-event/)
    assert.match(hook, /x-anas-user-uid: 0/)
    assert.match(hook, /x-anas-request-id/)
    assert.match(hook, /\/v1\/ahr\/\$\{POOL\}\/cache\/event/)
  })

  it('derives the pool from the label and refuses anything that is not ours', () => {
    // Second door behind the udev pattern: `${LABEL%-cache*}`, guarded by the
    // same `*-cache<digits>` shape, so a band slice that somehow arrived here
    // still stops.
    assert.match(hook, /\*-cache\[0-9\] \| \*-cache\[0-9\]\[0-9\]\)/)
    assert.match(hook, /POOL="\$\{LABEL%-cache\*\}"/)
    assert.match(hook, /REASON=not-an-anas-cache-slice/)
  })

  it('says where the repair goes when the daemon is not there', () => {
    // A missed event costs a DELAYED repair, never a lost one: the boot rung
    // runs the same recovery at the next daemon start. The journal has to say
    // so, or the absence reads as a silent failure.
    assert.match(hook, /daemon-socket-absent/)
    assert.ok((hook.match(/recovered-at-next-daemon-start/g) ?? []).length >= 2)
  })

  it('logs to journald under the AHR tag, key=value', () => {
    assert.match(hook, /TAG="anas-ahr"/)
    assert.match(hook, /EVENT=CacheDeviceRemoved POOL=\$\{POOL\} SLICE=\$\{LABEL\}/)
  })
})

describe('packaging wires the cache hook in and back out', () => {
  it('ships both files in the release tarball', () => {
    assert.match(makeRelease, /anas-cache-event\.sh" +"\$\{REL_ROOT\}\/anas-cache-event\.sh"/)
    assert.match(makeRelease, /anas-cache\.rules" +"\$\{REL_ROOT\}\/anas-cache\.rules"/)
  })

  it('install.sh refuses a release that is missing either half', () => {
    assert.match(installSh, /release incomplete: anas-cache-event\.sh \/ anas-cache\.rules/)
  })

  it('install.sh installs the hook executable and the rule world-readable', () => {
    assert.match(installSh, /install -m 0755 "\$\{SCRIPT_DIR\}\/anas-cache-event\.sh" "\$\{CACHE_HOOK_DEST\}"/)
    assert.match(installSh, /install -m 0644 "\$\{SCRIPT_DIR\}\/anas-cache\.rules" "\$\{CACHE_RULE_DEST\}"/)
    assert.match(installSh, /udevadm control --reload-rules/)
    // Both destinations are overridable, so the installer can be exercised
    // against a temp tree rather than the node's own /etc/udev.
    assert.match(installSh, /CACHE_HOOK_DEST="\$\{CACHE_HOOK_DEST:-\/usr\/local\/bin\/anas-cache-event\}"/)
    assert.match(installSh, /CACHE_RULE_DEST="\$\{CACHE_RULE_DEST:-\$\{UDEV_RULES_DIR\}\/99-anas-cache\.rules\}"/)
  })

  it('install.sh rollback withdraws only what THIS run created', () => {
    assert.match(installSh, /CACHE_HOOK_INSTALLED=0/)
    assert.match(installSh, /CACHE_RULE_INSTALLED=0/)
    assert.match(installSh, /\[ "\$\{CACHE_HOOK_INSTALLED\}" -eq 1 \] \|\| \[ "\$\{CACHE_RULE_INSTALLED\}" -eq 1 \]/)
  })

  it('uninstall.sh removes ANAS\'s own rule file and nothing else in that dir', () => {
    assert.match(uninstallSh, /rm -f "\$\{CACHE_RULE_DEST\}"/)
    assert.match(uninstallSh, /rm -f "\$\{CACHE_HOOK_DEST\}"/)
    // A wildcard sweep of /etc/udev/rules.d would take other software's rules
    // with it. The directory is a shared drop-in dir; we own our own file.
    assert.ok(!/rm -f "\$\{UDEV_RULES_DIR\}\/\*/.test(uninstallSh))
    assert.ok(!/rm -rf "\$\{UDEV_RULES_DIR\}/.test(uninstallSh))
  })
})
