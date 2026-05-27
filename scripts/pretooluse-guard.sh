#!/usr/bin/env bash
# scripts/pretooluse-guard.sh — PreToolUse hook for raw `claude -p` (re-adds the
# SDK enable_safety_hooks guard, spec §11 C1). Reads the hook JSON on stdin; exits
# 2 to DENY (Claude Code treats a non-zero PreToolUse hook as a block). Denies:
#  - Bash commands that pipe a download into a shell (curl|sh, wget|sh);
#  - Write/Edit whose target resolves outside the cwd (the worktree).
set -u
payload=$(cat)
tool=$(printf '%s' "$payload" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("tool_name",""))' 2>/dev/null || echo)
case "$tool" in
  Bash)
    cmd=$(printf '%s' "$payload" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null || echo)
    if printf '%s' "$cmd" | grep -Eq '(curl|wget)[^|]*\|[[:space:]]*(ba)?sh'; then
      echo "pretooluse-guard: pipe-to-shell denied" >&2; exit 2
    fi
    ;;
  Write|Edit|MultiEdit|NotebookEdit)
    f=$(printf '%s' "$payload" | python3 -c 'import sys,json;d=json.load(sys.stdin).get("tool_input",{});print(d.get("file_path") or d.get("notebook_path") or "")' 2>/dev/null || echo)
    case "$f" in
      /*) # absolute: must be inside cwd
        case "$f" in "$PWD"/*|"$PWD") : ;; *) echo "pretooluse-guard: write outside worktree denied" >&2; exit 2;; esac ;;
    esac
    ;;
esac
exit 0
