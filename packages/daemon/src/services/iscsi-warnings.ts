/**
 * iSCSI → dashboard warning cards (story `iscsi.5`).
 *
 * The whole reason the `iscsi` category exists is that **nothing else on this
 * node will ever tell anyone**:
 *
 *  - a boot restore whose backing device was missing exits 0 and is logged by
 *    systemd as `Result=success`; `targetctl` collects the per-object errors and
 *    prints them without turning one into an exit code, so no `Restart=` and no
 *    `OnFailure=` can catch it (GT-20). With a whole pool late, the target comes
 *    up enabled and listening with ZERO LUNs and an initiator logs in happily
 *    and sees no disks (GT-21).
 *  - a portal bound to an address no interface carries reports `[OK]`, survives
 *    the interface being deleted and a service restart, and never logs a word
 *    (GT-24).
 *
 * So this is a PULL, computed from the saveconfig ⟷ configfs diff the health
 * endpoint already produces — no poller, no push, no state file (the standing
 * dashboard ruling). It renders TARGET-FIRST, because the operator's question is
 * "which of my targets is lying to its initiators", not "how many LUNs are
 * missing".
 *
 * Healthy adds NOTHING and LIO-not-installed adds NOTHING — a node that serves
 * no block storage must never see an iSCSI card. A read that FAILED throws
 * (cr3): the dashboard then marks the iSCSI section unavailable rather than
 * reading the failure as "no warnings".
 */

import type { DashboardWarning, IscsiHealth } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { IscsiHealthReadOptions } from './iscsi-health.js'
import type { IscsiPaths } from './iscsi.js'
import { foreignHolesSentence } from './iscsi-mutate.js'
import { readIscsiHealth } from './iscsi-quarantine.js'
import { clearMarkCommand, markDataset, restoreEndSentence } from './restore-mark.js'

/**
 * Build the `iscsi` dashboard cards from a health diff. Pure — the caller has
 * already paid for the read.
 *
 * Six card shapes, in the order an operator needs them:
 *
 *  1. **A target serving nothing** (`critical`) — the target is up and enabled
 *     with none of its saved LUNs. It is accepting logins and handing out an
 *     empty disk list.
 *  1b. **A LUN over a PLACEHOLDER** (`critical`, story `iscsi.8`) — the worst of
 *     the family, because it is the only one an initiator cannot see: the disk is
 *     present, the right size and the right serial, and empty. Names both signals
 *     and says whether ANAS managed to take it offline.
 *  3b. **An ANAS target that is DISABLED** (`warning`) — serving nothing on
 *     purpose, most often after a partial image restore, with the reason when a
 *     retained job still has it.
 *  2. **A LUN that did not restore** (`warning`) — one disk vanished out of a
 *     target that is otherwise serving. Names the LUN, the target and the
 *     backing path the restore could not open, and says whether that path is
 *     back now (which is what makes the repair door usable).
 *  3. **The degraded verdict** (`critical`) — the consequence that spans the
 *     whole node: while a restore is known incomplete NOTHING may run
 *     `saveconfig`, because a save writes the truncated config over
 *     `saveconfig.json` and the LUN is gone for good (GT-22). So every iSCSI
 *     mutation is refused until it is repaired, and the card says so.
 *  4. **A portal on an address no interface carries** (`warning`).
 *
 * 1 and 2 overlap on purpose: a target serving nothing also has missing LUNs,
 * and both facts are worth a line — one says which disks, one says the target is
 * not actually ready.
 */
export function buildIscsiWarnings(health: IscsiHealth): DashboardWarning[] {
  const warnings: DashboardWarning[] = []
  if (!health.installed)
    return warnings

  for (const t of health.targetsServingNothing) {
    warnings.push({
      level: 'critical',
      category: 'iscsi',
      message: `iSCSI target ${t.targetIqn} restored with none of its ${t.persistedLunCount} `
        + `LUN${t.persistedLunCount === 1 ? '' : 's'} — the backing storage was not available. `
        + `${t.enabled ? 'It is enabled and accepting logins with no disks behind it' : 'It is disabled'}.`,
      ref: t.targetIqn,
    })
  }

  // 1b. A LUN being served over a PLACEHOLDER (story `iscsi.8`, live-proof F2).
  //     Critical, and above the missing-LUN cards on purpose: a hole is visible
  //     to the initiator (the disk is gone), a stub is not (the disk is there,
  //     the right size, the right serial, and empty). This is the only card that
  //     can tell an operator their data was never being served.
  for (const stub of health.stubLuns) {
    // cr3 (review): a full-size image on an unexpected mount is not a
    // placeholder — it holds data, ANAS leaves it serving, and the card says
    // so as a warning, never as an empty disk.
    if (!stub.zeroSized) {
      warnings.push({
        level: 'warning',
        category: 'iscsi',
        message: `LUN ${stub.lunIndex} '${stub.backstoreName}' of target ${stub.targetIqn} is served from ${stub.backingPath}, `
          + `which is on ${stub.containingMount} instead of ${stub.expectedMount}. The file is full-size, so it holds data `
          + `and ANAS leaves it serving — check that this is the filesystem you meant (a bind mount or an altroot can do this).`,
        ref: stub.targetIqn,
      })
      continue
    }
    const why = stub.zeroSized && stub.wrongMount
      ? `it is 0 bytes where the saved configuration says ${stub.persistedSize}, and it is on ${stub.containingMount} instead of ${stub.expectedMount}`
      : stub.zeroSized
        ? `it is 0 bytes where the saved configuration says ${stub.persistedSize}`
        : `it is on ${stub.containingMount} instead of ${stub.expectedMount}`
    // cr.62 (review L9): the dashboard and the health read no longer act, so
    // an un-quarantined stub here means "not taken offline YET", not "ANAS
    // tried and failed". The act is Repair's (POST, Sys.Modify): it unmaps a
    // placeholder before it plans anything. A foreign target's stub is never
    // ANAS's to touch (story `iscsi.5`), so that one stays a hand job.
    const action = stub.quarantined
      ? `ANAS has taken it offline${stub.fileRemoved ? ' and removed the placeholder' : ''}; mount the filesystem and use Repair on the iSCSI screen to put the LUN back with its own serial.`
      : stub.ownership === 'anas'
        ? `It is still being served. Use Repair on the iSCSI screen to take it offline now — Repair unmaps a placeholder before anything else and keeps the saved record — then mount the filesystem and use Repair again to put the LUN back with its own serial.`
        : `It is still being served, and the target is not ANAS's, so ANAS will not unmap it. Log initiators out and delete LUN ${stub.lunIndex} by hand, then mount the filesystem.`
    warnings.push({
      level: 'critical',
      category: 'iscsi',
      message: `LUN ${stub.lunIndex} '${stub.backstoreName}' of target ${stub.targetIqn} is a placeholder created by `
        + `the restore service — its filesystem was not mounted, so ${stub.backingPath} holds no data (${why}). `
        + `An initiator reading it sees an empty disk of the right size with the right serial. ${action}`,
      ref: stub.targetIqn,
    })
  }

  // C4: the holes ANAS made itself by REMOVING a placeholder in this very pass.
  // The fact is already on the health object — `stubLuns` carries the acted
  // stubs with `fileRemoved` (the quarantine carries them onto the after-read
  // precisely so the card can still say what happened) — so no new thread is
  // needed, only the honesty to read it. Nothing is remembered across reads: on
  // a LATER read the stub is gone from the diff, and the hole is an ordinary
  // absent backing, which is exactly what it then is.
  const placeholderRemoved = new Set(
    health.stubLuns.filter(s => s.fileRemoved).map(s => `${s.targetIqn}#${s.lunIndex}`),
  )

  for (const lun of health.missingLuns) {
    // A hole ANAS made itself, by taking a placeholder off the network, must
    // keep saying so: "that path is still missing" is confusing when there is
    // visibly a file at it (story `iscsi.8`).
    const placeholderClause = ' That path holds a PLACEHOLDER the restore service created — a file of the right name '
      + 'that is not the image, which is why ANAS took the LUN offline. Mount the filesystem that should hold the '
      + 'image, then use Repair on the iSCSI screen to put the LUN back with its own serial.'
    // ANAS deleted the file at that path itself, so "bring the storage back
    // (restore the image)" would be an instruction to undo a deletion that
    // destroyed nothing: the file was a 0-byte placeholder on the wrong
    // filesystem, never the image. The image is wherever it always was — on the
    // filesystem that did not mount.
    const removedClause = ' That path is empty because ANAS REMOVED the placeholder it found there — it was 0 bytes and '
      + 'on the wrong filesystem, so nothing of yours was deleted. Mount the filesystem that should hold the image, then '
      + 'use Repair on the iSCSI screen to put the LUN back with its own serial.'
    // cr3 (ISCSI-L7): a hole in a target ANAS does not manage is never
    // Repair's — the card says whose it is and how to restore it by hand.
    const backNow = lun.targetOwnership === 'foreign'
      ? ` ${foreignHolesSentence([lun])}`
      : lun.stubBacking
        ? placeholderClause
        : placeholderRemoved.has(`${lun.targetIqn}#${lun.lunIndex}`)
          ? removedClause
          : lun.backingExists === true
            ? ' That path is available again — use Repair on the iSCSI screen to put the LUN back.'
            : lun.backingExists === false
              ? ' That path is still missing — bring the storage back (import the pool, restore the image) first.'
              : ''
    warnings.push({
      level: 'warning',
      category: 'iscsi',
      message: `LUN ${lun.lunIndex} '${lun.backstoreName}' of target ${lun.targetIqn} did not restore — `
        + `its backing ${lun.backingPath} was not available; the target is serving without it.${backNow}`,
      ref: lun.targetIqn,
    })
  }

  // cr3 (ISCSI-L15): the saved configuration could not be read. Its own card,
  // not the "incomplete restore" one: nothing is known to be missing — the
  // file that says what should exist is what is broken.
  if (health.saveconfigUnreadable) {
    warnings.push({
      level: 'critical',
      category: 'iscsi',
      message: `The saved iSCSI configuration cannot be read: ${health.saveconfigUnreadable}. A save now would `
        + `overwrite it with the live configuration, so iSCSI changes are refused until the file is restored `
        + `(targetcli keeps copies in /etc/rtslib-fb-target/backup/).`,
    })
  }

  // cr3: the live configuration could not be listed in full.
  if (health.configfsUnreadable && health.configfsUnreadable.length > 0) {
    warnings.push({
      level: 'critical',
      category: 'iscsi',
      message: `The live iSCSI configuration could not be read in full (${health.configfsUnreadable.join(', ')} could not be listed), `
        + `so the LUNs, initiators and sessions behind it are unknown. iSCSI changes and Repair are refused until it reads.`,
    })
  }

  if (health.degraded && (health.missingLuns.length > 0 || health.stubLuns.length > 0)) {
    const n = health.missingLuns.length
    const stubs = health.stubLuns.length
    // The `incomplete restore (N LUN…)` phrasing is the one an operator has seen
    // since `iscsi.5`; a stub gets its own headline because it is a different
    // fact (nothing is missing — something wrong is being served) and reading it
    // as "incomplete restore" would send the operator looking for an absence.
    const incomplete = `is an incomplete restore (${n} LUN${n === 1 ? '' : 's'} in the saved configuration that the kernel does not have)`
    const placeholders = `is serving ${stubs} LUN${stubs === 1 ? '' : 's'} over a placeholder file the restore service created`
    const headline = stubs > 0 && n > 0
      ? `${incomplete} AND ${placeholders}`
      : stubs > 0 ? placeholders : incomplete
    // cr3 (ISCSI-L7): when the only holes are in foreign targets, "until this
    // is repaired" would point at a Repair that never touches them.
    const foreignOnly = stubs === 0 && n > 0 && health.missingLuns.every(l => l.targetOwnership === 'foreign')
    warnings.push({
      level: 'critical',
      category: 'iscsi',
      message: `The live iSCSI configuration ${headline}. Saving now would `
        + `write the hole into /etc/rtslib-fb-target/saveconfig.json permanently, so iSCSI mutations are ${
          foreignOnly
            ? `refused until the missing LUNs are back — they are in targets ANAS does not manage, so Repair does not touch them; `
            + `restore them by hand (their own cards say how).`
            : `refused until this is repaired.`}`,
    })
  }

  // cr3.lunrestore: the restore marks (the breadcrumb on the volume), by target.
  const marks = health.restoreMarks ?? []
  const marksOf = (iqn: string) => marks.filter(m => m.targetIqn === iqn)
  const disabledIqns = new Set(health.disabledTargets.map(t => t.targetIqn))

  // A target ANAS owns that is switched off is serving nothing (live-proof F12).
  // cr3.lunrestore: WHY comes from the restore mark on its LUNs' volumes —
  // which survives the job — and a retained job only adds what it said.
  for (const t of health.disabledTargets) {
    const own = marksOf(t.targetIqn)
    const running = own.find(m => m.state === 'in-progress')
    const unreadable = own.filter(m => m.state === 'unreadable')
    const partial = own.filter(m => m.state === 'interrupted' || m.state === 'unverified')
    const lead = `iSCSI target ${t.targetIqn} is disabled — it is serving nothing, and its `
      + `${t.lunCount} LUN${t.lunCount === 1 ? '' : 's'} ${t.lunCount === 1 ? 'is' : 'are'} unreachable `
      + `(LIO's enable flag is per target, not per LUN).`
    const said = t.detail ? ` ${t.detail}` : ''
    let tail: string
    if (running) {
      // (a) a restore is running onto it: progress, never an invitation to
      // Enable — and no promise about the end (review2 F1): the restore
      // enables only what it disabled, only over an image it proved.
      // review3 4: the three ways it can end, per backing kind (a file's row
      // has no volume).
      tail = ` ${running.detail} Enable is refused until the restore ends. `
        + `${restoreEndSentence(running.dataset === null ? 'file' : 'zvol', 'a target the restore disabled')} `
        + `A target the restore did not disable is left as it is.`
    }
    else if (partial.length > 0) {
      // review2 D: a row may come from a mark (the confirm removes it) or from
      // a job record of an image file (nothing to remove) — the sentence says
      // what Enable does for the rows it has.
      // review3 2: restoring again in place is the way out for a volume; an
      // image file's own row says what it needs first (its length).
      const marked = partial.filter(m => m.source === 'mark').length
      const again = marked === 0
        ? ''
        : marked === partial.length ? ' Restoring the image again is the other way out.' : ' For a LUN on a volume, restoring the image again is the other way out.'
      tail = ` ${partial.map(m => m.detail).join(' ')} Enabling the target serves ${partial.length === 1 ? 'that image' : 'those images'} `
        + `to initiators: Enable on the iSCSI screen asks you to confirm${marked > 0 ? ` and removes the restore mark${marked === 1 ? '' : 's'}` : ''}.`
        + `${again}${said}`
    }
    else if (unreadable.length > 0) {
      tail = ` ${unreadable.map(m => m.detail).join(' ')} Enable is refused until the mark can be read.${said}`
    }
    else {
      tail = `${said} Enable it from the iSCSI screen when you are ready.`
    }
    warnings.push({ level: 'warning', category: 'iscsi', message: `${lead}${tail}`, ref: t.targetIqn })
  }

  // cr3.lunrestore: a LUN whose volume carries an interrupted or unverified
  // restore mark on a target that is ENABLED (switched on by hand): initiators
  // are being served that image now — critical.
  for (const m of marks) {
    if (!m.targetIqn || disabledIqns.has(m.targetIqn) || (m.state !== 'interrupted' && m.state !== 'unverified'))
      continue
    warnings.push({
      level: 'critical',
      category: 'iscsi',
      message: `${m.detail} Target ${m.targetIqn} is enabled, so initiators are being served that image now. `
        + `Disable the target, then ${m.source === 'job' ? 'accept it with Enable\'s confirm, or restore it again in place as said above' : 'restore the image again or accept it with Enable\'s confirm'}.`,
      ref: m.targetIqn,
    })
  }

  // cr3.lunrestore: a backstore on ANAS storage that no LUN maps. `warning`,
  // never `critical` and never the degraded card: no initiator can see a
  // backstore that is not a TPG LUN, so nothing is being served wrongly and
  // every other iSCSI verb still runs. What it HOLDS is said from the restore
  // mark on its volume: an interrupted restore (partial image), an unverified
  // one, or — with no mark — only what is known. A restore that is running
  // onto it now (the job view) is progress, not a finding: no card.
  for (const b of health.unmappedBackstores ?? []) {
    if (b.restoreInFlight)
      continue
    const dataset = markDataset(b.backingPath)
    const row = marks.find(m => !m.targetIqn && m.backingPath === b.backingPath)
    const saved = b.persisted === true
      ? ' It is in the saved configuration, so it comes back, still not mapped, at the next boot.'
      : b.persisted === false
        ? ' It is not in the saved configuration, so it is gone after the next reboot; its backing stays.'
        : ''
    const resave = b.persisted === true ? ' (the next iSCSI change in ANAS saves the configuration without it)' : ''
    const destroy = dataset ? `'zfs destroy ${dataset}'` : `delete the image file ${b.backingPath}`
    const held = dataset
      ? `ANAS refuses to destroy, roll back, rename or resize ${dataset} while the backstore exists.`
      : `ANAS refuses to destroy or roll back the storage ${b.backingPath} is on, or unmount it, while the backstore exists.`
    const remove = `To remove it: 'targetcli /backstores/${b.plugin} delete ${b.name}'${resave}, then ${destroy} if you do not need the image.`
    let what: string
    if (row?.state === 'interrupted') {
      what = `${row.detail} No initiator can see it. ${held}${saved} ${remove} To restore the image again: remove both, then restore it as a new LUN.`
    }
    else if (row?.state === 'unverified') {
      what = `${row.detail} No initiator can see it. ${held}${saved} ${remove} If you have checked the image, `
        + `${row.source === 'mark' && row.dataset ? `clear the mark ('${clearMarkCommand(row.dataset)}') and ` : ''}map the backstore with targetcli.`
    }
    else if (row?.state === 'unreadable') {
      what = `${row.detail} No initiator can see it. ${held}${saved} ${remove}`
    }
    else {
      // N3: no mark — say only what is known.
      what = `A backstore no LUN maps holds this storage${dataset ? ', and no restore mark is on it' : ' (an image file carries no restore mark)'}: `
        + `ANAS cannot tell what it holds. No initiator can see it. ${held}${saved} ${remove}`
    }
    warnings.push({
      level: 'warning',
      category: 'iscsi',
      message: `iSCSI backstore '${b.name}' (${b.plugin}, ${b.backingPath}) is not mapped as a LUN. ${what}`,
    })
  }

  for (const p of health.portalsWithoutInterface) {
    warnings.push({
      level: 'warning',
      category: 'iscsi',
      message: `Portal ${p.address}:${p.port} of target ${p.targetIqn} is bound to an address no `
        + `interface on this node carries — LIO binds it anyway, reports it healthy and never logs `
        + `a word, so initiators simply cannot reach it.`,
      ref: p.targetIqn,
    })
  }

  return warnings
}

/**
 * Collect the dashboard `iscsi` warnings. A failed read throws (cr3,
 * INVENTED-STATE-H1) — the dashboard's section reader turns that into
 * "iSCSI unavailable", never into "no warnings".
 *
 * Cost on a node that serves no block storage is two `stat` calls: with neither
 * a configfs target tree nor a `saveconfig.json`, `readIscsiContext` returns
 * before it reads `storage.cfg`, `zfs list`, `ip addr` or AHR topology.
 */
export async function collectIscsiWarnings(
  executor: CommandExecutor,
  paths: IscsiPaths = {},
  opts: IscsiHealthReadOptions = {},
): Promise<DashboardWarning[]> {
  // A pure read (cr.62, review L9): the dashboard REPORTS a placeholder LUN
  // (the card above says it is still served and points at Repair); it never
  // quarantines one — a GET must not act. One gather, no lock.
  //
  // cr3 (INVENTED-STATE-H1): a read that FAILED propagates. It used to be
  // caught here and answered `[]` — "no iSCSI warnings", all clear — and the
  // dashboard marks a section unavailable only on a throw or a timeout, so a
  // broken read showed as a healthy node. The dashboard's section reader
  // catches it and says the iSCSI section is unavailable.
  const { ctx, health } = await readIscsiHealth(executor, paths, opts)
  if (!ctx.live.present && ctx.persisted === null && !ctx.persistedUnreadable)
    return []
  return buildIscsiWarnings(health)
}
