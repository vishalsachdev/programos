#!/usr/bin/env bash
# programos init — scaffold a new ProgramOS curriculum repo and seed it with
# a structured brainstorm prompt for the adopter to hand to their coding agent.
#
# Usage:
#   ./scripts/init.sh <unit-slug> [target-dir]
#
# Example:
#   ./scripts/init.sh ai-ready-uiuc ~/code/ai-ready-uiuc-curriculum
#
# Result: a fresh git repo at <target-dir> containing:
#   - the ProgramOS curriculum-repo skeleton (program/, discussions/, skills/)
#   - a BRAINSTORM.md with a structured discovery prompt
#   - a README pointing at the ProgramOS spec
#
# Agent-agnostic: BRAINSTORM.md is a markdown prompt; paste it into Claude Code,
# Cursor, Codex, or any agent that can read markdown and edit files.

set -euo pipefail

UNIT_SLUG="${1:-}"
TARGET_DIR="${2:-./${UNIT_SLUG}-curriculum}"

if [[ -z "$UNIT_SLUG" ]]; then
  echo "Usage: $0 <unit-slug> [target-dir]" >&2
  echo "  unit-slug: short slug for the program (lowercase, no spaces)" >&2
  exit 1
fi

if [[ -e "$TARGET_DIR" ]]; then
  echo "Error: $TARGET_DIR already exists. Refusing to overwrite." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BRAINSTORM_TEMPLATE="$REPO_ROOT/examples/BRAINSTORM.md"

if [[ ! -f "$BRAINSTORM_TEMPLATE" ]]; then
  echo "Error: brainstorm template not found at $BRAINSTORM_TEMPLATE" >&2
  exit 1
fi

echo "→ Creating $TARGET_DIR"
mkdir -p "$TARGET_DIR"/{program/courses,program/policies,discussions/audit-log,skills}

# Audit-log channel subdirs (mirror SPEC.md §6)
for ch in email telegram teams teams-webhook webchat copilot-studio; do
  mkdir -p "$TARGET_DIR/discussions/audit-log/$ch"
  touch "$TARGET_DIR/discussions/audit-log/$ch/.gitkeep"
done

cat > "$TARGET_DIR/program/CURRICULUM.md" <<EOF
# ${UNIT_SLUG} — Source of truth

<Fill in via brainstorm. See BRAINSTORM.md at the repo root.>
EOF

cat > "$TARGET_DIR/program/EMAIL_ALLOWLIST.md" <<'EOF'
# Email Allowlist

| Email | Name | Role | Decision authority |
|-------|------|------|--------------------|
EOF

cat > "$TARGET_DIR/discussions/DECISIONS.md" <<'EOF'
# Decisions

Append-only log. Newest at top.
EOF

cat > "$TARGET_DIR/discussions/ACTION_ITEMS.md" <<'EOF'
# Open Action Items
EOF

cat > "$TARGET_DIR/discussions/OPEN_QUESTIONS.md" <<'EOF'
# Open Questions
EOF

cat > "$TARGET_DIR/skills/README.md" <<'EOF'
# Skills

Each `*.md` in this directory is a skill the agent reads (in question mode) or
proposes via PR (in status-update mode). See ProgramOS `docs/07-learning-loop.md`
for the contract and skill file format.

Skills accumulate over time. They are reviewed git commits, not autonomous writes.
EOF

cat > "$TARGET_DIR/.gitignore" <<'EOF'
.DS_Store
*.swp
node_modules/
EOF

cat > "$TARGET_DIR/README.md" <<EOF
# ${UNIT_SLUG} curriculum repo

Source of truth for the **${UNIT_SLUG}** program coordinator bot.

This repo is consumed by a ProgramOS deployment (see https://github.com/vishalsachdev/programos).
The bot mounts this repo read-write into agent containers at \`/workspace/extra/${UNIT_SLUG}-curriculum\`.

## Next steps

1. Read **BRAINSTORM.md** and hand it to your coding agent. It will interview you
   and fill in \`program/\`, \`skills/\`, and the channel-specific prompts.
2. Make this repo private before adding any real stakeholder data.
3. Add the bot's git identity as a collaborator with write access.
EOF

# Inject the unit slug into a copy of the brainstorm template.
sed "s/{{UNIT_SLUG}}/${UNIT_SLUG}/g" "$BRAINSTORM_TEMPLATE" > "$TARGET_DIR/BRAINSTORM.md"

(
  cd "$TARGET_DIR"
  git init -q
  git add .
  git commit -q -m "init: scaffold ${UNIT_SLUG} curriculum repo from ProgramOS"
)

echo ""
echo "✓ Scaffolded $TARGET_DIR"
echo ""
echo "Next:"
echo "  cd $TARGET_DIR"
echo "  # Hand BRAINSTORM.md to your coding agent (Claude Code, Cursor, Codex, etc.)"
echo "  # It will interview you and fill in the placeholders."
