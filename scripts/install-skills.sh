#!/usr/bin/env bash
# Install (or re-sync) this repo's Claude Code skills into ~/.claude/skills.
# Run once after cloning on a new machine, and again after pulling skill changes.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/.claude/skills"
mkdir -p "$DEST"

for skill_dir in "$REPO_DIR"/skills/*/; do
  name="$(basename "$skill_dir")"
  rm -rf "${DEST:?}/$name"
  cp -R "$skill_dir" "$DEST/$name"
  echo "installed skill: $name -> $DEST/$name"
done

echo
echo "Note: the client-demo skill references this repo at /Users/cheshire/code/demo-creator."
echo "If this machine keeps the repo elsewhere, update the paths in $DEST/client-demo/SKILL.md."
