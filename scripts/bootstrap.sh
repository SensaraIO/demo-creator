#!/usr/bin/env bash
# First-run setup for demo-creator on a new Mac — and the re-sync path on an
# existing one. Idempotent: safe to run repeatedly.
#
#   gh api repos/SensaraIO/demo-creator/contents/scripts/bootstrap.sh \
#     -H "Accept: application/vnd.github.raw" | bash
#
# Works whether or not the repo is already cloned (it clones itself if needed),
# so it can be piped straight from GitHub on a machine that has nothing yet.
set -euo pipefail

REPO_SLUG="SensaraIO/demo-creator"
DEMO_CREATOR="${DEMO_CREATOR:-$HOME/code/demo-creator}"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
die()  { printf "  \033[31m✗\033[0m %s\n" "$1" >&2; exit 1; }
step() { printf "\n\033[1m%s\033[0m\n" "$1"; }

# Homebrew first — a non-interactive SSH shell starts with a bare PATH.
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
[ -x /usr/local/bin/brew ]    && eval "$(/usr/local/bin/brew shellenv)"
export PATH="$HOME/.local/bin:$PATH"

step "1. Host prerequisites"

[ "$(uname -s)" = "Darwin" ] || die "macOS only (iOS Simulator capture)."
ok "macOS $(sw_vers -productVersion)"

command -v brew >/dev/null || die "Homebrew missing. Install from https://brew.sh first."
ok "brew $(brew --version | head -1 | awk '{print $2}')"

if command -v node >/dev/null; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 20 ] || die "Node 20+ required, found $(node -v)."
  ok "node $(node -v)"
else
  warn "node missing — installing"
  brew install node
  ok "node $(node -v)"
fi

for tool in ffmpeg ffprobe; do
  if command -v "$tool" >/dev/null; then
    ok "$tool $("$tool" -version 2>/dev/null | head -1 | awk '{print $3}')"
  else
    warn "$tool missing — installing ffmpeg (this takes a few minutes)"
    brew install ffmpeg
    command -v "$tool" >/dev/null || die "$tool still missing after brew install ffmpeg."
    ok "$tool installed"
  fi
done

if xcrun simctl help >/dev/null 2>&1; then
  ok "xcrun simctl available"
else
  die "xcrun simctl unavailable — install Xcode and run: sudo xcodebuild -runFirstLaunch"
fi

step "2. Repository at $DEMO_CREATOR"

if [ -d "$DEMO_CREATOR/.git" ]; then
  git -C "$DEMO_CREATOR" fetch --quiet origin
  if [ -z "$(git -C "$DEMO_CREATOR" status --porcelain)" ]; then
    git -C "$DEMO_CREATOR" pull --quiet --ff-only origin main && ok "updated to $(git -C "$DEMO_CREATOR" rev-parse --short HEAD)"
  else
    warn "local changes present — skipping pull, leaving working tree alone"
  fi
else
  mkdir -p "$(dirname "$DEMO_CREATOR")"
  if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
    gh repo clone "$REPO_SLUG" "$DEMO_CREATOR" -- --quiet
  else
    git clone --quiet "https://github.com/$REPO_SLUG.git" "$DEMO_CREATOR" \
      || die "clone failed — the repo is private; run 'gh auth login' first."
  fi
  ok "cloned to $DEMO_CREATOR"
fi

step "3. Shell PATH for non-interactive SSH"

# zsh reads .zshrc only for interactive shells, so `ssh host 'cmd'` gets a bare
# PATH and cannot find node/claude. .zshenv is read by every zsh invocation.
if [ -f "$HOME/.zshenv" ] && grep -q 'demo-creator bootstrap' "$HOME/.zshenv" 2>/dev/null; then
  ok ".zshenv already configured"
else
  cat >> "$HOME/.zshenv" <<'ZSHENV'

# --- demo-creator bootstrap: PATH for non-interactive shells ---
# Read by EVERY zsh invocation, unlike .zshrc (interactive-only) and
# .zprofile (login-only) — this is what makes `ssh host 'cmd'` work.
if [ -x /opt/homebrew/bin/brew ]; then
  case ":$PATH:" in
    *":/opt/homebrew/bin:"*) ;;
    *) eval "$(/opt/homebrew/bin/brew shellenv zsh)" ;;
  esac
fi
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
# --- end demo-creator bootstrap ---
ZSHENV
  ok "appended PATH block to ~/.zshenv"
fi

step "4. Claude Code skills"

if [ "${INSTALL_ALL_SKILLS:-0}" = "1" ]; then
  bash "$DEMO_CREATOR/scripts/install-skills.sh"
else
  mkdir -p "$HOME/.claude/skills"
  rm -rf "$HOME/.claude/skills/client-demo"
  cp -R "$DEMO_CREATOR/skills/client-demo" "$HOME/.claude/skills/client-demo"
  ok "installed skill: client-demo"
  warn "other skills in the repo were skipped — re-run with INSTALL_ALL_SKILLS=1 for all"
fi

step "5. doctor"

cd "$DEMO_CREATOR"
node bin/demo-creator.mjs doctor || die "doctor reported problems — resolve before recording."

step "Ready"
cat <<EOF
  repo    $DEMO_CREATOR
  skill   ~/.claude/skills/client-demo/SKILL.md
  usage   export DEMO_CREATOR="$DEMO_CREATOR"
          export DEMO_PROJECTS_DIR=…   # optional; default \$DEMO_CREATOR/projects

  Recording needs a logged-in GUI session (simctl cannot capture at the login
  window). Over SSH, run claude inside that session:
    sudo -n launchctl asuser \$(id -u) sudo -u \$(whoami) ~/.local/bin/claude --print "..."
EOF
