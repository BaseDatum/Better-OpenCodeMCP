#!/bin/sh
# git-credential-dialogue — custom git credential helper for Dialogue.
#
# Called by git when it needs HTTPS credentials.  Fetches a fresh
# GitHub App installation token from the github-token-service on
# every invocation so that long-running processes always get a valid
# (non-expired) token.
#
# Required environment variables:
#   __OPENCODE_USER_ID            — the Dialogue user UUID
#   __OPENCODE_GITHUB_TOKEN_URL   — base URL of the git-token endpoint
#                                   (e.g. http://github-token-service:8013)
#
# Git credential helper protocol:
#   - git calls us with "get" as the first argument
#   - sends protocol/host/path on stdin (key=value lines, blank-terminated)
#   - we respond with username/password on stdout (same format)
#
# We only respond for github.com HTTPS requests; all others are ignored
# so git falls through to other configured helpers.

set -e

# Only handle "get" requests — "store" and "erase" are no-ops.
case "$1" in
    get) ;;
    *)   exit 0 ;;
esac

# Read the credential request from stdin.
protocol=""
host=""
while IFS='=' read -r key value; do
    case "$key" in
        protocol) protocol="$value" ;;
        host)     host="$value" ;;
        "")       break ;;
    esac
done

# Only provide credentials for github.com over HTTPS.
if [ "$protocol" != "https" ] || [ "$host" != "github.com" ]; then
    exit 0
fi

# Bail out if required env vars are missing.
if [ -z "$__OPENCODE_USER_ID" ] || [ -z "$__OPENCODE_GITHUB_TOKEN_URL" ]; then
    exit 0
fi

# Fetch a fresh token from the github-token-service.
# --fail-with-body: exit non-zero on HTTP errors.
# --silent: no progress output on stderr (would confuse git).
# --max-time 10: don't hang forever if the service is down.
token=$(curl --fail --silent --max-time 10 \
    -H "X-Dialogue-User-Id: ${__OPENCODE_USER_ID}" \
    "${__OPENCODE_GITHUB_TOKEN_URL}/git-token" 2>/dev/null) || exit 0

# If we got an empty response, bail.
if [ -z "$token" ]; then
    exit 0
fi

# Return credentials in git's expected format.
# "x-access-token" is the conventional username for GitHub App tokens.
printf 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=%s\n\n' "$token"
