#!/bin/bash
# Unattended curation top-up for cron.
#
# Drains the curation queue (gaps that Symphony auto-enqueued, plus any bootstrap
# topics) by running the Librarian once. Safe to schedule periodically.
#
# Example crontab (hourly), logging to a file:
#   0 * * * * /path/to/symphony-librarian/scripts/curate-cron.sh >> "$HOME/symphony_curate.log" 2>&1
#
# cron runs with a minimal environment, so we set PATH explicitly and rely on the
# user's HOME for the Claude subscription token + Slack/Notion connector auth.

set -euo pipefail

PROJECT_DIR="/path/to/symphony-librarian"
# Tool locations (detected at install time; adjust if your setup differs):
export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Subscription auth only — never let a stray key switch to metered billing.
unset ANTHROPIC_API_KEY

# Single-flight lock so overlapping cron ticks do not run two Librarians at once.
LOCK_DIR="/tmp/symphony-curate.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] curate already running; skipping"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

cd "$PROJECT_DIR"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] draining curation queue"
npm run --silent curate
echo "[$(date '+%Y-%m-%d %H:%M:%S')] done"
