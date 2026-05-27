#!/usr/bin/env bash
# scripts/run-wrapper.sh — restart-safe dispatch wrapper for the control plane.
#
# Spawned DETACHED by the process manager (Node `spawn(..., {detached:true})`
# starts a new session, so this script's pid is its own process-group leader =
# PGID). It records <runId>.pid (PGID + kernel start-time token, NOT wall-clock,
# so PID reuse cannot be mistaken for liveness), then runs the command (argv
# form — no eval/word-splitting), and on completion writes an atomic
# <runId>.exit.json. Authoritative + restart-safe: if the daemon dies, the
# wrapper keeps running and still writes exit.json.
#
# Usage:
#   run-wrapper.sh <stateDir> <runId> <kind> <attemptId> <logRelPath> -- <cmd> [args...]
set -u

SD=$1; RID=$2; KIND=$3; AID=$4; LOGREL=$5
shift 5
[ "${1:-}" = "--" ] && shift
[ "$#" -eq 0 ] && { echo "run-wrapper: no command given" >&2; exit 2; }

LOG="$SD/$LOGREL"

# $$ is this wrapper's pid; detached => it is the process-group leader (PGID).
# lstart is the kernel process-start time; squeeze spaces + trim so the token
# round-trips through a single line. PID + this token defeats PID reuse.
START_TOKEN=$(ps -o lstart= -p "$$" 2>/dev/null | tr -s ' ' | sed 's/^ *//; s/ *$//')
printf '%s %s\n' "$$" "$START_TOKEN" > "$SD/$RID.pid"

# Run the real command in the SAME process group (no nested setsid), so
# `kill -- -$$` (PGID) reaches both the wrapper and the command tree.
"$@" > "$LOG" 2>&1 &
child=$!
wait "$child"
code=$?

TMP="$SD/$RID.exit.json.tmp.$$"
printf '{"runId":"%s","attemptId":%d,"kind":"%s","exitCode":%d,"finishedAt":%d}\n' \
  "$RID" "$AID" "$KIND" "$code" "$(date +%s)" > "$TMP"
mv "$TMP" "$SD/$RID.exit.json"
exit "$code"
