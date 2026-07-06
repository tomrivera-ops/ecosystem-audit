#!/usr/bin/env bash
# roster.sh — multi-org ecosystem enumeration, zero clones on the list pass.
#
#   ./roster.sh list    # enumerate owners -> repos (metadata only)
#   ./roster.sh deep    # shallow-clone in-scope repos + run node inventory
#
# Requires: gh (authenticated), jq, git, node, python3.
# Cross-org auth: set ORG_TOKENS_FILE=/tmp/org-tokens.json (written by workflow).

set -uo pipefail

OWNERS=(
  faraday-platform
  faraday-studio
  faraday-accounting-control-panel-facp
  faraday-build
  faraday-beacon
  faraday-capital-systems
  orbitconsole
  signal-interface
  tomrivera-PSE
  tomrivera-ops
)
# Deliberately EXCLUDED (separate domains):
#   pulse-trading  MARZ-ai  RVCG-Consulting  ESL-Gospel-Connection  tomrivera-dev
# Unmapped products to confirm from roster output: Shield, Neuro Grid

OUT=ecosystem-inventory
mkdir -p "$OUT"
ROSTER="$OUT/_roster.yaml"
REPOLIST="$OUT/_repos.txt"

# Returns installation token for owner, falls back to GH_TOKEN
get_token() {
  local owner="$1"
  if [ -n "${ORG_TOKENS_FILE:-}" ] && [ -f "${ORG_TOKENS_FILE}" ]; then
    local tok
    tok=$(jq -r --arg o "$owner" '.[$o] // empty' "${ORG_TOKENS_FILE}")
    [ -n "$tok" ] && { echo "$tok"; return; }
  fi
  echo "${GH_TOKEN:-}"
}

list() {
  : > "$ROSTER"; : > "$REPOLIST"
  {
    echo "generated_at: \"$(date -u +%FT%TZ)\""
    echo "owners:"
  } >> "$ROSTER"

  local total=0
  for owner in "${OWNERS[@]}"; do
    local tok
    tok=$(get_token "$owner")
    echo "  - owner: $owner" >> "$ROSTER"
    echo "    repos:" >> "$ROSTER"
    if ! GH_TOKEN="$tok" gh repo list "$owner" --limit 200 \
        --json name,description,primaryLanguage,isPrivate,isArchived,pushedAt,url \
        --jq '.[] | "      - name: \(.name)\n        desc: \(.description // \"UNKNOWN\" | @json)\n        lang: \(.primaryLanguage.name // \"UNKNOWN\")\n        private: \(.isPrivate)\n        archived: \(.isArchived)\n        pushed: \(.pushedAt | @json)\n        url: \(.url | @json)"' \
        >> "$ROSTER" 2>/dev/null; then
      echo "      - name: UNKNOWN  # gh repo list failed (perms?) for $owner" >> "$ROSTER"
    fi
    local n
    n=$(GH_TOKEN="$tok" gh repo list "$owner" --limit 200 --json nameWithOwner,isArchived \
        --jq '.[] | select(.isArchived==false) | .nameWithOwner' 2>/dev/null \
        | tee -a "$REPOLIST" | wc -l)
    total=$((total + n))
    printf '  %-45s %s repos\n' "$owner" "$n"
  done
  echo "----"
  echo "Wrote $ROSTER and $REPOLIST"
  echo "Owners: ${#OWNERS[@]}   In-scope repos: $total   Clones: 0"
}

deep() {
  [ -s "$REPOLIST" ] || { echo "run './roster.sh list' first"; exit 1; }
  [ -f ecosystem-discover.js ] || { echo "ecosystem-discover.js not found"; exit 1; }

  # Set up per-org credential rewrites using installation tokens
  if [ -n "${ORG_TOKENS_FILE:-}" ] && [ -f "${ORG_TOKENS_FILE}" ]; then
    echo "Configuring per-org git credentials..."
    for org in $(jq -r 'keys[]' "${ORG_TOKENS_FILE}"); do
      local tok
      tok=$(jq -r --arg o "$org" '.[$o]' "${ORG_TOKENS_FILE}")
      git config --global \
        url."https://x-access-token:${tok}@github.com/${org}/".insteadOf \
        "https://github.com/${org}/"
    done
  elif [ -n "${GH_TOKEN:-}" ]; then
    echo "Falling back to global GH_TOKEN credential rewrite"
    git config --global \
      url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf \
      "https://github.com/"
  fi

  mkdir -p repos
  local cloned=0 skipped=0
  while read -r nwo; do
    [ -z "$nwo" ] && continue
    dest="repos/$(echo "$nwo" | sed 's|/|__|g')"
    if [ -d "$dest" ]; then
      skipped=$((skipped + 1))
      continue
    fi
    if git clone --depth 1 "https://github.com/$nwo.git" "$dest" 2>/dev/null; then
      cloned=$((cloned + 1))
    else
      echo "skip (clone failed): $nwo"
      skipped=$((skipped + 1))
    fi
  done < "$REPOLIST"
  echo "Cloned: $cloned   Skipped/cached: $skipped"
  node ecosystem-discover.js repos
  echo "Deep inventory complete -> $OUT/*.yaml"
}

case "${1:-}" in
  list) list ;;
  deep) deep ;;
  *) echo "usage: $0 {list|deep}"; exit 1 ;;
esac
