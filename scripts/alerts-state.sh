#!/usr/bin/env bash
# Checkout / commit the `alerts-state` branch that remembers which contracts
# have already been announced.
#
#   scripts/alerts-state.sh pull          → ./_alerts (empty repo on first ever run)
#   scripts/alerts-state.sh push <label>  → commit + push, rebasing onto a
#                                           concurrent push if needed
#
# Unlike stocks-data this branch is NOT force-pushed: stocks.yml and data.yml
# both write to it (stocks.json / indices.json respectively), and a force push
# from one would silently erase the other's state and re-announce everything.
# Ordinary commits of two small JSON files rebase cleanly, and the history
# doubles as an audit log of what was sent when.
set -euo pipefail

BRANCH=alerts-state
DIR=_alerts
URL="${ALERTS_STATE_URL:-https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"

case "${1:-}" in
  pull)
    rm -rf "$DIR"
    if git clone --quiet --depth 1 --branch "$BRANCH" "$URL" "$DIR" 2>/dev/null; then
      echo "alerts-state: $(ls "$DIR"/*.json 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"
    else
      echo "alerts-state branch does not exist yet — first run will arm (one summary message)."
      git init --quiet -b "$BRANCH" "$DIR"
      git -C "$DIR" remote add origin "$URL"
    fi
    ;;
  push)
    cd "$DIR"
    git config user.name "xerxes-bot"
    git config user.email "actions@users.noreply.github.com"
    git add -A
    if git diff --cached --quiet; then
      echo "alerts-state unchanged."
      exit 0
    fi
    git commit --quiet -m "alerts: ${2:-update} [skip ci]"
    for attempt in 1 2 3 4 5; do
      if git push --quiet origin "HEAD:$BRANCH" 2>/dev/null; then
        echo "alerts-state pushed."
        exit 0
      fi
      echo "push rejected (attempt $attempt) — rebasing onto the other workflow's update."
      git fetch --quiet origin "$BRANCH"
      git rebase --quiet FETCH_HEAD
      sleep $((attempt * 2))
    done
    echo "::error::could not push alerts-state; the next run will re-send this run's alerts."
    exit 1
    ;;
  *)
    echo "usage: $0 pull | push <label>" >&2
    exit 2
    ;;
esac
