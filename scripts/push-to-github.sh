#!/usr/bin/env bash
set -euo pipefail

OWNER="${GITHUB_OWNER:-ygc3817922006-sketch}"
REPO="${GITHUB_REPO:-SuperLcm}"
VISIBILITY="${GITHUB_VISIBILITY:-private}"
REMOTE="git@github.com:${OWNER}/${REPO}.git"

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh (GitHub CLI) is not installed" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "error: gh is not authenticated" >&2
  exit 1
fi

if [[ ! -d .git ]]; then
  git init -b main
fi

if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  git add .
  git commit -m "feat: add SuperLcm for DSH"
fi

if gh repo view "${OWNER}/${REPO}" >/dev/null 2>&1; then
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$REMOTE"
  else
    git remote add origin "$REMOTE"
  fi
  git push -u origin main --follow-tags
else
  gh repo create "${OWNER}/${REPO}" "--${VISIBILITY}"
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$REMOTE"
  else
    git remote add origin "$REMOTE"
  fi
  git push -u origin main --follow-tags
fi
