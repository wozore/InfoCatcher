#!/bin/bash
# .claude/hooks/files-edit-check.sh
# PreToolUse hook — blocks Write/Edit/MultiEdit on project files
# until the files-edit-check skill workflow completes.

INPUT=$(cat)

# Derive project root from script location
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." 2>/dev/null && pwd)"
[ -z "$PROJECT_DIR" ] && PROJECT_DIR="$PWD"

# Extract file_path from JSON input
FILE_PATH=""
if command -v python3 &>/dev/null; then
  FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))")
elif command -v python &>/dev/null; then
  FILE_PATH=$(echo "$INPUT" | python -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))")
elif command -v jq &>/dev/null; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
fi

[ -z "$FILE_PATH" ] && exit 0

# Normalize paths
FILE_PATH="${FILE_PATH//\/\/}"
PROJECT_DIR="${PROJECT_DIR//\/\/}"

# Convert Git Bash paths (/c/Users) to Windows-style (c:/Users)
if [[ "$PROJECT_DIR" =~ ^/([a-zA-Z])/(.+) ]]; then
  PROJECT_DIR="${BASH_REMATCH[1]}:/${BASH_REMATCH[2]}"
fi
if [[ "$FILE_PATH" =~ ^/([a-zA-Z])/(.+) ]]; then
  FILE_PATH="${BASH_REMATCH[1]}:/${BASH_REMATCH[2]}"
fi

# Block project file operations
case "$FILE_PATH" in
  "${PROJECT_DIR}"*)
    printf '%s\n' \
      '⛔ 文件操作被阻止' \
      '' \
      '直接修改项目文件前，必须先执行 files-edit-check 流程：' \
      '  1. 触发 Skill: files-edit-check（或运行 /files-edit-check）' \
      '  2. 列出文件清单 → 用户确认' \
      '  3. 确认后使用 Bash (echo/cat/printf) 写入文件' \
      '' \
      "目标文件: ${FILE_PATH}" >&2
    exit 2
    ;;
esac

exit 0
