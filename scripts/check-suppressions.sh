#!/usr/bin/env bash
# Fails when any given file contains a lint/type/coverage suppression comment.
# Used by lint-staged on every commit; the same rule is enforced in CI.
# The pattern is assembled from fragments so this file never matches itself.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  exit 0
fi

pattern='eslint-dis''able|@ts-ig''nore|@ts-exp''ect-error|@ts-no''check|istanbul ig''nore|v8 ig''nore'
status=0

for file in "$@"; do
  if [ -f "$file" ] && grep -nE "$pattern" "$file"; then
    echo "error: suppression comment found in $file (fix the root cause instead)" >&2
    status=1
  fi
done

exit "$status"
