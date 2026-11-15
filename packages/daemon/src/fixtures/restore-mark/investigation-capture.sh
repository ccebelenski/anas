#!/usr/bin/env bash
# Ground truth for cr3.lunrestore.filemark — run ON a stunt node as root:
#   investigation-capture.sh <label> <dir>   (output: investigation.<node>.txt)
# <dir> is a scratch directory on the filesystem under test (created/removed by the caller).
set -u
LABEL="$1"; D="$2"
S="$D/.cap"; mkdir -p "$S"
N=trusted.anas.restore
MARK='{"v":1,"repo":"pbs-main","snapshot":"vm/101/2026-11-14T10:00:00Z","archive":"drive-scsi0.img","started":"2026-11-14T10:00:00.000Z","state":"writing"}'
HEX=0x$(printf %s "$MARK" | od -An -tx1 -v | tr -d ' \n')

run() {
  printf '$ '; printf '%q ' "$@"; echo
  "$@" >"$S/o" 2>"$S/e"; local rc=$?
  printf 'stdout(%s bytes): ' "$(wc -c <"$S/o")"; cat -v "$S/o"; echo '<EOT>'
  printf 'stderr: '; cat -v "$S/e"; echo '<EOT>'
  echo "exit=$rc"
}
asuser() { setpriv --reuid=nobody --regid=nogroup --clear-groups -- "$@"; }

echo "################ $LABEL  dir=$D  fs=$(findmnt -n -o FSTYPE --target "$D") src=$(findmnt -n -o SOURCE --target "$D")"
f="$D/img.raw"
truncate -s 4M "$f"; chmod 0666 "$f"; chmod 0755 "$D"

echo "== 1. namespaces"
for ns in trusted user; do
  n="$ns.anas.restore"
  echo "-- $n set (root)"; run setfattr -n "$n" -v "$HEX" -- "$f"
  echo "-- $n read --only-values (root)"; run getfattr --only-values -n "$n" -- "$f"
  echo "-- $n read -e hex (root)"; run getfattr -e hex -n "$n" -- "$f"
  echo "-- $n read --only-values -e hex (root)"; run getfattr --only-values -e hex -n "$n" -- "$f"
  echo "-- $n read as nobody"; run asuser getfattr --only-values -n "$n" -- "$f"
  echo "-- $n dump all as nobody"; run asuser getfattr -d -m - -- "$f"
  echo "-- $n set as nobody (file is 0666)"; run asuser setfattr -n "$n" -v 0x41 -- "$f"
  echo "-- $n remove as nobody"; run asuser setfattr -x "$n" -- "$f"
  echo "-- $n remove (root)"; run setfattr -x "$n" -- "$f"
  echo "-- $n remove absent (root)"; run setfattr -x "$n" -- "$f"
  echo "-- $n read absent (root)"; run getfattr --only-values -n "$n" -- "$f"
done
echo "-- read on a missing file"; run getfattr --only-values -n "$N" -- "$D/no-such.img"
echo "-- set on a missing file"; run setfattr -n "$N" -v "$HEX" -- "$D/no-such.img"
echo "-- remove on a missing file"; run setfattr -x "$N" -- "$D/no-such.img"
echo "-- read of a path that is a directory component missing"; run getfattr --only-values -n "$N" -- "$D/nodir/x.img"
echo "-- text value (JSON as given, no 0x)"; run setfattr -n "$N" -v "$MARK" -- "$f"; run getfattr --only-values -n "$N" -- "$f"
echo "-- value starting 0s (base64 trap)"; run setfattr -n "$N" -v '0sQUJD' -- "$f"; run getfattr --only-values -n "$N" -- "$f"
echo "-- value with a newline, via hex"; run setfattr -n "$N" -v 0x7b0a7d -- "$f"; run getfattr --only-values -n "$N" -- "$f"; run getfattr -e hex -n "$N" -- "$f"
echo "-- empty value"; run setfattr -n "$N" -v '' -- "$f"; run getfattr --only-values -n "$N" -- "$f"; run getfattr -e hex -n "$N" -- "$f"
run setfattr -x "$N" -- "$f"
echo "-- read on a fifo / dir"; run getfattr --only-values -n "$N" -- "$D"

echo "== 2. survives the restore's open"
run setfattr -n "$N" -v "$HEX" -- "$f"
echo "inode before: $(stat -c %i "$f") size $(stat -c %s "$f")"
echo "-- node fs.createWriteStream(path, {flags:'w'}) then 4 MiB written, the restore's open"
node -e 'const fs=require("fs");const w=fs.createWriteStream(process.argv[1],{flags:"w"});w.on("open",()=>{w.write(Buffer.alloc(4194304,7));w.end()});w.on("finish",()=>console.log("written"))' "$f"
echo "inode after: $(stat -c %i "$f") size $(stat -c %s "$f")"
run getfattr --only-values -n "$N" -- "$f"
echo "-- emptied only (open 'w' and close: the simulated interruption)"
node -e 'require("fs").closeSync(require("fs").openSync(process.argv[1],"w"))' "$f"
echo "size $(stat -c %s "$f")"; run getfattr --only-values -n "$N" -- "$f"
echo "-- truncate -s 4M"; run truncate -s 4194304 "$f"; echo "size $(stat -c %s "$f")"; run getfattr --only-values -n "$N" -- "$f"
echo "-- dd full overwrite (O_TRUNC)"; dd if=/dev/urandom of="$f" bs=1M count=4 status=none; run getfattr --only-values -n "$N" -- "$f"

echo "== 5. value sizes (trusted.)"
for n in 1400 4000 4096 8000 65536 65537; do
  head -c "$n" /dev/zero | tr '\0' 'a' >"$S/v"
  printf -- '-- %s bytes: ' "$n"
  if setfattr -n "$N" -v "$(cat "$S/v")" -- "$f" 2>"$S/e"; then
    got=$(getfattr --only-values -n "$N" -- "$f" 2>/dev/null | wc -c); echo "set ok, read back $got bytes"
  else
    echo "set FAILED: $(cat "$S/e")"
  fi
done
run setfattr -x "$N" -- "$f"
echo "== 4a. travel (same filesystem)"
run setfattr -n "$N" -v "$HEX" -- "$f"
cp "$f" "$D/cp-default.raw"; echo "cp default: $(getfattr --only-values -n "$N" -- "$D/cp-default.raw" 2>&1 | head -c 80)"
cp -a "$f" "$D/cp-a.raw"; echo "cp -a: $(getfattr --only-values -n "$N" -- "$D/cp-a.raw" 2>&1 | head -c 80)"
cp --preserve=all "$f" "$D/cp-pall.raw"; echo "cp --preserve=all: $(getfattr --only-values -n "$N" -- "$D/cp-pall.raw" 2>&1 | head -c 80)"
rsync "$f" "$D/rsync-default.raw"; echo "rsync default: $(getfattr --only-values -n "$N" -- "$D/rsync-default.raw" 2>&1 | head -c 80)"
rsync -aX "$f" "$D/rsync-aX.raw"; echo "rsync -aX: $(getfattr --only-values -n "$N" -- "$D/rsync-aX.raw" 2>&1 | head -c 80)"
cp -a "$f" "$D/mv-src.raw"; mv "$D/mv-src.raw" "$D/mv-same.raw"; echo "mv same fs: $(getfattr --only-values -n "$N" -- "$D/mv-same.raw" 2>&1 | head -c 80)"
rm -f "$D"/cp-*.raw "$D"/rsync-*.raw "$D"/mv-*.raw
rm -rf "$S"
