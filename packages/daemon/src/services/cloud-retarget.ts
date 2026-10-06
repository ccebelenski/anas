import type { CloudProvider, CloudRemote } from '@anas/shared'
import { remotesReferencing } from './rclone-config.js'

/**
 * Cloud remote RETARGET guard (story ident.4 (b), audit #15).
 *
 * A remote's DELETE already refuses while a task names it. Its PUT did not
 * look at all — yet changing a remote's endpoint, host, bucket or path
 * re-points every task that syncs through it, and a `sync` task then mirrors
 * the source onto a destination the operator never chose for it (deleting
 * what is there). So a PUT that changes where the remote POINTS answers 409 +
 * confirm naming every task that reaches the remote, directly or through a
 * wrapper (crypt, alias, union, …) that references it.
 *
 * Which options point somewhere is decided by NAME, the same way the secret
 * rule is (rclone 1.60 has no "this option is the destination" flag): an
 * option whose name is, or ends in, one of {@link DESTINATION_SUFFIXES}. A
 * provider-typed `bool` option never counts — `use_accelerate_endpoint` ends
 * in `endpoint` but is a switch, not a place. The rule is a heuristic and is
 * stated as one: an unlisted option that happens to change the destination is
 * not caught; a listed one that does not is a confirm too many.
 */

/** Option-name endings that name WHERE a remote points. */
export const DESTINATION_SUFFIXES = [
  'endpoint',
  'url',
  'host',
  'bucket',
  'path',
  'remote',
  'remotes',
  'upstreams',
  'region',
  'provider',
  'account',
  'server',
  'port',
  'drive_id',
  'root_folder_id',
  'team_drive',
  'storage_url',
  'tenant',
  'share',
]

/** Is `key` a destination option of backend `type`? */
export function isDestinationOption(key: string, type: string, providers: CloudProvider[] = []): boolean {
  const hit = DESTINATION_SUFFIXES.some(s => key === s || key.endsWith(`_${s}`))
  if (!hit)
    return false
  const option = providers.find(p => p.name === type)?.options.find(o => o.name === key)
  return option?.type !== 'bool'
}

/** One destination option the update changes: the stored value and the new one ('' = removed). */
export interface DestinationChange {
  key: string
  from: string
  to: string
}

/**
 * The destination options an update changes against the STORED remote. The
 * update contract: a non-secret key with '' is removed, an absent key is
 * unchanged, a value replaces. Secret keys never appear in `stored.options`
 * and are never destination options, so they are ignored.
 */
export function destinationChanges(
  stored: CloudRemote,
  update: Record<string, string>,
  providers: CloudProvider[] = [],
): DestinationChange[] {
  const out: DestinationChange[] = []
  for (const [key, value] of Object.entries(update)) {
    if (stored.secretsSet.includes(key) || !isDestinationOption(key, stored.type, providers))
      continue
    const from = stored.options[key] ?? ''
    if (value !== from)
      out.push({ key, from, to: value })
  }

  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/**
 * `name` plus every remote that reaches it through a wrapper, transitively
 * (a crypt over an alias over the remote re-points too). Sorted, `name` first.
 */
export function remotesReaching(remotes: CloudRemote[], name: string): string[] {
  const seen = new Set<string>([name])
  const queue = [name]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const wrapper of remotesReferencing(remotes, current)) {
      if (!seen.has(wrapper)) {
        seen.add(wrapper)
        queue.push(wrapper)
      }
    }
  }
  seen.delete(name)
  // eslint-disable-next-line e18e/prefer-array-to-sorted -- Set → sorted list
  return [name, ...[...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))]
}

/** A task that reaches the remote — `via` names the wrapper when it is not direct. */
export interface RetargetedTask {
  task: string
  via?: string
}

/**
 * Every task that syncs through `name`, directly or through a wrapper.
 * `tasksFor` is the task store's per-remote lookup (the DELETE refusal's own).
 */
export async function tasksReachingRemote(
  remotes: CloudRemote[],
  name: string,
  tasksFor: (remote: string) => Promise<string[]>,
): Promise<RetargetedTask[]> {
  const out: RetargetedTask[] = []
  const seen = new Set<string>()
  for (const remote of remotesReaching(remotes, name)) {
    for (const task of await tasksFor(remote)) {
      if (seen.has(task))
        continue
      seen.add(task)
      out.push(remote === name ? { task } : { task, via: remote })
    }
  }
  return out
}

/** The task list as the refusal sentence names it: `a, b (through crypt-b)`. */
export function describeTasks(tasks: RetargetedTask[]): string {
  return tasks.map(t => (t.via ? `${t.task} (through ${t.via})` : t.task)).join(', ')
}

/** One change as the warning names it: `endpoint: s3.a.example -> s3.b.example`. */
export function describeChange(c: DestinationChange): string {
  return `${c.key}: ${c.from || '(unset)'} -> ${c.to || '(removed)'}`
}
