# PVE `pbs` storage — ground-truth capture (story 16.8)

Captured on the disposable stunt PVE 9 node `192.168.200.50` (`anas-pve`),
2026-07-19, against the local disposable PBS from 16.1 (`:8007`, datastore
`anastest-store`, namespace `anastest`). **The operator's real PBS boxes were
never touched.** These are the exact bytes `pvesm add pbs …` produced; they drive
the tier-1 (PVE-defined repository) parser + read-at-exec-time secret path.

## How the stanzas were created

    FP=cc:b8:a0:…:2c:1d
    # password auth, with a namespace
    pvesm add pbs anastest-pw   --server 127.0.0.1 --datastore anastest-store \
        --username root@pam --password <pw> --fingerprint "$FP" --namespace anastest
    # API-token auth (username carries the !tokenname suffix)
    pvesm add pbs anastest-tok  --server 127.0.0.1 --datastore anastest-store \
        --username 'root@pam!anas-test' --password <token-secret> --fingerprint "$FP"
    # non-default port variant (--port IS supported for pbs)
    pvesm add pbs anastest-port --server 127.0.0.1 --port 8007 --datastore anastest-store \
        --username root@pam --password <pw> --fingerprint "$FP"

All three added with exit 0. `--namespace` and `--port` are both accepted.

## `storage-pbs.cfg` — the resulting stanzas (verbatim)

A `pbs` stanza's keys: `datastore`, `server`, `content` (PVE writes `backup`
automatically), `fingerprint`, optional `namespace`, optional `port`, and
`username`. **There is no `authType` key** — the auth style is inferred from the
username: `root@pam!anas-test` (contains `!`) is API-token auth, plain `root@pam`
is password auth. (This mirrors the 16.1 env contract: PBS_REPOSITORY carries the
`!tokenname` slot, PBS_PASSWORD is the account password OR the token secret.)

## `<id>.pw` — the secret file (`/etc/pve/priv/storage/<id>.pw`)

Dir is `drwx------ root:www-data` (0700), files `-rw------- root:www-data` (0600).
The file is the **bare secret plus a single trailing newline** — nothing else:

    $ od -c /etc/pve/priv/storage/anastest-pw.pw
    0000000   A   n   a   s   P   b   s   T   e   s   t   1   2   3  \n

`anastest-pw.pw` (14-char password → 15 bytes) and `anastest-tok.pw` (36-char
UUID token secret → 37 bytes) are captured here. ANAS reads this file fresh at
exec/test time, strips the single trailing `\n`, and uses the rest verbatim as
`PBS_PASSWORD`. **It is never copied into /etc/anas/creds, never cached in memory
beyond the exec, never returned by the API. ANAS never writes storage.cfg or the
`.pw` file.**

## `pvesm status`

Reports type `pbs`, status `active` for each entry (Total/Used/Available from the
datastore). ANAS does NOT shell `pvesm status` — the storage.cfg parse + the
existing repos Test path are the whole story. (The `datapool` zfs errors in the
capture are unrelated pre-existing node noise — the test pool was gone.)

## Collision / naming rule (16.8)

A tier-1 PVE repo is exposed as **`pve:<storage-id>`**. Because a colon is not a
legal `BackupName` character, a tier-2 (ANAS-registered) repo can never occupy
the `pve:` namespace — so a registered `foo` and a PVE `pbs: foo` coexist
unambiguously as `foo` and `pve:foo`. Mutations on a `pve:` repo → 400
(hands-off); it is usable as a task target and testable.

## Cleanup

`anastest-tok` and `anastest-port` were `pvesm remove`d after capture; one
working password-auth entry (`anastest-pw`) was left for the live-proof and
removed at the end.
