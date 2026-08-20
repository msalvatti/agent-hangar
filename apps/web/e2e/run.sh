#!/usr/bin/env bash
# Entry point of `pnpm --filter web test:e2e`: brings the stack up, then runs Playwright.
#
# Both steps need Node's `development` export condition: @agent-hangar/core resolves to its
# TypeScript source under that condition and to `dist` otherwise, and every lane works in a fresh
# worktree that has never been built. Playwright has no flag for it, so it travels in NODE_OPTIONS,
# appended rather than assigned so a caller's own options (CI sets a heap size) survive.
set -euo pipefail

export NODE_OPTIONS="${NODE_OPTIONS:-} --conditions=development"

node --import tsx e2e/support/prepare-stack.ts
exec pnpm exec playwright test "$@"
