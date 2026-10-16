set -u
dpkg-query -W -f='${Package} ${Version}\n' passwd login 2>/dev/null
ldd /usr/sbin/userdel | grep -i econf || echo "userdel: no libeconf linked"
B=/root/w2ldefs; rm -rf $B; mkdir -p $B
run() { P=$B/$1; rm -rf $P; mkdir -p $P/etc
  printf 'root:x:0:0:root:/root:/bin/bash\ncarol:x:1004:1005::/home/carol:/usr/sbin/nologin\n' > $P/etc/passwd
  printf 'root:x:0:\nusers:x:100:\ncarol:x:1005:\n' > $P/etc/group
  printf 'root:!:19000:0:99999:7:::\ncarol:!:19000:0:99999:7:::\n' > $P/etc/shadow
  printf 'root:!::\ncarol:!::\n' > $P/etc/gshadow
  printf '%b' "$2" > $P/etc/login.defs
  userdel -P $P carol >$P/out 2>&1; rc=$?
  after=$(grep -c '^carol:' $P/etc/group)
  printf '%-16s rc=%s group-%s  %s\n' "$1" "$rc" "$([ "$after" -eq 0 ] && echo REMOVED || echo KEPT)" "$(tr '\n' ' ' < $P/out | cut -c1-120)"
}
run plain_yes 'USERGROUPS_ENAB yes\n'
run yes_note 'USERGROUPS_ENAB yes # note\n'
run yes_tab_note 'USERGROUPS_ENAB yes\t# note\n'
run quoted_yes 'USERGROUPS_ENAB "yes"\n'
run quoted_yes_note 'USERGROUPS_ENAB "yes" # note\n'
run yes_hashx 'USERGROUPS_ENAB yes#x\n'
run quoted_mixed 'USERGROUPS_ENAB "yes # not a comment"\n'
run no_note 'USERGROUPS_ENAB no # keep\n'
run plain_no 'USERGROUPS_ENAB no\n'
run absent ''
run comment_only 'USERGROUPS_ENAB # note\n'
run two_lines 'USERGROUPS_ENAB yes\nUSERGROUPS_ENAB no\n'
echo "node login.defs: $(grep -n 'USERGROUPS_ENAB' /etc/login.defs)"
rm -rf $B
