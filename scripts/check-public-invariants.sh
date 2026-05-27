#!/usr/bin/env bash
# scripts/check-public-invariants.sh — fail if any TRACKED file leaks a box/Pinley
# secret or specific (spec §11). Run in CI + as a pre-commit check. Public repo.
set -u
# Patterns that must never appear in committed files (examples docs use placeholders).
PATTERNS='100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.|\.ts\.net|/Users/[a-z]|PIN-[0-9]+|symphony-box-[0-9a-f]'
# Search tracked files only; exclude this script, test files (which use PIN-NNN
# fixtures), and the Vault-style detailed plans (not in this repo anyway).
hits=$(git grep -nE "$PATTERNS" -- ':!scripts/check-public-invariants.sh' ':!**/*.test.ts' ':!tests/**' || true)
if [ -n "$hits" ]; then
  printf 'PUBLIC-INVARIANT VIOLATION — box/Pinley specifics or secrets in tracked files:\n%s\n' "$hits" >&2
  exit 1
fi
echo "public invariants OK"
