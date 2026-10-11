# Live proof — installer.1: the apt re-apply hook and the preflight refusal are visible (GitHub #74)

Driven 2026-10-11 against the disposable stunt PVE 9 node `anas-pve` (192.168.200.50),
pve-manager `9.2.21`, kernel `7.0.14-20-pve`. Every command below ran on the node and its
output is verbatim; each block is one `ssh root@anas-pve 'bash -s' < script` run, where every
step prints `$ <command>` before its output. One redaction: `ls -l` owner and group columns
(the dev host's account, carried over by rsync) read `<owner> <group>`.

Code under test: the installer.1 worktree at `b6408a1` plus the notification-wording change
committed with this document. It was put on the node twice:

- `./test/stunt-node/deploy-anas.sh` (rsync of the tree to `/opt/anas`, then
  `packages/pve-integration/install.sh`), which writes the new hook line. Sections 0–4 and 7.
- `./packaging/make-release.sh --dev` → `anas-0.4.2+dev.b6408a1.tar.gz` (no tag), copied to
  `/root` and extracted there. Sections 5–6. The preflight refuses before anything is touched,
  so the tarball never installed.

The node also carries the sibling project's (ADOCK) apt hook and proxy-hook block. Both kept
working through every step: its own Post-Invoke line ran in every apt transaction and, at the
end, `index.html.tpl` holds one `adock.js` line and `AnyEvent.pm` one `# >>> ADOCK proxy hook`
block next to ours (issue #20 coexistence, unchanged).

Notifications: the node routes `root@pam` mail to `root@localhost`, which loops on this VM
(postfix bounces it as a forwarding loop). Sections 2–3 therefore show PVE::Notify's own
outcome line (`notified via target`) plus the exact arguments handed to it; section 7 points
`root@pam`'s email at a throwaway local mailbox (`anasmail`) for one failure, reads the
delivered mail, and puts everything back (the method of `LIVE-PROOF-UPGRADE-0.3.1.md`).

## Verdicts

| Question | Verdict |
|---|---|
| `apt-get install --reinstall pve-manager` → hook re-applies, journald start + result, tpl line present | **PROVEN** — §1: `ReapplyStart`, the installer's output, `ReapplyResult RESULT=ok STATUS=0`; `grep -c anas.js` = 1 |
| Installer renamed → journald failure line + PVE notification, apt still succeeds | **PROVEN** — §2: `InstallerMissing`, `RESULT=failed STATUS=127`, `NotifySent`, PVE::Notify `notified via target mail-to-root`; `apt-get exit: 0` |
| Installer present but failing → its ERROR line in journald and in the notification | **PROVEN** — §3 and §7: `anas: ERROR: source dir … not found`, `STATUS=1`; the delivered mail carries the error, the manual fix and the journald tag |
| The notification is rendered by the shipped `anas-integration` template | **PROVEN** — §7: `Subject: ANAS: PVE UI integration could not be re-applied on anas-pve` |
| Node ends healthy | **PROVEN** — §4: re-apply `STATUS=0`, tpl line 1, ANAS proxy block 1, `pveproxy anasd anas` active, `/pve2/js/anas.js` 200; scratch files, mailbox user and email setting restored |
| Extraction with VERSION removed → refusal names the directory and the file, node unmodified | **PROVEN** — §5: `checked: /root/installer1-x/anas-0.4.2+dev.b6408a1`, `missing: VERSION`, the layout and the fix; `/opt/anas` mtime and `/etc/default/anas` checksum unchanged |
| GitHub #74 shape (VERSION + the three hook files) | **PROVEN** — §6: `missing: VERSION, anas-md-event.sh, anas-cache-event.sh, anas-cache.rules` |

Observed on the way, not changed by this story: when `VERSION` is missing, the preflight's
version-transition line reads `reinstall: ANAS unknown (same version)` on a node whose own
`/opt/anas/VERSION` is also absent (a `deploy-anas.sh` node). The refusal follows immediately,
so the line misleads only for the moment it takes to read the next one.

## §0–§4 — the hook (deploy-anas.sh build)

```
### 0. state

$ hostname; pveversion
anas-pve
pve-manager/9.2.21/4f6e0ac86f9e8c7f (running kernel: 7.0.14-20-pve)

$ grep -h Post-Invoke /etc/apt/apt.conf.d/80anas-pve-integration
DPkg::Post-Invoke { "if [ -x /opt/anas/packages/pve-integration/apt-reapply.sh ]; then /opt/anas/packages/pve-integration/apt-reapply.sh || true; fi"; };

$ ls -l /opt/anas/packages/pve-integration/apt-reapply.sh /opt/anas/packages/pve-integration/install.sh
-rwxr-xr-x 1 <owner> <group>  4974 Oct 11 20:50 /opt/anas/packages/pve-integration/apt-reapply.sh
-rwxr-xr-x 1 <owner> <group> 21330 Oct 11 20:43 /opt/anas/packages/pve-integration/install.sh

$ ls /usr/share/pve-manager/templates/default/ | grep anas-integration
anas-integration-body.txt.hbs
anas-integration-subject.txt.hbs

### 1. reinstall pve-manager -> hook re-applies, journald start + result

$ sleep 1; date '+%Y-%m-%d %H:%M:%S' | tee /root/installer1-mark-1
2026-10-11 20:52:11

$ DEBIAN_FRONTEND=noninteractive apt-get install --reinstall -y pve-manager >/root/installer1-apt-1.log 2>&1; echo apt-get exit: $?
apt-get exit: 0

$ journalctl -t anas-pve-integration --since "$(cat /root/installer1-mark-1)" --no-pager -o short-iso
2026-10-11T20:52:17+00:00 anas-pve anas-pve-integration[2280464]: EVENT=ReapplyStart TRIGGER=dpkg-post-invoke INSTALLER=/opt/anas/packages/pve-integration/install.sh
2026-10-11T20:52:18+00:00 anas-pve anas-pve-integration[2280564]: anas: installed /usr/share/pve-manager/js/anas.js (generated from src/)
2026-10-11T20:52:18+00:00 anas-pve anas-pve-integration[2280564]: anas: bundle cache-bust token v=d84ab03a733f
2026-10-11T20:52:18+00:00 anas-pve anas-pve-integration[2280564]: anas: inserted script line into /usr/share/pve-manager/index.html.tpl (?v=d84ab03a733f)
2026-10-11T20:52:18+00:00 anas-pve anas-pve-integration[2280564]: anas: installed /usr/share/anas/perl/AnasProxy.pm
2026-10-11T20:52:18+00:00 anas-pve anas-pve-integration[2280564]: anas: proxy hook already present in /usr/share/perl5/PVE/APIServer/AnyEvent.pm (nothing to do)
2026-10-11T20:52:18+00:00 anas-pve anas-pve-integration[2280564]: anas: installed apt hook /etc/apt/apt.conf.d/80anas-pve-integration
2026-10-11T20:52:18+00:00 anas-pve anas-pve-integration[2280564]: anas: PVE UI integration installed.
2026-10-11T20:52:18+00:00 anas-pve anas-pve-integration[2280565]: EVENT=ReapplyResult RESULT=ok STATUS=0

$ grep -c anas.js /usr/share/pve-manager/index.html.tpl
1

### 2. forced failure A: installer renamed -> journald failure + PVE notification

$ mv /opt/anas/packages/pve-integration/install.sh /opt/anas/packages/pve-integration/install.sh.installer1-off

$ sleep 1; date '+%Y-%m-%d %H:%M:%S' | tee /root/installer1-mark-2
2026-10-11 20:52:19

$ DEBIAN_FRONTEND=noninteractive apt-get install --reinstall -y pve-manager >/root/installer1-apt-2.log 2>&1; echo apt-get exit: $?
apt-get exit: 0

$ journalctl -t anas-pve-integration --since "$(cat /root/installer1-mark-2)" --no-pager -o short-iso
2026-10-11T20:52:26+00:00 anas-pve anas-pve-integration[2280832]: EVENT=ReapplyStart TRIGGER=dpkg-post-invoke INSTALLER=/opt/anas/packages/pve-integration/install.sh
2026-10-11T20:52:26+00:00 anas-pve anas-pve-integration[2280835]: EVENT=InstallerMissing INSTALLER=/opt/anas/packages/pve-integration/install.sh DETAIL=not-found-or-not-executable
2026-10-11T20:52:26+00:00 anas-pve anas-pve-integration[2280836]: EVENT=ReapplyResult RESULT=failed STATUS=127 FIX=/opt/anas/packages/pve-integration/install.sh
2026-10-11T20:52:26+00:00 anas-pve anas-pve-integration[2280843]: EVENT=NotifySent TEMPLATE=anas-integration SEVERITY=warning

$ journalctl --since "$(cat /root/installer1-mark-2)" --no-pager -o short-iso -g 'notified via target'
2026-10-11T20:52:26+00:00 anas-pve perl[2280840]: notified via target `mail-to-root`
2026-10-11T20:52:26+00:00 anas-pve proxmox-mail-forward[2280844]: notified via target `mail-to-root`

$ grep -c anas.js /usr/share/pve-manager/index.html.tpl
0

$ mv /opt/anas/packages/pve-integration/install.sh.installer1-off /opt/anas/packages/pve-integration/install.sh

### 3. forced failure B: installer present but exits 1 (its src/ moved away)

$ mv /opt/anas/packages/pve-integration/src /opt/anas/packages/pve-integration/src.installer1-off

$ sleep 1; date '+%Y-%m-%d %H:%M:%S' | tee /root/installer1-mark-3
2026-10-11 20:52:27

$ DEBIAN_FRONTEND=noninteractive apt-get install --reinstall -y pve-manager >/root/installer1-apt-3.log 2>&1; echo apt-get exit: $?
apt-get exit: 0

$ journalctl -t anas-pve-integration --since "$(cat /root/installer1-mark-3)" --no-pager -o short-iso
2026-10-11T20:52:33+00:00 anas-pve anas-pve-integration[2281131]: EVENT=ReapplyStart TRIGGER=dpkg-post-invoke INSTALLER=/opt/anas/packages/pve-integration/install.sh
2026-10-11T20:52:33+00:00 anas-pve anas-pve-integration[2281138]: anas: ERROR: source dir /opt/anas/packages/pve-integration/src not found
2026-10-11T20:52:33+00:00 anas-pve anas-pve-integration[2281139]: EVENT=ReapplyResult RESULT=failed STATUS=1 FIX=/opt/anas/packages/pve-integration/install.sh
2026-10-11T20:52:34+00:00 anas-pve anas-pve-integration[2281150]: EVENT=NotifySent TEMPLATE=anas-integration SEVERITY=warning

$ journalctl --since "$(cat /root/installer1-mark-3)" --no-pager -o short-iso -g 'notified via target'
2026-10-11T20:52:34+00:00 anas-pve perl[2281146]: notified via target `mail-to-root`
2026-10-11T20:52:34+00:00 anas-pve proxmox-mail-forward[2281149]: notified via target `mail-to-root`

# the exact arguments handed to PVE::Notify for this failure shape: the same
# wrapper run by hand with a pass-through perl shim on PATH (it logs argv, then
# execs the real perl, so the notification is still delivered)

$ mkdir -p /root/installer1-shim && printf '%s\n' '#!/bin/sh' 'for a in "$@"; do printf "ARG: %s\\n" "$a" >> /root/installer1-perl-args.txt; done' 'exec /usr/bin/perl "$@"' > /root/installer1-shim/perl && chmod +x /root/installer1-shim/perl && cat /root/installer1-shim/perl
#!/bin/sh
for a in "$@"; do printf "ARG: %s\\n" "$a" >> /root/installer1-perl-args.txt; done
exec /usr/bin/perl "$@"

$ rm -f /root/installer1-perl-args.txt; PATH=/root/installer1-shim:$PATH /opt/anas/packages/pve-integration/apt-reapply.sh; echo wrapper exit: $?; grep -v '^ARG: -e$' /root/installer1-perl-args.txt
wrapper exit: 0
ARG: use PVE::Notify; use Encode qw(decode); my ($sev, $title, $msg) = map { decode("UTF-8", $_, Encode::FB_DEFAULT) } @ARGV; PVE::Notify::notify($sev, "anas-integration", { title => $title, message => $msg }, { type => "anas-integration" });
ARG: warning
ARG: PVE UI integration could not be re-applied on anas-pve
ARG: After a package upgrade or install on anas-pve, the ANAS PVE UI integration could not be re-applied. The integration installer exited with status 1.

anas: ERROR: source dir /opt/anas/packages/pve-integration/src not found

Until it is re-applied, the ANAS section may be missing from the Proxmox web UI and /anas requests may fail. Proxmox itself is not affected.

To fix, run as root on anas-pve:
  /opt/anas/packages/pve-integration/install.sh

The log of this run: journalctl -t anas-pve-integration

$ mv /opt/anas/packages/pve-integration/src.installer1-off /opt/anas/packages/pve-integration/src

### 4. restore: reinstall pve-manager again -> healthy

$ sleep 1; date '+%Y-%m-%d %H:%M:%S' | tee /root/installer1-mark-4
2026-10-11 20:52:35

$ DEBIAN_FRONTEND=noninteractive apt-get install --reinstall -y pve-manager >/root/installer1-apt-4.log 2>&1; echo apt-get exit: $?
apt-get exit: 0

$ journalctl -t anas-pve-integration --since "$(cat /root/installer1-mark-4)" --no-pager -o short-iso
2026-10-11T20:52:41+00:00 anas-pve anas-pve-integration[2281466]: EVENT=ReapplyStart TRIGGER=dpkg-post-invoke INSTALLER=/opt/anas/packages/pve-integration/install.sh
2026-10-11T20:52:42+00:00 anas-pve anas-pve-integration[2281566]: anas: installed /usr/share/pve-manager/js/anas.js (generated from src/)
2026-10-11T20:52:42+00:00 anas-pve anas-pve-integration[2281566]: anas: bundle cache-bust token v=d84ab03a733f
2026-10-11T20:52:42+00:00 anas-pve anas-pve-integration[2281566]: anas: inserted script line into /usr/share/pve-manager/index.html.tpl (?v=d84ab03a733f)
2026-10-11T20:52:42+00:00 anas-pve anas-pve-integration[2281566]: anas: installed /usr/share/anas/perl/AnasProxy.pm
2026-10-11T20:52:42+00:00 anas-pve anas-pve-integration[2281566]: anas: proxy hook already present in /usr/share/perl5/PVE/APIServer/AnyEvent.pm (nothing to do)
2026-10-11T20:52:42+00:00 anas-pve anas-pve-integration[2281566]: anas: installed apt hook /etc/apt/apt.conf.d/80anas-pve-integration
2026-10-11T20:52:42+00:00 anas-pve anas-pve-integration[2281566]: anas: PVE UI integration installed.
2026-10-11T20:52:42+00:00 anas-pve anas-pve-integration[2281567]: EVENT=ReapplyResult RESULT=ok STATUS=0

$ grep -c anas.js /usr/share/pve-manager/index.html.tpl
1

$ grep -c '# >>> ANAS proxy hook' /usr/share/perl5/PVE/APIServer/AnyEvent.pm
1

$ systemctl is-active pveproxy anasd anas
active
active
active

$ curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1:8006/pve2/js/anas.js
200

$ ls /opt/anas/packages/pve-integration
README.md
apt-reapply.sh
install.sh
perl
src
uninstall.sh

$ rm -rf /root/installer1-shim /root/installer1-perl-args.txt /root/installer1-mark-* /root/installer1-apt-*.log; ls /root | grep -c installer1
0
```

## §5–§6 — the preflight refusal (release tarball)

```
### 5. extraction with VERSION removed -> refusal names the directory and the file

$ rm -rf /root/installer1-x && mkdir /root/installer1-x && tar xzf /root/anas-0.4.2+dev.b6408a1.tar.gz -C /root/installer1-x && ls /root/installer1-x/anas-0.4.2+dev.b6408a1
VERSION
anas-cache-event.sh
anas-cache.rules
anas-md-event.sh
app
install.sh
systemd
templates
uninstall.sh

$ rm /root/installer1-x/anas-0.4.2+dev.b6408a1/VERSION

$ md5sum /opt/anas/VERSION /etc/default/anas; ls -ld /opt/anas
md5sum: /opt/anas/VERSION: No such file or directory
7c879d132d6437aa51c010c236614765  /etc/default/anas
drwxr-xr-x 7 <owner> <group> 4096 Oct 11 20:42 /opt/anas

$ cd /root/installer1-x/anas-0.4.2+dev.b6408a1 && ./install.sh --yes; echo install.sh exit: $?
==> Preflight checks (no changes will be made)...
    reinstall: ANAS unknown (same version)
    PVE node detected: pve-manager/9.2.21/4f6e0ac86f9e8c7f (running kernel: 7.0.14-20-pve)
    Node.js v22.23.3 (>= 20) OK
    ZFS 2.4.4 (>= 2.2) OK
    acl (setfacl) present
    mdadm present
    btrfs-progs (mkfs.btrfs) present
    samba (smbd, smbpasswd) present
    nfs-kernel-server (exportfs) present
    targetcli-fb + python3-rtslib-fb present
    rclone present
    gateway port: 3000 (preserved from /etc/default/anas)
    existing ANAS gateway is listening on :3000 — it will be stopped and upgraded

ERROR: preflight failed — the node was NOT modified:
  - release incomplete: the directory install.sh runs from is not a whole ANAS release.
      checked:  /root/installer1-x/anas-0.4.2+dev.b6408a1
      missing:  VERSION
      expected: install.sh uninstall.sh VERSION anas-md-event.sh anas-cache-event.sh anas-cache.rules app/ systemd/ templates/
      fix:      re-extract the release asset into a fresh, empty directory and run ./install.sh from inside it:
                mkdir anas-fresh && tar xzf anas-<version>.tar.gz -C anas-fresh
                cd anas-fresh/anas-<version> && sudo ./install.sh
install.sh exit: 1

$ md5sum /opt/anas/VERSION /etc/default/anas; ls -ld /opt/anas
md5sum: /opt/anas/VERSION: No such file or directory
7c879d132d6437aa51c010c236614765  /etc/default/anas
drwxr-xr-x 7 <owner> <group> 4096 Oct 11 20:42 /opt/anas

### 6. GitHub #74 shape: VERSION and the three hook files missing

$ rm /root/installer1-x/anas-0.4.2+dev.b6408a1/anas-md-event.sh /root/installer1-x/anas-0.4.2+dev.b6408a1/anas-cache-event.sh /root/installer1-x/anas-0.4.2+dev.b6408a1/anas-cache.rules

$ cd /root/installer1-x/anas-0.4.2+dev.b6408a1 && ./install.sh --yes 2>&1 | sed -n '/preflight failed/,$p'; echo install.sh exit: ${PIPESTATUS[0]}
ERROR: preflight failed — the node was NOT modified:
  - release incomplete: the directory install.sh runs from is not a whole ANAS release.
      checked:  /root/installer1-x/anas-0.4.2+dev.b6408a1
      missing:  VERSION, anas-md-event.sh, anas-cache-event.sh, anas-cache.rules
      expected: install.sh uninstall.sh VERSION anas-md-event.sh anas-cache-event.sh anas-cache.rules app/ systemd/ templates/
      fix:      re-extract the release asset into a fresh, empty directory and run ./install.sh from inside it:
                mkdir anas-fresh && tar xzf anas-<version>.tar.gz -C anas-fresh
                cd anas-fresh/anas-<version> && sudo ./install.sh
install.sh exit: 1

$ rm -rf /root/installer1-x /root/anas-0.4.2+dev.b6408a1.tar.gz; ls /root | grep -c installer1
0
```

## §7 — the delivered notification

```
### 7. the delivered notification, read from a mailbox

$ useradd -M -s /usr/sbin/nologin anasmail && pveum user modify root@pam --email anasmail@localhost && pveum user list --output-format json
[{"email":"anasmail@localhost","enable":1,"expire":0,"realm-type":"pam","userid":"root@pam"}]

$ touch /var/mail/anasmail && chown anasmail:mail /var/mail/anasmail && chmod 0660 /var/mail/anasmail; wc -c < /var/mail/anasmail
0

$ mv /opt/anas/packages/pve-integration/src /opt/anas/packages/pve-integration/src.installer1-off

$ sleep 1; date '+%Y-%m-%d %H:%M:%S' | tee /root/installer1-mark-7
2026-10-11 20:55:02

$ DEBIAN_FRONTEND=noninteractive apt-get install --reinstall -y pve-manager >/root/installer1-apt-7.log 2>&1; echo apt-get exit: $?
apt-get exit: 0

$ journalctl -t anas-pve-integration --since "$(cat /root/installer1-mark-7)" --no-pager -o short-iso
2026-10-11T20:55:08+00:00 anas-pve anas-pve-integration[2284203]: EVENT=ReapplyStart TRIGGER=dpkg-post-invoke INSTALLER=/opt/anas/packages/pve-integration/install.sh
2026-10-11T20:55:08+00:00 anas-pve anas-pve-integration[2284210]: anas: ERROR: source dir /opt/anas/packages/pve-integration/src not found
2026-10-11T20:55:08+00:00 anas-pve anas-pve-integration[2284211]: EVENT=ReapplyResult RESULT=failed STATUS=1 FIX=/opt/anas/packages/pve-integration/install.sh
2026-10-11T20:55:09+00:00 anas-pve anas-pve-integration[2284221]: EVENT=NotifySent TEMPLATE=anas-integration SEVERITY=warning

$ sleep 3; grep -E '^(Subject|From|To):' /var/mail/anasmail; echo; awk '/^Content-Type: text\/plain/ {p=1} p && /^--/ {exit} p' /var/mail/anasmail
Subject: ANAS: PVE UI integration could not be re-applied on anas-pve 
From: Proxmox VE <root@anas-pve.local>
To: anasmail@localhost

Content-Type: text/plain;
	charset="UTF-8"
Content-Transfer-Encoding: 7bit

After a package upgrade or install on anas-pve, the ANAS PVE UI integration could not be re-applied. The integration installer exited with status 1.

anas: ERROR: source dir /opt/anas/packages/pve-integration/src not found

Until it is re-applied, the ANAS section may be missing from the Proxmox web UI and /anas requests may fail. Proxmox itself is not affected.

To fix, run as root on anas-pve:
  /opt/anas/packages/pve-integration/install.sh

The log of this run: journalctl -t anas-pve-integration


$ mv /opt/anas/packages/pve-integration/src.installer1-off /opt/anas/packages/pve-integration/src

$ sleep 1; DEBIAN_FRONTEND=noninteractive apt-get install --reinstall -y pve-manager >/root/installer1-apt-8.log 2>&1; echo apt-get exit: $?; journalctl -t anas-pve-integration -n 1 --no-pager -o cat; grep -c anas.js /usr/share/pve-manager/index.html.tpl
apt-get exit: 0
EVENT=ReapplyResult RESULT=ok STATUS=0
1

$ pveum user modify root@pam --email root@localhost && userdel anasmail && rm -f /var/mail/anasmail /root/installer1-mark-7 /root/installer1-apt-7.log /root/installer1-apt-8.log && pveum user list --output-format json; id anasmail; ls /opt/anas/packages/pve-integration
[{"email":"root@localhost","enable":1,"expire":0,"realm-type":"pam","userid":"root@pam"}]
id: ‘anasmail’: no such user
README.md
apt-reapply.sh
install.sh
perl
src
uninstall.sh
```

## Left behind

Nothing. The scratch files under `/root` were removed (each section's last command counts
them: 0), `root@pam`'s email is `root@localhost` again, the `anasmail` user and mailbox are
gone, `/opt/anas/packages/pve-integration` holds its six entries, and the last hook run on the
node reads `EVENT=ReapplyResult RESULT=ok STATUS=0`.
