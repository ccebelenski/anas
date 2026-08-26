import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import {
  dportCoversPort,
  optionsEnable,
  parseFirewallStatus,
  PVE_FIREWALL,
  readPveFirewallAdvisory,
  ruleAdmitsPort,
  rulesSection,
} from '../pve-firewall.js'

/**
 * The PVE-firewall advisory — story `iscsi.6`.
 *
 * A portal can bind, listen in `ss -lntp`, and be counted healthy by every ANAS
 * screen while `pve-firewall` silently drops every SYN to 3260. LIO will not say
 * so — it will not even admit a portal's ADDRESS is gone (GT-24) — so ANAS reads
 * the firewall and says one line. It NEVER writes a rule: PVE territory is
 * read-only (§2 standing ruling).
 *
 * Provenance: `Status: disabled/running` is the REAL capture from the stunt node
 * (`fixtures/iscsi/pve-firewall-status-disabled.txt`, exit 0, and its
 * `/etc/pve/firewall/` was an empty directory). The node's firewall was never
 * enabled — GT open question 5 — so the ENABLED cases below are driven from
 * `.fw` files this test writes into a temp dir. They are SYNTHETIC, they are
 * modelled on PVE's documented `.fw` grammar, and they owe a live proof in
 * `iscsi.7`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const REAL_STATUS_DISABLED = readFileSync(
  join(__dirname, '../../fixtures/iscsi/pve-firewall-status-disabled.txt'),
  'utf-8',
)

describe('pve-firewall — parsing', () => {
  describe('parseFirewallStatus', () => {
    it('reads the REAL disabled capture', () => {
      assert.equal(parseFirewallStatus(REAL_STATUS_DISABLED), false)
    })

    it('reads the enabled form', () => {
      assert.equal(parseFirewallStatus('Status: enabled/running\n'), true)
    })

    it('null on anything it does not recognise — never a guess', () => {
      assert.equal(parseFirewallStatus(''), null)
      assert.equal(parseFirewallStatus('bash: pve-firewall: command not found\n'), null)
      assert.equal(parseFirewallStatus('Status: weird/running\n'), null)
    })
  })

  describe('dportCoversPort', () => {
    it('matches a single port, a list, and a range', () => {
      assert.equal(dportCoversPort('3260', 3260), true)
      assert.equal(dportCoversPort('22,3260,8006', 3260), true)
      assert.equal(dportCoversPort('3200:3300', 3260), true)
    })

    it('does not match a neighbouring port or a range that misses', () => {
      assert.equal(dportCoversPort('3261', 3260), false)
      assert.equal(dportCoversPort('3261:3300', 3260), false)
    })

    it('never matches a service NAME — guessing would produce a false "you are fine"', () => {
      assert.equal(dportCoversPort('ssh', 3260), false)
    })
  })

  describe('ruleAdmitsPort', () => {
    it('accepts an IN ACCEPT tcp rule naming the port', () => {
      assert.equal(ruleAdmitsPort('IN ACCEPT -p tcp -dport 3260', 3260), true)
      assert.equal(ruleAdmitsPort('IN ACCEPT -proto tcp --dport 3260 -log nolog', 3260), true)
    })

    it('accepts an unrestricted IN ACCEPT (no -dport admits everything)', () => {
      assert.equal(ruleAdmitsPort('IN ACCEPT -source 10.0.0.0/8', 3260), true)
    })

    it('accepts a rule with no protocol stated (it admits every protocol)', () => {
      assert.equal(ruleAdmitsPort('IN ACCEPT -dport 3260', 3260), true)
    })

    it('rejects the wrong direction, the wrong action, the wrong protocol', () => {
      assert.equal(ruleAdmitsPort('OUT ACCEPT -p tcp -dport 3260', 3260), false)
      assert.equal(ruleAdmitsPort('IN DROP -p tcp -dport 3260', 3260), false)
      assert.equal(ruleAdmitsPort('IN ACCEPT -p udp -dport 3260', 3260), false)
    })

    it('rejects a DISABLED rule (PVE\'s leading-pipe form) and a comment', () => {
      assert.equal(ruleAdmitsPort('|IN ACCEPT -p tcp -dport 3260', 3260), false)
      assert.equal(ruleAdmitsPort('# IN ACCEPT -p tcp -dport 3260', 3260), false)
    })

    it('does not expand a MACRO — ANAS carries no copy of PVE\'s macro table', () => {
      // PVE's own macro form is `IN <MACRO>(<ACTION>) …`, and an explicit
      // `-macro` is a port RESTRICTION, not an accept-everything. Both only ever
      // produce a FALSE advisory ("add a rule" when one exists), which is the
      // harmless direction.
      assert.equal(ruleAdmitsPort('IN SSH(ACCEPT) -source 10.0.0.0/8', 3260), false)
      assert.equal(ruleAdmitsPort('IN ACCEPT -macro ISCSI', 3260), false)
    })
  })

  describe('rulesSection / optionsEnable', () => {
    const FW = [
      '[OPTIONS]',
      '',
      'enable: 1',
      '',
      '[IPSET management]',
      '',
      '10.0.0.0/8',
      '',
      '[RULES]',
      '',
      'IN ACCEPT -p tcp -dport 3260',
      'IN DROP',
      '',
    ].join('\n')

    it('returns only the [RULES] lines', () => {
      const lines = rulesSection(FW).filter(l => l.trim().length > 0)
      assert.deepEqual(lines, ['IN ACCEPT -p tcp -dport 3260', 'IN DROP'])
    })

    it('reads [OPTIONS] enable, and null when it is not stated', () => {
      assert.equal(optionsEnable(FW), true)
      assert.equal(optionsEnable('[OPTIONS]\nenable: 0\n'), false)
      assert.equal(optionsEnable('[RULES]\nIN ACCEPT\n'), null)
    })
  })
})

describe('pve-firewall — readPveFirewallAdvisory (the four states)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-fw-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function execStatus(stdout: string, exitCode = 0): MockExecutor {
    const exec = new MockExecutor()
    exec.addFixture({ command: PVE_FIREWALL, args: ['status'], result: { stdout, stderr: '', exitCode } })
    return exec
  }

  it('DISABLED (the real stunt-node capture) → no advisory', async () => {
    const r = await readPveFirewallAdvisory(execStatus(REAL_STATUS_DISABLED), { firewallDir: dir })
    assert.deepEqual(r, { enabled: false, admits3260: null, advisory: null })
  })

  it('ENABLED + a rule that admits 3260/tcp → no advisory', async () => {
    await writeFile(join(dir, 'cluster.fw'), '[OPTIONS]\nenable: 1\n\n[RULES]\nIN ACCEPT -p tcp -dport 3260\n')
    const r = await readPveFirewallAdvisory(execStatus('Status: enabled/running\n'), { firewallDir: dir })
    assert.equal(r.enabled, true)
    assert.equal(r.admits3260, true)
    assert.equal(r.advisory, null)
  })

  it('ENABLED + NO rule admitting 3260/tcp → the one-line advisory', async () => {
    await writeFile(join(dir, 'cluster.fw'), '[OPTIONS]\nenable: 1\n\n[RULES]\nIN ACCEPT -p tcp -dport 8006\n')
    const r = await readPveFirewallAdvisory(execStatus('Status: enabled/running\n'), { firewallDir: dir })
    assert.equal(r.enabled, true)
    assert.equal(r.admits3260, false)
    assert.match(r.advisory ?? '', /firewall is enabled and no rule admits 3260\/tcp/)
    // Guide, don't just warn — and state the boundary.
    assert.match(r.advisory ?? '', /add one in PVE/)
    assert.match(r.advisory ?? '', /ANAS never edits firewall rules/)
  })

  it('a HOST rule counts as well as a cluster one', async () => {
    await writeFile(join(dir, 'cluster.fw'), '[OPTIONS]\nenable: 1\n\n[RULES]\nIN DROP\n')
    await writeFile(join(dir, 'host.fw'), '[RULES]\nIN ACCEPT -p tcp -dport 3200:3300\n')
    const r = await readPveFirewallAdvisory(execStatus('Status: enabled/running\n'), { firewallDir: dir })
    assert.equal(r.admits3260, true)
    assert.equal(r.advisory, null)
  })

  it('UNREADABLE status (no pve-firewall at all) → no advisory, ever', async () => {
    // No fixture ⇒ the mock returns exit 127, "command not found".
    const r = await readPveFirewallAdvisory(new MockExecutor(), { firewallDir: dir })
    assert.deepEqual(r, { enabled: null, admits3260: null, advisory: null })
  })

  it('falls back to cluster.fw [OPTIONS] enable when the command could not run', async () => {
    await writeFile(join(dir, 'cluster.fw'), '[OPTIONS]\nenable: 1\n\n[RULES]\nIN DROP\n')
    const r = await readPveFirewallAdvisory(new MockExecutor(), { firewallDir: dir })
    assert.equal(r.enabled, true)
    assert.equal(r.admits3260, false)
    assert.ok(r.advisory)
  })

  it('ENABLED but the RULES are unreadable → silence, not a false accusation', async () => {
    // Enabled per the command, and no readable .fw file at all: "I could not
    // read your rules" is NOT evidence that a rule is missing.
    const r = await readPveFirewallAdvisory(execStatus('Status: enabled/running\n'), { firewallDir: dir })
    assert.deepEqual(r, { enabled: true, admits3260: null, advisory: null })
  })

  it('never executes anything but `pve-firewall status` — it is a READER', async () => {
    const exec = execStatus('Status: enabled/running\n')
    await writeFile(join(dir, 'cluster.fw'), '[OPTIONS]\nenable: 1\n\n[RULES]\nIN DROP\n')
    await readPveFirewallAdvisory(exec, { firewallDir: dir })
    assert.deepEqual(exec.calls, [{ command: PVE_FIREWALL, args: ['status'] }])
  })
})
