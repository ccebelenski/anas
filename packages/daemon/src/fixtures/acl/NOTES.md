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
