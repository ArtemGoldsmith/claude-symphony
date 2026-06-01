#!/usr/bin/env bash
# scripts/fix-node-pty-perms.sh — restore exec bit on node-pty's spawn-helper
# binaries after `pnpm install`.
#
# Background: pnpm's content-addressed store extracts native prebuilds with
# their mode bits stripped (known issue). node-pty ships `spawn-helper` (a tiny
# unix binary it forkexec's during pty.spawn) and `pty.node` (the .node loader)
# under `prebuilds/<platform>-<arch>/`. Without the exec bit on spawn-helper,
# every `pty.spawn()` fails with `posix_spawnp failed.` (generic message — the
# real cause is EACCES on the helper). This script chmods every prebuilds/*
# spawn-helper it finds — idempotent, platform-agnostic.
#
# Invoked automatically via package.json's `prepare` script after `pnpm install`;
# safe to run by hand any time.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREBUILDS="$ROOT/node_modules/.pnpm/node-pty@"*/node_modules/node-pty/prebuilds

# Glob expansion may be empty if node_modules isn't built yet (fresh clone before
# `pnpm install`). That's fine — exit cleanly so `prepare` doesn't fail.
for base in $PREBUILDS; do
  [ -d "$base" ] || continue
  for helper in "$base"/*/spawn-helper; do
    [ -f "$helper" ] || continue
    chmod +x "$helper"
    echo "chmod +x $helper"
  done
done

# Also handle the non-pnpm (hoisted) node-pty location in case the project is
# installed flat (npm / yarn / bun).
FLAT="$ROOT/node_modules/node-pty/prebuilds"
if [ -d "$FLAT" ]; then
  for helper in "$FLAT"/*/spawn-helper; do
    [ -f "$helper" ] || continue
    chmod +x "$helper"
    echo "chmod +x $helper"
  done
fi
