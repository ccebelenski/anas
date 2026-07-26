import { z } from 'zod'

// ============================================================================
// sanoid.conf model (Epic 17 — Scheduled Snapshots & Scrubs)
//
// sanoid.conf is an INI file (SCHEDULES-GT-5): a `[version]` stanza, named
// `[template_<name>]` stanzas, and per-dataset `[pool/dataset]` stanzas (the
// dataset path has NO leading slash). Every setting is `key = value`; a value is
// ALWAYS a raw string in the file — retention counts (`hourly = 48`), yes/no
// flags (`autosnap = yes`), and monitoring ages that may carry a unit suffix
// (`hourly_warn = 90m`). We keep the raw string for byte-fidelity and layer the
// typed views (retention counts, booleans) on top, exactly as the round-trip
// parsers do for fstab / smb.conf / exports.
// ============================================================================

/**
 * A stanza's settings as written: raw `key → value` (string) pairs, last
 * definition winning. Values stay strings so nothing is lost or reformatted on
 * round-trip; typed interpretation is derived on demand.
 */
export const SanoidSettings = z.record(z.string(), z.string())
export type SanoidSettings = z.infer<typeof SanoidSettings>

/** Recursion mode: `yes` (per-child) or `zfs` (atomic recursive). */
export const SanoidRecursive = z.enum(['yes', 'zfs'])
export type SanoidRecursive = z.infer<typeof SanoidRecursive>

/** A named `[template_<name>]` stanza. `name` is the part after `template_`. */
export const SanoidTemplate = z.object({
  /** Template name (the `<name>` in `[template_<name>]`). */
  name: z.string(),
  /** Raw settings written in this template, in file order (last wins). */
  settings: SanoidSettings,
})
export type SanoidTemplate = z.infer<typeof SanoidTemplate>

/**
 * A per-dataset `[pool/dataset]` stanza. The `dataset` is the ZFS path exactly
 * as written (no leading slash). `useTemplate` is the parsed comma list from
 * `use_template =` in listed order (order is significant — see the effective
 * policy). `settings` carries every inline key, including `use_template` and
 * `recursive` themselves, verbatim.
 */
export const SanoidDataset = z.object({
  /** ZFS dataset path, no leading slash (e.g. `tank/media`). */
  dataset: z.string(),
  /** Templates named in `use_template =`, in listed (order-significant) order. */
  useTemplate: z.array(z.string()),
  /** Recursion mode if `recursive =` is set. */
  recursive: SanoidRecursive.optional(),
  /** Raw inline settings written in this stanza (last wins). */
  settings: SanoidSettings,
})
export type SanoidDataset = z.infer<typeof SanoidDataset>

/**
 * The interpreted view of a whole sanoid.conf: the `[version]` value plus the
 * template and dataset stanzas. The byte-for-byte document model lives in the
 * daemon parser; this is the typed read-model the API/screen consume.
 */
export const SanoidConfig = z.object({
  /** Value of `version =` in `[version]`, if present (e.g. `"2"`). */
  version: z.string().optional(),
  templates: z.array(SanoidTemplate),
  datasets: z.array(SanoidDataset),
})
export type SanoidConfig = z.infer<typeof SanoidConfig>

/**
 * The six snapshot cadences sanoid keeps counts for. `0` means "don't take, and
 * immediately prune this type" (SCHEDULES-GT-7). Resolved from the effective
 * settings chain.
 */
export const SanoidRetention = z.object({
  frequently: z.number().int().nonnegative(),
  hourly: z.number().int().nonnegative(),
  daily: z.number().int().nonnegative(),
  weekly: z.number().int().nonnegative(),
  monthly: z.number().int().nonnegative(),
  yearly: z.number().int().nonnegative(),
})
export type SanoidRetention = z.infer<typeof SanoidRetention>

/**
 * A dataset's fully-resolved effective policy (SCHEDULES-GT-8): the values
 * sanoid would actually use, resolved through the chain
 * shipped-defaults → local `[template_default]` → `use_template` templates (in
 * listed order, later wins) → inline stanza overrides. `settings` is the full
 * merged raw map; `retention`/`autosnap`/`autoprune`/`recursive` are the typed
 * projections the policy-summary grid needs.
 */
export const SanoidEffectivePolicy = z.object({
  /** Dataset this policy resolves for (no leading slash). */
  dataset: z.string(),
  /** The `use_template` chain that was applied, in order. */
  templates: z.array(z.string()),
  retention: SanoidRetention,
  autosnap: z.boolean(),
  autoprune: z.boolean(),
  recursive: SanoidRecursive.optional(),
  /** Every setting that resolves, merged (raw string values). */
  settings: SanoidSettings,
})
export type SanoidEffectivePolicy = z.infer<typeof SanoidEffectivePolicy>

/**
 * An unrecognized (non-whitelisted) setting found on READ. sanoid rejects
 * unknown keys FATALLY (SCHEDULES-GT-9), so the screen surfaces these as a
 * warning rather than silently dropping them — the parser preserves them
 * verbatim but never re-emits them on write.
 */
export const SanoidUnknownSetting = z.object({
  /** Stanza header the key was found under (e.g. `backup/offsite`, `template_x`). */
  stanza: z.string(),
  /** The offending setting key. */
  key: z.string(),
})
export type SanoidUnknownSetting = z.infer<typeof SanoidUnknownSetting>
