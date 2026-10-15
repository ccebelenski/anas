#!/usr/bin/env bash
# confirmed.sh METHOD PATH [JSON] — challenge, resend with the code, wait for the job (wave-3 node pass).
set -uo pipefail
source "$(dirname "$0")/lib.sh"
confirmed "$@"
[ -n "${CONFIRMED_JOB:-}" ] && wait_job "$CONFIRMED_JOB" "${WAIT_S:-300}"
