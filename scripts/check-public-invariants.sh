#!/usr/bin/env bash
# scripts/check-public-invariants.sh — fail if any TRACKED file leaks a box/client
# secret or specific (spec §11). Run in CI + as a pre-commit check. Public repo.
#
# Optional deployment-specific deny patterns (client names, real ticket prefixes)
# can be added WITHOUT committing them: put one extended regex per line in the
# untracked file `.public-invariants.local` and/or export PUBLIC_INVARIANTS_EXTRA.
set -u
cd "$(dirname "$0")/.."

# Patterns that must never appear in published files (examples docs use placeholders):
# Tailscale/CGNAT IPs, magic-DNS hosts, home paths, box host names, real issue
# identifiers (TEAM-123 style). Each match is checked as a whole token against
# ALLOW, so only these specific neutral values may appear anywhere (tests included):
# placeholder ticket prefixes, standard-name tokens, and the documented synthetic
# CGNAT fixture address 100.64.0.10, and the discuss e2e magic phrase token.
PATTERNS='100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.[0-9.]*|[A-Za-z0-9.-]*\.ts\.net|/Users/[a-z][A-Za-z0-9._-]*|symphony-box-[0-9a-f]+|\b[A-Z][A-Z0-9]{1,9}-[0-9]+\b'
ALLOW='^(100\.64\.0\.10|HORIZON-7|(ABC|ACME|TEAM|ISO|UTF|SHA|RFC|LICENSE)-[0-9]+)$'

extra="${PUBLIC_INVARIANTS_EXTRA:-}"
if [ -f .public-invariants.local ]; then
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    extra="${extra:+$extra|}$line"
  done < .public-invariants.local
fi

# Every published file: tracked files in a git checkout, else a filesystem walk.
# Only this script (which must spell the patterns) and the local deny file are skipped.
list_files() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files -z
  else
    find . -type d \( -name node_modules -o -name dist -o -name coverage -o -name .git \) -prune \
      -o -type f -print0
  fi | grep -zvE '^(\./)?(scripts/check-public-invariants\.sh|\.public-invariants\.local)$'
}

# -a: scan files with odd bytes as text instead of silently skipping them as binary.
hits=$(list_files | xargs -0 grep -noaE -- "$PATTERNS" 2>/dev/null \
  | awk -v allow="$ALLOW" '{ tok=$0; sub(/^[^:]*:[^:]*:/, "", tok); if (tok !~ allow) print }' || true)
if [ -n "$extra" ]; then
  extra_hits=$(list_files | xargs -0 grep -naE -- "$extra" 2>/dev/null || true)
  hits=$(printf '%s\n%s\n' "$hits" "$extra_hits" | sed '/^$/d')
fi

if [ -n "$hits" ]; then
  printf 'PUBLIC-INVARIANT VIOLATION — box/client specifics or secrets in tracked files:\n%s\n' "$hits" >&2
  exit 1
fi
echo "public invariants OK"
