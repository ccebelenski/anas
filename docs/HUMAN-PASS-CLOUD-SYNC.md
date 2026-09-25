# Human pass — Cloud Sync (rclone.1–rclone.3)

The operator's hands-on pass over the Cloud Sync menu, run on the stunt node against a real
provider. The automated proofs (`cloud-remotes-api`, `cloud-remotes-ui`, `cloud-tasks-api`,
`cloud-tasks-ui`) use the node's own sshd as the remote; this pass is what covers the two
things they cannot: a real provider's behaviour, and the browser-authorised (OAuth) token flow.

Target: **Google Drive**. It is the OAuth case, so it exercises the one sentence in the Add
remote dialog that tells the user to authorise on a machine with a browser.

## Before you start

1. Main deployed on the stunt node (`test/stunt-node/deploy-anas.sh`), browser hard-reloaded.
2. On this desktop (any rclone version; the token format is stable):

   ```
   rclone authorize "drive"
   ```

   A browser window opens; approve the account. rclone prints the token between two marker
   lines. Copy **only the `{ ... }` JSON block** — not the marker lines around it. The dialog
   now strips the marker lines and one layer of quotes itself and refuses anything that is
   not a JSON object, but pasting only the block is still the clean way.
3. Decide a folder on the Drive for the test (the task's "Path on remote", e.g. `anas-test`).
   Nothing outside that folder is touched, but a `sync` task deletes inside it.

## The pass

Tick each line. "Expected" is what the design promises; anything else is a finding.

### Remotes (rclone.1)

- [ ] Cloud Sync → Remotes… → Add. Type `drive`. **Expected:** the form shows Drive's basic
      options (`client_id`, `client_secret`, `scope`, `token`, …), the OAuth sentence above the
      token field, `Show advanced options` collapsed.
- [ ] Paste the token JSON, leave `client_id`/`client_secret` blank (rclone's built-in client),
      `scope` = `drive`. Test. **Expected:** verdict `ok` in the dialog within a few seconds.
- [ ] Save. **Expected:** job completes, grid lists the remote with `token` among its set keys,
      the footer shows the rclone version and `/etc/anas/rclone.conf`.
- [ ] Edit the remote. **Expected:** the token field is blank and reads "(unchanged)"; Save
      without typing anything; the file on the node is byte-identical
      (`md5sum /etc/anas/rclone.conf` before and after).
- [ ] On the node: `grep token /etc/anas/rclone.conf` shows the token; the API never returns
      it (`GET /v1/cloud/remotes` shows `secretsSet: ["token"]` and no value).

### Tasks (rclone.2 / rclone.3)

- [ ] Create → Source = a ZFS dataset with a few files (pick through Browse…). **Expected:**
      the consistency line reads "backed up from a snapshot"; if the dataset has a child
      dataset, the "Contains N nested filesystems that will not be included" note appears.
- [ ] Remote = the Drive remote, Path = the test folder, Mode `Copy` (the default; the sync
      sentence is shown under Mode), Schedule `daily`, Notify `always`. Save. **Expected:**
      the grid reloads with the new row selected; `systemctl list-timers | grep anas-cloud`
      on the node shows the timer.
- [ ] Run now. **Expected:** the job on the dashboard strip shows bytes/files progress; on
      completion the row's Last run reads success; the files are in the Drive folder.
- [ ] Run now again. **Expected:** completes with nothing transferred (rclone exit 9 is a
      completion, not a failure).
- [ ] Edit → Mode `Sync`. Delete one file from the source dataset. **Preview.** **Expected:**
      the line under Mode names that file under "delete 1 file at the destination".
- [ ] Run now. **Expected:** the file is gone from the Drive folder.
- [ ] Toolbar Preview on the saved task. **Expected:** the display-only window with the same
      summary (nothing to do now).
- [ ] Details. **Expected:** config, `source → remote:path`, the unit and timer text, recent
      runs from journald, labeled recent-only.

### Timeliness and the timer

- [ ] Set the schedule to a minute or two ahead (custom OnCalendar) and wait. **Expected:** the
      run happens; the grid shows it on the next load or the dashboard pull, not before — a
      stale Last run after a run you did not start is by design.
- [ ] Note the first fire of a NEWLY created task: does it run right after creation, before its
      first scheduled time? (Open question from the node runs — see the ruling below.)

### Failure as the user meets it

- [ ] Edit the remote and paste a broken token (change one character). Run now. **Expected:**
      the run fails; the row's Last run is red with rclone's error line as the tooltip; the
      PVE notification arrives (the `anas-cloud` template: task, source → remote:path, mode,
      the error lines); the dashboard shows a `cloud` warning.
- [ ] Fix the token. Run now. **Expected:** success; the warning clears on the next pull.
- [ ] Source on an fstab-configured mount that is not mounted (the Mounts menu can create
      one to an unreachable server). Run now. **Expected:** the run fails with the sentence
      naming the mount; nothing is copied.
- [ ] Empty the source dataset, Mode `Sync`, Run now. **Expected:** refused with the
      empty-source sentence; the Drive folder is untouched. Preview shows the whole folder
      as would-be deletes, in red.

### Copy-back and limits

- [ ] From the node's shell, the footer's sentence: `rclone --config /etc/anas/rclone.conf
      copy <remote>:<path> <directory>`. **Expected:** the files come back. Restore is
      deliberately not in the UI.
- [ ] Bandwidth limit `1M` on the task, Run now on a source with a few MB. **Expected:** the
      progress ETA reflects the cap.
- [ ] Excludes `*.tmp` with a `.tmp` file in the source. **Expected:** it is not transferred.

### Removal

- [ ] Remotes… → Remove the Drive remote while the task exists. **Expected:** refused, the
      task named.
- [ ] Remove the task, then the remote. **Expected:** both gone; no `anas-cloud-*` units left
      on the node; the section is gone from `/etc/anas/rclone.conf`, other sections intact.

## Ruling needed before the pass

The cancelled UI-spec run on 2026-09-24 saw a freshly created `daily` task fire about 12 s
after creation, as user `root`, i.e. from the timer, not from Run now. That reads as
`Persistent=true` catch-up on a timer with no stamp file. Backup shares the unit store, so it
would apply there too. The continuation job confirms the cause; the operator then rules
whether a new task's first fire should wait for its first scheduled time.

## Findings

Record here as they come, one line each, with the step.
