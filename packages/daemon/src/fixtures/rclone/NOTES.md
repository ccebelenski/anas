# rclone fixtures — provenance

The "ground truth first" ruling asks every fixture to be labelled **real capture** vs
**synthetic**. Everything in this directory is a real capture: verbatim rclone output
from the stunt node (`anas-pve`, 192.168.200.50 — a disposable PVE 9 VM), never from a
production host and never hand-shaped. No file here has been edited after capture.

The rclone under test throughout is the node's own build:

```
rclone v1.60.1-DEV
- os/version: debian 13.7 (64 bit)
```

Every `dry-run-*` log is **stderr only** (rclone's JSON log and its plain fatal lines
both go to stderr; stdout is empty for all of them). The remote in the sftp captures is
`sftp` pointed at the node's **own sshd** as the `rclonegt` fixture user
(`test/stunt-node/cloud-tasks-fixture.sh`), so no traffic leaves the VM.

## The files

| File | Command | Captured | rclone | What it pins |
|------|---------|----------|--------|--------------|
| `providers-1.60.1.json` | `rclone config providers` | 2026-09-23 (`6dcfa05`, rclone.1) | 1.60.1-DEV | The provider/option schema of 8 backends — the `IsPassword`/`Hide`/`DefaultStr` fields `trimProviders` reads. |
| `dry-run-sync-fresh-1.60.1.log` | `rclone sync <src> gt:<dst> --config /etc/anas/rclone.conf --ask-password=false --use-json-log --stats 30s --stats-log-level NOTICE --dry-run` (empty destination) | 2026-09-24 (`71c7624`, rclone.2 addendum) | 1.60.1-DEV | Three `skipped: copy` objects + a final stats object (transfers 3, bytes 358434, checks 0). A would-be TRANSFER is a `skipped: copy` line and is counted in `stats.transfers`, so the preview never needs the per-file list. |
| `dry-run-sync-delete-1.60.1.log` | same argv, after a file was deleted at the source | 2026-09-24 (`71c7624`) | 1.60.1-DEV | One `skipped: delete` object naming `b.bin` under `object` (destination-relative) + a final stats object (checks 3, deletes 1, transfers 0). The only per-file fact the preview reports. |
| `dry-run-copy-1.60.1.log` | same argv with `copy`, against a complete destination | 2026-09-24 (`71c7624`) | 1.60.1-DEV | Nothing to do — and rclone **still prints its final stats object** (checks 2, transfers 0). This is why a preview that did nothing is never confused with one that failed. |
| `dry-run-auth-fail-1.60.1.log` | `timeout 120 rclone copy /gtbackup/cloudsrc gtbad:dst/fail --config /etc/anas/rclone.conf --ask-password=false --use-json-log --stats 30s --stats-log-level NOTICE --dry-run` (sftp remote with a wrong password), exit **1** | 2026-09-25, by the run that first executed `cloud-tasks-api.spec.ts`'s failing-preview block | 1.60.1-DEV | rclone's **pre-logger** failure: one plain timestamped line, no JSON, no stats object. See below — this capture overturned the shape it replaced. |
| `dry-run-read-error-1.60.1.log` | same base argv, `copy` of a local tree with an **unreadable subdirectory**, run as `nobody`, exit **6** | 2026-09-25, same session | 1.60.1-DEV | rclone's **post-logger** error path: JSON `level: error` objects, a final stats object carrying `errors: 1` and `lastError`, then a plain `Failed to copy:` fatal. |

## What the auth-fail capture overturned

The preview's failure test used to run on a hand-written shape that assumed rclone
reports a config-time failure as a JSON `level: error` object. **It does not.** rclone
1.60.1 fails to build the filesystem *before* its JSON logger is up, so `--use-json-log`
buys nothing on that path and the whole of stderr is one plain line:

```
2026/09/25 05:07:10 Failed to create file system for "gtbad:dst/fail": NewFs: couldn't connect SSH: ssh: handshake failed: read tcp 127.0.0.1:57360->127.0.0.1:22: read: connection reset by peer
```

So `RcloneLogReader.errorLines` stays **empty**, `stats` stays **null**, and the
preview's answer comes from the `rcloneFailureMessage` fallback over `rawLines` — the
exact case `previewErrors` exists for (zero counters with an empty `errors` would be
byte-identical to an honest "nothing to do"). That fallback is now pinned on real
bytes instead of a guess.

`dry-run-read-error-1.60.1.log` is a **separate** fixture for exactly this reason: the
auth failure cannot prove the error-line path, because nothing rclone prints before its
logger starts is JSON. The read-error capture is what proves rclone's own words win
over ANAS's wrapper sentence.

### The tail of the SSH sentence varies per run

Four runs of the identical auth-fail argv, minutes apart against the same sshd, printed
three different tails:

```
… ssh: handshake failed: read tcp 127.0.0.1:32952->127.0.0.1:22: read: connection reset by peer
… ssh: handshake failed: EOF
… ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password], no supported methods remain
```

rclone retries password auth against sshd's own retry budget, and whichever side closes
the connection first decides the wording. **Only the stable prefix is safe to match on**
— `Failed to create file system for "<remote>:<path>": NewFs: couldn't connect SSH:` —
which is what both the unit test and `cloud-tasks-api.spec.ts` assert (`/NewFs|couldn't
connect SSH/`). Nothing should ever pin the tail. The committed file holds the
`connection reset by peer` variant, which is the one the daemon itself recorded for
`anas-cloud-gtfail.service` during the proving run.

## Secrets

Checked at capture time: neither log contains the remote's obscured password or the
plaintext it was built from. The remote NAME (`gtbad`), the `NewFs` line and the paths
are not secrets and are kept verbatim. No transport CR was present in either capture, so
nothing was stripped.
