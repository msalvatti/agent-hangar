#!/usr/bin/env bash
# Fails when a lint, type or coverage suppression comment appears in a source or shell file.
#
# Two modes:
#   check-suppressions.sh             scan every tracked source and shell file (the CI gate)
#   check-suppressions.sh FILE...     scan the given files (lint-staged, on every commit)
#
# ESLint cannot stand in for this. A `disable` directive that actually suppresses a rule is not
# reported by ESLint at all, coverage-ignore comments mean nothing to it, and it never looks at
# shell files — so without this gate the pre-commit hook is the only thing enforcing the ban and
# `--no-verify` walks straight past it.
#
# Only tracked files are scanned: dependencies, build output and untracked scratch files are none
# of this gate's business, and `git ls-files` keeps both modes looking at the same set.
#
# Runs on macOS bash 3.2: no mapfile, no associative arrays.
#
# The pattern is assembled from fragments so this file never matches itself.
set -euo pipefail

pattern='eslint-dis''able|@ts-ig''nore|@ts-exp''ect-error|@ts-no''check|istanbul ig''nore|v8 ig''nore'
status=0

# Reports every suppression in one file; sets `status` when it finds any.
scan_file() {
  local file="$1"
  if [ -f "$file" ] && grep -nE "$pattern" "$file"; then
    echo "error: suppression comment found in $file (fix the root cause instead)" >&2
    status=1
  fi
}

if [ "$#" -gt 0 ]; then
  for file in "$@"; do
    scan_file "$file"
  done
else
  # Fed by a here-document rather than a pipe so the loop runs in this shell and `status` survives.
  while IFS= read -r file; do
    [ -n "$file" ] && scan_file "$file"
  done <<EOF
$(git ls-files -- '*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.sh' '*.bash')
EOF
fi

exit "$status"
