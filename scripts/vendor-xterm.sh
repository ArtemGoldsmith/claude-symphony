#!/usr/bin/env bash
# Reproducible vendoring of @xterm/xterm + @xterm/addon-fit into the
# auth-protected /static/ asset tree. Run after every pnpm install on a fresh
# machine or after upgrading either dep.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src/control-plane/web/static/xterm"
SRC_XTERM="$ROOT/node_modules/@xterm/xterm"
SRC_FIT="$ROOT/node_modules/@xterm/addon-fit"

[ -d "$SRC_XTERM" ] || { echo "missing $SRC_XTERM — run 'pnpm install' first" >&2; exit 1; }
[ -d "$SRC_FIT"   ] || { echo "missing $SRC_FIT — run 'pnpm install' first" >&2; exit 1; }

mkdir -p "$DEST"
cp "$SRC_XTERM/lib/xterm.js"   "$DEST/xterm.js"
cp "$SRC_XTERM/css/xterm.css"  "$DEST/xterm.css"
cp "$SRC_FIT/lib/addon-fit.js" "$DEST/addon-fit.js"

echo "vendored xterm + addon-fit + xterm.css → $DEST"
ls -lh "$DEST"
