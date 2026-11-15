#!/usr/bin/env bash
# Fixture capture (cr3.lunrestore.filemark): every argv the daemon issues for a
# file's restore mark, with stdout/stderr byte-exact and the exit status.
# Run ON a stunt node as root:  file-mark-capture.sh <node> <fs-label> <dir> <case-set>   (output: file-mark.<node>.txt; the set-too-long cases, a 64 KiB argv line, were dropped from the committed file)
#   case-set: ordinary | unsupported | readonly | full | toobig
set -u
NODE="$1"; FSL="$2"; D="$3"; SET="$4"
S="$(mktemp -d /root/filemarkgt/cap.XXXX)"
N=trusted.anas.restore
MARK='{"v":1,"repo":"pbs-main","snapshot":"vm/101/2026-11-14T10:00:00Z","archive":"drive-scsi0.img","started":"2026-11-14T10:00:00.000Z","state":"writing"}'
UNV='{"v":1,"repo":"pbs-main","snapshot":"vm/101/2026-11-14T10:00:00Z","archive":"drive-scsi0.img","started":"2026-11-14T10:00:00.000Z","state":"unverified","reason":"/x/lun0.img is 0 bytes, not the image'"'"'s 1048576"}'
hex() { printf '0x'; printf %s "$1" | od -An -tx1 -v | tr -d ' \n'; }
cap() {
  local name="$1"; shift
  printf '### %s %s %s\n' "$NODE" "$FSL" "$name"
  printf '$'; printf ' %q' "$@"; printf '\n'
  "$@" >"$S/o" 2>"$S/e"; local rc=$?
  printf -- '--- stdout %s\n' "$(wc -c <"$S/o")"; cat "$S/o"; printf '\n'
  printf -- '--- stderr %s\n' "$(wc -c <"$S/e")"; cat "$S/e"; printf '\n'
  printf 'EXIT=%s\n' "$rc"
}
f="$D/lun0.img"
case "$SET" in
  ordinary)
    truncate -s 1M "$f"; setfattr -x "$N" -- "$f" 2>/dev/null
    cap read-absent getfattr --absolute-names -e hex -n "$N" -- "$f"
    cap set-writing setfattr -n "$N" -v "$(hex "$MARK")" -- "$f"
    cap read-writing getfattr --absolute-names -e hex -n "$N" -- "$f"
    cap set-unverified setfattr -n "$N" -v "$(hex "$UNV")" -- "$f"
    cap read-unverified getfattr --absolute-names -e hex -n "$N" -- "$f"
    cap remove setfattr -x "$N" -- "$f"
    cap remove-absent setfattr -x "$N" -- "$f"
    cap read-missing-file getfattr --absolute-names -e hex -n "$N" -- "$D/gone.img"
    cap set-missing-file setfattr -n "$N" -v "$(hex "$MARK")" -- "$D/gone.img"
    cap set-empty setfattr -n "$N" -v 0x -- "$f"
    cap read-empty getfattr --absolute-names -e hex -n "$N" -- "$f"
    cap set-odd setfattr -n "$N" -v 0xfffe0a7b -- "$f"
    cap read-odd getfattr --absolute-names -e hex -n "$N" -- "$f"
    cap set-newline setfattr -n "$N" -v 0x7b0a7d -- "$f"
    cap read-newline getfattr --absolute-names -e hex -n "$N" -- "$f"
    setfattr -x "$N" -- "$f"
    cap set-too-long setfattr -n "$N" -v "$(head -c 65537 /dev/zero | tr '\0' a)" -- "$f"
    rm -f "$f" ;;
  unsupported|readonly|full)
    cap "$SET-read" getfattr --absolute-names -e hex -n "$N" -- "$f"
    cap "$SET-set" setfattr -n "$N" -v "$(hex "$MARK")" -- "$f"
    cap "$SET-remove" setfattr -x "$N" -- "$f" ;;
  toobig)
    truncate -s 1M "$f"
    cap toobig-set-4096 setfattr -n "$N" -v "$(head -c 4096 /dev/zero | tr '\0' a)" -- "$f"
    cap toobig-set-4032 setfattr -n "$N" -v "$(head -c 4032 /dev/zero | tr '\0' a)" -- "$f"
    setfattr -x "$N" -- "$f"; rm -f "$f" ;;
esac
rm -rf "$S"
