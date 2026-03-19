#!/usr/bin/env bash
# .claude/hooks/session-end.sh
#
# Runs when Claude Code session ends (registered as a Stop hook).
# Commits any uncommitted memory/cursor changes with a session log entry.

set -euo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SESSION_ID="${SESSION_ID:-$(date -u +%Y%m%dT%H%M%S)}"
AGENT_NAME="${AGENT_NAME:-$(basename "$PWD")}"

echo ""
echo -e "${CYAN}◆ session end — committing state${NC}"

git config user.email "${GIT_EMAIL:-claude@anthropic.com}"
git config user.name "${GIT_NAME:-Claude}"

# Stage any modified tracked files
git add -u 2>/dev/null || true

# Stage common session outputs if they exist
for f in \
  feed-cursor.json \
  scout-posts/latest.json \
  own-posts/latest.json \
  requests.md \
  memory/*.md \
  annotations/*.md; do
  [[ -f "$f" ]] && git add "$f" 2>/dev/null || true
done

if git diff --staged --quiet; then
  echo -e "  ${YELLOW}nothing to commit${NC}"
else
  git commit -m "chore(session): ${AGENT_NAME} ${SESSION_ID}"
  git push origin "$(git branch --show-current)"
  echo -e "  ${GREEN}✓${NC} committed and pushed"
fi

echo ""
