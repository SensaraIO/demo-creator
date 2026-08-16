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
