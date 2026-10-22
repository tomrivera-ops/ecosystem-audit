#!/usr/bin/env bash
# permission-probe.sh <owner> — read-only check that the current GH_TOKEN can read branch
# protection on every non-archived repo it can see for <owner>.
# Exit 0 only if at least one repo is visible and every repo is READABLE. A repo answering
# "Resource not accessible by integration" means the token lacks Administration: read.
# Writes permission-probe.json, plus a markdown table to $GITHUB_STEP_SUMMARY when set.
set -euo pipefail
owner="${1:-}"
[[ "$owner" =~ ^[A-Za-z0-9-]{1,39}$ ]] || { echo "invalid owner: $owner" >&2; exit 2; }

# Installation tokens list their repos via /installation/repositories; fall back to the org listing.
if inst=$(gh api --paginate '/installation/repositories?per_page=100' \
      --jq ".repositories[] | select(.owner.login == \"$owner\" and (.archived | not)) | \"\(.full_name) \(.default_branch)\"" 2>/dev/null); then
  repos="$inst"
else
  repos=$(gh api --paginate "/orgs/$owner/repos?type=all&per_page=100" \
    --jq '.[] | select(.archived | not) | "\(.full_name) \(.default_branch)"')
fi

: > permission-probe.ndjson
fail=0
while read -r full branch; do
  [ -n "$full" ] || continue
  rc=0; body=$(gh api "repos/$full/branches/$branch/protection" 2>&1) || rc=$?
  if [ "$rc" -eq 0 ]; then
    verdict=READABLE; detail="protection returned (200)"
  elif grep -q 'Branch not protected' <<<"$body"; then
    verdict=READABLE; detail="branch not protected (404)"
  elif grep -q 'Upgrade to GitHub' <<<"$body"; then
    if n=$(gh api graphql -F o="${full%/*}" -F n="${full#*/}" \
          -f query='query($o:String!,$n:String!){repository(owner:$o,name:$n){branchProtectionRules{totalCount}}}' \
          --jq '.data.repository.branchProtectionRules.totalCount' 2>/dev/null) && [[ "$n" =~ ^[0-9]+$ ]]; then
      verdict=READABLE; detail="plan-limited REST; GraphQL branchProtectionRules=$n"
    else
      verdict=NOT_EFFECTIVE; detail="plan-limited REST; GraphQL read failed"; fail=1
    fi
  elif grep -q 'Resource not accessible by integration' <<<"$body"; then
    verdict=NOT_EFFECTIVE; detail="403 Resource not accessible by integration"; fail=1
  else
    verdict=UNVERIFIED; detail="$(tr '\n' ' ' <<<"$body" | cut -c1-160)"; fail=1
  fi
  jq -nc --arg repo "$full" --arg verdict "$verdict" --arg detail "$detail" '{repo:$repo,verdict:$verdict,detail:$detail}' >> permission-probe.ndjson
  echo "$verdict  $full  ($detail)"
done <<<"$repos"

count=$(wc -l < permission-probe.ndjson)
effective=$([ "$fail" -eq 0 ] && [ "$count" -gt 0 ] && echo true || echo false)
jq -s --arg owner "$owner" --argjson effective "$effective" \
  '{owner:$owner, repos:length, effective:$effective, results:.}' permission-probe.ndjson > permission-probe.json
rm -f permission-probe.ndjson
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### Permission probe: $owner (effective=$effective)"; echo
    echo "| Repo | Verdict | Detail |"; echo "|---|---|---|"
    jq -r '.results[] | "| \(.repo) | \(.verdict) | \(.detail) |"' permission-probe.json; } >> "$GITHUB_STEP_SUMMARY"
fi
[ "$count" -gt 0 ] || { echo "no repositories visible for $owner: effectiveness cannot be demonstrated" >&2; exit 1; }
exit "$fail"
