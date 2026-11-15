# ACL fixtures — provenance

## Real captures (story cr.37, 2026-10-15)

Captured on the development host (Fedora, `acl` 2.4.0, ext4-family filesystem with POSIX
ACLs) on a scratch directory created for the purpose, mode 0755. Verbatim `getfacl`
stdout, redirected to the file; nothing edited. `-c` omits the `# file/owner/group`
header, so no path or user name of the host is in either file.

| File | Command | State |
|------|---------|-------|
| `getfacl-pcE-dir-no-named.txt` | `getfacl -pcE <dir>` | a fresh directory: base entries only |
| `getfacl-pcE-dir-named-user.txt` | `setfacl -m u:nobody:r-x <dir>` then `getfacl -pcE <dir>` | one named user entry added; `mask::` appears with it |

What they settle for cr.37: an ACL entry added to a directory changes the `getfacl -pcE`
text the set-access plan is computed from (a named line plus the `mask::` line), so the
plan's revision moves and the job refuses STATE_CHANGED instead of running a plan that
would delete the new entry. Both end with a blank line (getfacl's record separator).

## Real capture — the identity scan's `-exec` window (cr3.nodefix review R1, 2026-11-15)

`find-exec-getfacl-ancestor-swap.txt`: on the stunt node (GNU findutils 4.10.0, acl
2.3.2), the identity scan's `find -P <root> -xdev -type d -exec getfacl -n -p -c -E -s {} +
| sort -u`, with the tree changed between find's listing and the getfacl batch (the
header says how). What it settles: an ANCESTOR of a folder carrying an ACL grant swapped
for a symlink to a lookalike tree hides the grant with find exit 0 and nothing on stderr
(the accepted limit, services/access-walk.ts); the same ancestor renamed away with nothing
in its place makes getfacl fail on each vanished path and find exit 1, which the check
reads as a refusal. Paths are the node's scratch tree; nothing was edited below the header.
