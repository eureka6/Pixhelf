#!/bin/sh
# Print timings even when a command fails, preserving its exit status.
set -u
timing_label="${1:?Usage: time-command.sh LABEL COMMAND [ARG ...]}"
shift
timing_started=$(date +%s)
printf '[timing] %s: started\n' "$timing_label"
"$@"
timing_status=$?
printf '[timing] %s: %ss (exit %s)\n' "$timing_label" "$(($(date +%s) - timing_started))" "$timing_status"
exit "$timing_status"
