#!/usr/bin/env bash
# Self-test for pbs-task-log-prune.sh over a fake task tree. No root, no PBS.
# Run: contrib/pbs-task-log-prune/test.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
script="$here/pbs-task-log-prune.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/pbs-prune-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
tasks="$tmp/tasks"
mkdir -p "$tasks/CB" "$tasks/54" "$tasks/FF"

# name, dir, size-bytes, age-days
mk() { local f="$tasks/$2/$1"; head -c "$3" /dev/zero > "$f"; touch -d "$4 days ago" "$f"; }
mk 'UPID:pbs:1:1:1:AAAA0001:backup:ds\x3ahost-a:root@pam:' CB 3000000 45   # old + big  -> delete
mk 'UPID:pbs:1:1:1:AAAA0002:backup:ds\x3ahost-b:root@pam:' 54 5000000 31   # old + big  -> delete
mk 'UPID:pbs:1:1:1:AAAA0003:reader:ds:root@pam:'           FF 2000000 90   # old + big, other type -> delete
mk 'UPID:pbs:1:1:1:AAAA0004:backup:ds\x3ahost-c:root@pam:' CB 3000000 10   # big but recent -> keep
mk 'UPID:pbs:1:1:1:AAAA0005:garbage_collection:ds:root@pam:' 54 4000 400   # old but small -> keep
mk 'UPID:pbs:1:1:1:AAAA0006:backup:ds\x3ahost-d:root@pam:' FF 900000 60    # old but under 1M -> keep
# archive/index/active live beside the subdirs and are never touched, however old or big.
head -c 2000000 /dev/zero > "$tasks/archive"; touch -d '200 days ago' "$tasks/archive"
head -c 2000000 /dev/zero > "$tasks/index";   touch -d '200 days ago' "$tasks/index"
printf 'x' > "$tasks/active"; touch -d '200 days ago' "$tasks/active"
# a stray big old file inside a subdir that is not a UPID -> keep
head -c 3000000 /dev/zero > "$tasks/CB/notes.txt"; touch -d '200 days ago' "$tasks/CB/notes.txt"

fail=0
check() { if [ "$1" = "$2" ]; then echo "ok   $3"; else echo "FAIL $3: expected [$1] got [$2]"; fail=1; fi; }
count() { find "$tasks" -type f | wc -l; }

# 1. dry run changes nothing and names the three candidates
before=$(count)
out=$(TASK_DIR="$tasks" "$script" --dry-run)
check "$before" "$(count)" "dry run deletes nothing"
check "3" "$(grep -c 'UPID:' <<<"$out")" "dry run lists exactly three candidates"
grep -q 'would remove 3 task logs' <<<"$out" || { echo "FAIL dry-run summary line: $out"; fail=1; }

# 2. real run removes exactly the three
out=$(TASK_DIR="$tasks" "$script")
grep -q 'removed 3 task logs' <<<"$out" || { echo "FAIL summary line: $out"; fail=1; }
for f in AAAA0001 AAAA0002 AAAA0003; do
  check "0" "$(find "$tasks" -name "UPID:*$f*" | wc -l)" "$f deleted"
done
for f in AAAA0004 AAAA0005 AAAA0006; do
  check "1" "$(find "$tasks" -name "UPID:*$f*" | wc -l)" "$f kept"
done
check "1" "$(find "$tasks" -maxdepth 1 -name archive | wc -l)" "archive kept"
check "1" "$(find "$tasks" -maxdepth 1 -name index | wc -l)" "index kept"
check "1" "$(find "$tasks" -maxdepth 1 -name active | wc -l)" "active kept"
check "1" "$(find "$tasks" -name notes.txt | wc -l)" "non-UPID file kept"

# 3. knobs: a 0-day age with a 500k floor takes the recent big one and the 900k one too
out=$(TASK_DIR="$tasks" AGE_DAYS=0 MIN_SIZE=500k "$script" --dry-run)
check "2" "$(grep -c 'UPID:' <<<"$out")" "AGE_DAYS=0 MIN_SIZE=500k selects the two remaining big logs"

# 4. refusals: a missing tree and bad knobs exit non-zero without deleting
TASK_DIR="$tmp/nope" "$script" >/dev/null 2>&1 && { echo "FAIL missing tree accepted"; fail=1; } || echo "ok   missing tree refused"
TASK_DIR="$tasks" AGE_DAYS=abc "$script" >/dev/null 2>&1 && { echo "FAIL bad AGE_DAYS accepted"; fail=1; } || echo "ok   bad AGE_DAYS refused"
TASK_DIR="$tasks" MIN_SIZE='1M -o -name x' "$script" >/dev/null 2>&1 && { echo "FAIL bad MIN_SIZE accepted"; fail=1; } || echo "ok   bad MIN_SIZE refused"
TASK_DIR="$tasks" "$script" --bogus >/dev/null 2>&1 && { echo "FAIL unknown flag accepted"; fail=1; } || echo "ok   unknown flag refused"
check "3" "$(find "$tasks" -mindepth 2 -name 'UPID:*' | wc -l)" "refusals deleted nothing"

if [ $fail -eq 0 ]; then echo "ALL OK"; else echo "FAILURES"; exit 1; fi
