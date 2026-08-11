#!/usr/bin/env bash
# One-shot setup: verify, seed the database, and publish to a new PRIVATE repo.
#
# Safe to read before running — it creates a repo and pushes, nothing else.
# Re-runnable: if the repo already exists, it just pushes.
set -euo pipefail

REPO_NAME="${1:-xerxes-eod-archive}"
cd "$(dirname "$0")"

echo "==> Node version"
node -e 'const [maj,min]=process.versions.node.split(".").map(Number);
if (maj<22 || (maj===22 && min<13)) { console.error(`need Node >=22.13 for node:sqlite, have ${process.versions.node}`); process.exit(1); }
console.log("    " + process.versions.node + " OK")'

echo "==> Tests"
npm test

echo "==> Seeding xerxes.db with the hand-transcribed backfill"
node scripts/backfill.mjs

echo "==> Coverage"
node scripts/report.mjs

if [ ! -d .git ]; then
  echo "==> git init"
  git init -q -b main
fi
git add -A
git commit -qm "Xerxes EOD archiver" || echo "    (nothing new to commit)"

if command -v gh >/dev/null 2>&1; then
  if gh repo view "$REPO_NAME" >/dev/null 2>&1; then
    echo "==> Repo exists, pushing"
    git push -u origin main
  else
    echo "==> Creating PRIVATE repo $REPO_NAME and pushing"
    gh repo create "$REPO_NAME" --private --source=. --remote=origin --push
  fi
  echo
  echo "==> Set workflow permissions to read+write so the job can commit:"
  echo "    gh api -X PUT repos/{owner}/$REPO_NAME/actions/permissions/workflow \\"
  echo "      -f default_workflow_permissions=write"
else
  cat <<'EOF'
==> gh CLI not found. Create a PRIVATE repo, then:

    git remote add origin git@github.com:<you>/xerxes-eod-archive.git
    git push -u origin main

Then set Settings -> Actions -> General -> Workflow permissions
to "Read and write permissions".
EOF
fi
