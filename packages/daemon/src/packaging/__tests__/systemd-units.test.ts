/**
 * The SHIPPED gateway unit, pinned (operator-approved rider "Gateway follows
 * the daemon", 2026-09-25).
 *
 * `anas.service` is a pure forwarding gateway: every request it serves is
 * proxied to the daemon over the root-only socket, so its lifecycle only has
 * meaning through the daemon's. `Requires=`/`After=` give start-ordering and
 * a stop when the daemon stops, but a bare `systemctl restart anasd` only
 * STOPPED the gateway — nothing restarted it, and the only symptom was the
 * 502 the pveproxy ANAS hook returned (a boot was unaffected). Found by the
 * ahrcache.1 live proof (AHR-DESIGN §13 live-proof paragraph). `PartOf=` is
 * the fix: a daemon restart then reaches the gateway as a gateway restart.
 *
 * As for the udev-rule and drop-in pins, this file reads what the release
 * tarball actually carries — install.sh copies the unit verbatim apart from
 * the PREFIX substitution, which never touches the [Unit] section — and
 * asserts the directives that must not drift.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packagingDir = join(__dirname, '../../../../../packaging')

const anasService = readFileSync(join(packagingDir, 'systemd/anas.service'), 'utf-8')

/** The directive lines of one section, comments and blanks stripped. */
function section(text: string, name: string): string[] {
  let inSection = false
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inSection = line === `[${name}]`
      continue
    }
    if (inSection && line.length > 0 && !line.startsWith('#')) {
      lines.push(line)
    }
  }
  return lines
}

describe('the anas.service gateway unit (gateway follows the daemon)', () => {
  it('carries Requires=, After= AND PartOf= on the daemon in the [Unit] section', () => {
    const unit = section(anasService, 'Unit')
    assert.ok(unit.length > 0, 'the unit file must carry a [Unit] section')
    for (const directive of ['Requires=anasd.service', 'After=anasd.service', 'PartOf=anasd.service']) {
      assert.ok(unit.includes(directive), `the [Unit] section must carry ${directive}`)
    }
    // PartOf is what makes a daemon RESTART reach the gateway (Requires alone
    // only stops it); one line, no duplicates.
    assert.equal(unit.filter(l => l.startsWith('PartOf=')).length, 1, `PartOf lines: ${unit.filter(l => l.startsWith('PartOf='))}`)
  })
})
