import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  addDataset,
  findUnrecognizedKeys,
  getDataset,
  getTemplate,
  hasDataset,
  hasTemplate,
  parseSanoidConf,
  parseSanoidDoc,
  removeDataset,
  removeTemplate,
  resolveEffectivePolicy,
  sanoidKeyWhitelist,
  SanoidUnknownKeyError,
  serializeSanoidDoc,
  setSetting,
  validateSettingsForWrite,
} from '../sanoid-conf.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(__dirname, '../../fixtures/schedules')
const read = (name: string): string => readFileSync(join(fixtureDir, name), 'utf-8')

const DEFAULTS = read('sanoid.defaults.conf')
const EXAMPLE = read('sanoid.conf.example')
const ROUNDTRIP = read('sanoid.conf.roundtrip')

/** Indices of lines that differ between two texts (parallel by line number). */
function diffLines(a: string, b: string): number[] {
  const la = a.split('\n')
  const lb = b.split('\n')
  const out: number[] = []
  const n = Math.max(la.length, lb.length)
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i])
      out.push(i)
  }
  return out
}

describe('sanoid.conf round-trip (byte identity)', () => {
  it('reproduces sanoid.defaults.conf BYTE-FOR-BYTE', () => {
    assert.equal(serializeSanoidDoc(parseSanoidDoc(DEFAULTS)), DEFAULTS)
  })

  it('reproduces the shipped sanoid.conf example BYTE-FOR-BYTE', () => {
    assert.equal(serializeSanoidDoc(parseSanoidDoc(EXAMPLE)), EXAMPLE)
  })

  it('reproduces the roundtrip fixture BYTE-FOR-BYTE (comments, tabs, ordering, unknown key)', () => {
    assert.equal(serializeSanoidDoc(parseSanoidDoc(ROUNDTRIP)), ROUNDTRIP)
  })

  it('preserves the deliberately-unknown directive on round-trip', () => {
    // The `anas_note` line (with its trailing comment) survives untouched.
    assert.ok(ROUNDTRIP.includes('anas_note = incremental-base-protected-by-zfs-hold'))
    assert.equal(serializeSanoidDoc(parseSanoidDoc(ROUNDTRIP)), ROUNDTRIP)
  })

  it('round-trips a file with no trailing newline', () => {
    const text = '[version]\nversion = 2\n\n[tank/media]\n\tuse_template = prod'
    assert.equal(serializeSanoidDoc(parseSanoidDoc(text)), text)
  })

  it('round-trips the empty file', () => {
    assert.equal(serializeSanoidDoc(parseSanoidDoc('')), '')
  })
})

describe('sanoid.conf typed read-model', () => {
  it('parses [version] and [template_default] from the defaults file', () => {
    const cfg = parseSanoidConf(DEFAULTS)
    assert.equal(cfg.version, '2')
    assert.equal(cfg.datasets.length, 0)
    assert.equal(cfg.templates.length, 1)
    assert.equal(cfg.templates[0].name, 'default')
    assert.equal(cfg.templates[0].settings.hourly, '48')
    assert.equal(cfg.templates[0].settings.daily, '90')
    assert.equal(cfg.templates[0].settings.monthly, '6')
    assert.equal(cfg.templates[0].settings.hourly_warn, '90m')
  })

  it('parses templates + the recursive dataset from the shipped example', () => {
    const cfg = parseSanoidConf(EXAMPLE)
    const names = cfg.templates.map(t => t.name)
    assert.deepEqual(names, ['demo', 'production', 'backup', 'hotspare', 'scripts', 'ignore'])
    // The one live (uncommented) dataset stanza.
    assert.equal(cfg.datasets.length, 1)
    const ds = cfg.datasets[0]
    assert.equal(ds.dataset, 'zpoolname/parent2')
    assert.deepEqual(ds.useTemplate, ['production'])
    assert.equal(ds.recursive, 'zfs')
  })

  it('parses per-dataset stanzas + use_template comma-lists + recursive flags (roundtrip)', () => {
    const cfg = parseSanoidConf(ROUNDTRIP)
    assert.equal(cfg.version, '2')
    const paths = cfg.datasets.map(d => d.dataset)
    assert.deepEqual(paths, ['tank/media', 'tank/vmstore', 'rpool/data', 'backup/offsite'])

    const media = getDataset(ROUNDTRIP, 'tank/media')!
    assert.deepEqual(media.useTemplate, ['anas_frequent', 'anas_longterm'])
    assert.equal(media.settings.hourly, '12') // inline override captured raw

    const vmstore = getDataset(ROUNDTRIP, 'tank/vmstore')!
    assert.equal(vmstore.recursive, 'zfs')

    const data = getDataset(ROUNDTRIP, 'rpool/data')!
    assert.equal(data.recursive, 'yes')
    assert.equal(data.settings.process_children_only, 'yes')

    // The unknown key is preserved on the dataset's raw settings (not dropped).
    const offsite = getDataset(ROUNDTRIP, 'backup/offsite')!
    assert.equal(offsite.settings.anas_note, 'incremental-base-protected-by-zfs-hold')
  })

  it('has* accessors distinguish templates from datasets', () => {
    assert.equal(hasTemplate(ROUNDTRIP, 'anas_frequent'), true)
    assert.equal(hasTemplate(ROUNDTRIP, 'tank/media'), false)
    assert.equal(hasDataset(ROUNDTRIP, 'tank/media'), true)
    assert.equal(hasDataset(ROUNDTRIP, 'anas_frequent'), false)
    assert.equal(getTemplate(ROUNDTRIP, 'anas_longterm')!.settings.weekly, '8')
  })
})

describe('sanoid.conf effective-policy resolution (GT-8)', () => {
  it('resolves tank/media through defaults → templates(in order) → inline override', () => {
    const p = resolveEffectivePolicy(ROUNDTRIP, 'tank/media', DEFAULTS)
    assert.deepEqual(p.templates, ['anas_frequent', 'anas_longterm'])
    // hourly: anas_frequent=36, anas_longterm=0, inline override=12 → 12 wins.
    assert.equal(p.retention.hourly, 12)
    // daily: anas_longterm (later template) 90 overrides anas_frequent's 30.
    assert.equal(p.retention.daily, 90)
    // weekly/monthly/yearly come from anas_longterm.
    assert.equal(p.retention.weekly, 8)
    assert.equal(p.retention.monthly, 12)
    assert.equal(p.retention.yearly, 3)
    // frequently=0 from the template chain; unset elsewhere falls to defaults.
    assert.equal(p.retention.frequently, 0)
    assert.equal(p.autosnap, true)
    assert.equal(p.autoprune, true)
    // A key set ONLY in the shipped defaults still resolves through the chain.
    assert.equal(p.settings.frequent_period, '15')
    assert.equal(p.settings.capacity_warn, '80')
  })

  it('later template wins (order-significant use_template)', () => {
    // Two templates disagree on `daily`; the one listed LATER must win.
    const text = [
      '[template_a]',
      '\tdaily = 10',
      '[template_b]',
      '\tdaily = 99',
      '[tank/x]',
      '\tuse_template = a,b',
      '[tank/y]',
      '\tuse_template = b,a',
      '',
    ].join('\n')
    assert.equal(resolveEffectivePolicy(text, 'tank/x', DEFAULTS).retention.daily, 99) // b later
    assert.equal(resolveEffectivePolicy(text, 'tank/y', DEFAULTS).retention.daily, 10) // a later
  })

  it('local [template_default] overrides shipped defaults but loses to templates + inline', () => {
    const text = [
      '[template_default]',
      '\tdaily = 7',
      '[template_t]',
      '\tdaily = 42',
      '[tank/a]', // local default only
      '\tuse_template =',
      '[tank/b]', // template overrides local default
      '\tuse_template = t',
      '[tank/c]', // inline overrides everything
      '\tuse_template = t',
      '\tdaily = 3',
      '',
    ].join('\n')
    assert.equal(resolveEffectivePolicy(text, 'tank/a', DEFAULTS).retention.daily, 7)
    assert.equal(resolveEffectivePolicy(text, 'tank/b', DEFAULTS).retention.daily, 42)
    assert.equal(resolveEffectivePolicy(text, 'tank/c', DEFAULTS).retention.daily, 3)
  })

  it('a dataset absent from the config resolves to the shipped defaults', () => {
    const p = resolveEffectivePolicy(ROUNDTRIP, 'tank/does-not-exist', DEFAULTS)
    assert.deepEqual(p.templates, [])
    assert.equal(p.retention.hourly, 48) // shipped default
    assert.equal(p.retention.daily, 90)
    assert.equal(p.retention.monthly, 6)
  })
})

describe('sanoid.conf whitelist validation (GT-9)', () => {
  it('derives the whitelist from the shipped defaults file', () => {
    const wl = sanoidKeyWhitelist(DEFAULTS)
    for (const k of ['hourly', 'daily', 'weekly', 'monthly', 'yearly', 'frequently', 'autosnap', 'autoprune', 'recursive', 'use_template', 'frequent_period'])
      assert.ok(wl.has(k), `whitelist should contain ${k}`)
    assert.equal(wl.has('anas_note'), false)
  })

  it('flags unknown keys on READ without dropping them', () => {
    const wl = sanoidKeyWhitelist(DEFAULTS)
    const unknown = findUnrecognizedKeys(ROUNDTRIP, wl)
    assert.deepEqual(unknown, [{ stanza: 'backup/offsite', key: 'anas_note' }])
    // ...and the parser still round-trips them byte-for-byte.
    assert.equal(serializeSanoidDoc(parseSanoidDoc(ROUNDTRIP)), ROUNDTRIP)
  })

  it('validateSettingsForWrite passes known keys and refuses unknown ones', () => {
    const wl = sanoidKeyWhitelist(DEFAULTS)
    assert.doesNotThrow(() => validateSettingsForWrite({ hourly: '12', autosnap: 'yes' }, wl))
    assert.throws(
      () => validateSettingsForWrite({ hourly: '12', anas_note: 'x' }, wl),
      (e: unknown) => e instanceof SanoidUnknownKeyError && e.keys.includes('anas_note'),
    )
  })

  it('refuses to WRITE an unknown key via setSetting / addDataset', () => {
    const wl = sanoidKeyWhitelist(DEFAULTS)
    assert.throws(
      () => setSetting(ROUNDTRIP, 'tank/media', 'anas_note', 'x', wl),
      SanoidUnknownKeyError,
    )
    assert.throws(
      () => addDataset(ROUNDTRIP, 'tank/new', { anas_note: 'x' }, wl),
      SanoidUnknownKeyError,
    )
    // A whitelisted key writes fine.
    assert.doesNotThrow(() => setSetting(ROUNDTRIP, 'tank/media', 'daily', '45', wl))
  })
})

describe('sanoid.conf surgical edits (rest byte-identical)', () => {
  it('changes a retention value touching ONLY that line', () => {
    const out = setSetting(ROUNDTRIP, 'tank/media', 'hourly', '24')
    const diff = diffLines(ROUNDTRIP, out)
    assert.equal(diff.length, 1)
    assert.ok(ROUNDTRIP.split('\n')[diff[0]].includes('hourly = 12'))
    assert.ok(out.split('\n')[diff[0]].includes('hourly = 24'))
    // The typed re-read reflects the change; everything else is intact.
    assert.equal(getDataset(out, 'tank/media')!.settings.hourly, '24')
    assert.equal(getDataset(out, 'tank/vmstore')!.recursive, 'zfs')
  })

  it('preserves the tab indent when rewriting a value', () => {
    const out = setSetting(ROUNDTRIP, 'tank/media', 'hourly', '24')
    assert.ok(out.includes('\thourly = 24'))
  })

  it('inserts a new key into a stanza without disturbing other lines', () => {
    const out = setSetting(ROUNDTRIP, 'tank/vmstore', 'daily', '5')
    const diff = diffLines(ROUNDTRIP, out)
    // One inserted line shifts everything after it, but the added line is the
    // only NEW content — verify by re-reading and by line-count growth of one.
    assert.equal(out.split('\n').length, ROUNDTRIP.split('\n').length + 1)
    assert.equal(getDataset(out, 'tank/vmstore')!.settings.daily, '5')
    assert.ok(diff.length >= 1)
  })

  it('removes a dataset stanza leaving the other stanzas byte-identical', () => {
    const out = removeDataset(ROUNDTRIP, 'tank/vmstore')
    assert.equal(hasDataset(out, 'tank/vmstore'), false)
    // Every other dataset + template survives unchanged.
    for (const p of ['tank/media', 'rpool/data', 'backup/offsite'])
      assert.deepEqual(getDataset(out, p), getDataset(ROUNDTRIP, p))
    for (const t of ['anas_frequent', 'anas_longterm', 'anas_replica'])
      assert.deepEqual(getTemplate(out, t), getTemplate(ROUNDTRIP, t))
    // The removal equals a manual splice of exactly the stanza's line span.
    const span = parseSanoidDoc(ROUNDTRIP).stanzas.find(s => s.header === 'tank/vmstore')!
    const manual = ROUNDTRIP.split('\n')
    manual.splice(span.start, span.end - span.start)
    assert.equal(out, manual.join('\n'))
  })

  it('removes a template stanza', () => {
    const out = removeTemplate(ROUNDTRIP, 'anas_replica')
    assert.equal(hasTemplate(out, 'anas_replica'), false)
    assert.equal(hasTemplate(out, 'anas_frequent'), true)
  })

  it('adds a dataset stanza preserving the original bytes as a prefix', () => {
    const out = addDataset(ROUNDTRIP, 'tank/newvol', { use_template: 'anas_frequent', hourly: '6' })
    assert.ok(out.startsWith(ROUNDTRIP)) // every original byte preserved
    const ds = getDataset(out, 'tank/newvol')!
    assert.deepEqual(ds.useTemplate, ['anas_frequent'])
    assert.equal(ds.settings.hourly, '6')
    assert.equal(serializeSanoidDoc(parseSanoidDoc(out)), out) // still round-trips
  })

  it('setSetting on an absent stanza is a no-op', () => {
    assert.equal(setSetting(ROUNDTRIP, 'tank/nope', 'daily', '1'), ROUNDTRIP)
  })

  it('removes a setting with value null', () => {
    const out = setSetting(ROUNDTRIP, 'rpool/data', 'process_children_only', null)
    assert.equal(getDataset(out, 'rpool/data')!.settings.process_children_only, undefined)
    assert.equal(getDataset(out, 'rpool/data')!.recursive, 'yes') // sibling key intact
  })
})
