# Owner register

## Owner register

Each fact has one owner (Principle 16). This section lists the owners that exist. An area that is not listed has no owner yet.

### /etc/fstab

| Question | Who answers it |
|---|---|
| Which file is it, and what does it mean when it cannot be read? | `services/fstab-file.ts` |
| What does the text say, which line belongs to a mountpoint, and how is the text changed? | `parsers/fstab.ts` |
| How is a config file written safely? | `editConfig` in `services/config-writer.ts` |
| Are `/mnt/x` and `/mnt/x/` the same path? | `sameConfigPath` in the shared package |

Rules for everything else in the daemon:

- Read the file through the file owner, never directly.
- Ask about the text, and change it, only through the parser.
- Write only through `editConfig`.
- A caller keeps its own sentences, and may keep its own answer for a missing file. AHR does: it treats a missing fstab as unreadable, so a pool is never remounted on defaults.

Enforced by `fstab-owners.test.ts`, which fails the suite when code outside an owner reads the file, picks its path, scans it for a line, or rewrites it.
