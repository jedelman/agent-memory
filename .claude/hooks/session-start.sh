#!/usr/bin/env bash
# .claude/hooks/session-start.sh
#
# Runs at the start of every Claude Code session in this repo.
# Loads secrets from `pass`, validates required env, primes context.
#
# Install: add to CLAUDE.md or run manually before starting Claude Code:
#   source .claude/hooks/session-start.sh
#
# Or register as a Claude Code hook in .claude/settings.json if/when
# Claude Code supports PreSession hooks.

set -euo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}◆ agent session bootstrap${NC}"
echo ""

# ---------------------------------------------------------------------------
# 1. Load secrets from pass (or fall back to existing env)
# ---------------------------------------------------------------------------

load_secret() {
  local env_var="$1"
  local pass_path="$2"
  local label="$3"

  if [[ -n "${!env_var:-}" ]]; then
    echo -e "  ${GREEN}✓${NC} ${label} (from env)"
    return 0
  fi

  if command -v pass &>/dev/null; then
    local value
    if value=$(pass show "$pass_path" 2>/dev/null); then
      export "$env_var"="$value"
      echo -e "  ${GREEN}✓${NC} ${label} (from pass)"
      return 0
    fi
  fi

  echo -e "  ${RED}✗${NC} ${label} — not found (set ${env_var} or: pass insert ${pass_path})"
  return 1
}

MISSING=0

load_secret "ANTHROPIC_API_KEY"      "anthropic/api-key"              "Anthropic API key"        || MISSING=$((MISSING+1))
load_secret "ATPROTO_IDENTIFIER"     "atproto/identifier"             "ATProto identifier"       || MISSING=$((MISSING+1))
load_secret "ATPROTO_APP_PASSWORD"   "atproto/app-password"           "ATProto app password"     || MISSING=$((MISSING+1))
load_secret "MEMORY_PROXY_URL"       "cloudflare/memory-proxy-url"    "Memory proxy URL"         || MISSING=$((MISSING+1))
load_secret "MEMORY_PROXY_SECRET"    "cloudflare/memory-proxy-secret" "Memory proxy secret"      || MISSING=$((MISSING+1))

echo ""

if [[ $MISSING -gt 0 ]]; then
  echo -e "${YELLOW}⚠ ${MISSING} secret(s) missing — some features will be unavailable${NC}"
  echo ""
fi

# ---------------------------------------------------------------------------
# 2. Set derived / convenience env vars
# ---------------------------------------------------------------------------

export ATPROTO_HTTP_SERVICE="${ATPROTO_HTTP_SERVICE:-https://bsky.social}"
export AGENT_NAME="${AGENT_NAME:-$(basename "$PWD")}"  # scout-two, claude-agent, etc.
export SESSION_DATE="$(date -u +%Y-%m-%d)"
export SESSION_ID="$(date -u +%Y%m%dT%H%M%S)"

echo -e "  ${GREEN}✓${NC} Agent: ${AGENT_NAME}"
echo -e "  ${GREEN}✓${NC} Session: ${SESSION_ID}"
echo ""

# ---------------------------------------------------------------------------
# 3. Health check memory proxy
# ---------------------------------------------------------------------------

if [[ -n "${MEMORY_PROXY_URL:-}" ]]; then
  echo -e "${CYAN}◆ checking memory proxy...${NC}"
  if curl -sf "${MEMORY_PROXY_URL}/health" -o /dev/null 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} ${MEMORY_PROXY_URL}/health → ok"
  else
    echo -e "  ${YELLOW}⚠${NC} memory proxy unreachable at ${MEMORY_PROXY_URL}"
  fi
  echo ""
fi

# ---------------------------------------------------------------------------
# 4. Pull latest from origin (keep in sync)
# ---------------------------------------------------------------------------

echo -e "${CYAN}◆ syncing repo...${NC}"
if git pull --quiet --ff-only origin "$(git branch --show-current)" 2>/dev/null; then
  echo -e "  ${GREEN}✓${NC} up to date"
else
  echo -e "  ${YELLOW}⚠${NC} fast-forward failed — resolve manually"
fi
echo ""

# ---------------------------------------------------------------------------
# 5. Print session context summary
# ---------------------------------------------------------------------------

echo -e "${CYAN}◆ context${NC}"

# Cursor state
if [[ -f "feed-cursor.json" ]]; then
  NOTIF_CURSOR=$(python3 -c "import json; d=json.load(open('feed-cursor.json')); print(d.get('notifCursor','none')[:20]+'...')" 2>/dev/null || echo "unreadable")
  SAVED_AT=$(python3 -c "import json; d=json.load(open('feed-cursor.json')); print(d.get('savedAt','unknown')[:19])" 2>/dev/null || echo "unknown")
  echo -e "  feed cursor:    ${SAVED_AT}"
fi

# Recent own posts
if [[ -f "scout-posts/latest.json" ]] || [[ -f "own-posts/latest.json" ]]; then
  POSTS_FILE=$(ls scout-posts/latest.json own-posts/latest.json 2>/dev/null | head -1)
  POST_COUNT=$(python3 -c "import json; d=json.load(open('$POSTS_FILE')); print(d.get('postCount',0))" 2>/dev/null || echo "?")
  FETCHED_AT=$(python3 -c "import json; d=json.load(open('$POSTS_FILE')); print(d.get('fetchedAt','?')[:19])" 2>/dev/null || echo "?")
  echo -e "  own posts:      ${POST_COUNT} (as of ${FETCHED_AT})"
fi

# Pending requests
if [[ -f "requests.md" ]]; then
  PENDING=$(grep -c "^\- \*\*\[" requests.md 2>/dev/null || echo "0")
  echo -e "  pending reqs:   ${PENDING}"
fi

echo ""
echo -e "${GREEN}◆ session ready${NC}"
echo ""
