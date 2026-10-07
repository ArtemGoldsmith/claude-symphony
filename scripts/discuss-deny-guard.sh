#!/usr/bin/env bash
# scripts/discuss-deny-guard.sh — PreToolUse hook for the dashboard discuss
# terminal. UNCONDITIONAL block: exits 2 (Claude Code treats exit 2 as a hard
# deny; other non-zero codes are "hook error" and normal permission flow
# continues — that is the load-bearing distinction).
#
# Defense-in-depth alongside the read-only allowlist + --permission-mode dontAsk.
# The settings.json deny list already covers Bash/Edit/Write/etc., and dontAsk
# auto-denies anything not on the allow list; this guard is the safety net for
# future Claude Code semantics changes.
set -u
cat >/dev/null  # drain JSON payload
echo "discuss-mode: tool blocked (read-only chat — Read/Grep/Glob only)" >&2
exit 2
