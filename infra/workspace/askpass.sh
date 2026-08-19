#!/bin/sh
# GIT_ASKPASS helper: git calls this once for the username and once for the password when it
# needs HTTPS credentials. The token therefore never appears in the remote URL, the shell
# environment of tool subprocesses, or the command line.
case "$1" in
  *Username*|*username*) printf '%s\n' "x-access-token" ;;
  *) printf '%s\n' "${GITHUB_TOKEN:-}" ;;
esac
