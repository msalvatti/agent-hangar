#!/bin/sh
# Creates the deterministic seed repository /repos/sample.git the first time the container starts.
# Fixed author, committer and dates keep the commit SHAs identical on every machine.
set -eu

REPOS="${GIT_PROJECT_ROOT:-/repos}"
BARE="$REPOS/sample.git"

if [ -d "$BARE" ]; then
  echo "seed: $BARE already exists"
  exit 0
fi

mkdir -p "$REPOS"
git init -q --bare --initial-branch=main "$BARE"
git -C "$BARE" config http.receivepack true

WORK="$(mktemp -d)"

GIT_AUTHOR_NAME='E2E Seed'
GIT_AUTHOR_EMAIL='seed@localhost'
GIT_COMMITTER_NAME='E2E Seed'
GIT_COMMITTER_EMAIL='seed@localhost'
GIT_AUTHOR_DATE='2026-01-01T00:00:00Z'
GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
export GIT_AUTHOR_DATE GIT_COMMITTER_DATE

git init -q -b main "$WORK"
mkdir -p "$WORK/src"
printf '# sample\n\nSeed repository for Agent Hangar E2E.\n' >"$WORK/README.md"
printf "console.log('hello from sample');\n" >"$WORK/src/index.js"
printf 'node_modules/\n' >"$WORK/.gitignore"
git -C "$WORK" add -A
git -C "$WORK" commit -q -m 'Add the sample project'
git -C "$WORK" push -q "$BARE" main

git -C "$WORK" checkout -q -b feature/docs
mkdir -p "$WORK/docs"
printf '# Notes\n\nSecond branch of the seed repository.\n' >"$WORK/docs/notes.md"
git -C "$WORK" add -A
git -C "$WORK" commit -q -m 'Add documentation notes'
git -C "$WORK" push -q "$BARE" feature/docs

git -C "$BARE" symbolic-ref HEAD refs/heads/main
git -C "$BARE" update-server-info
rm -rf "$WORK"
echo "seed: created $BARE with branches main and feature/docs"
