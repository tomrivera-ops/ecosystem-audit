#!/usr/bin/env bash
# roster.sh — multi-org ecosystem enumeration, zero clones on the list pass.
#
#   ./roster.sh list    # enumerate owners -> repos (metadata only, ~2 API calls/owner)
#   ./roster.sh deep     # shallow-clone in-scope repos + run node inventory
#
# Requires: gh (authenticated), jq, git, node. roster.sh writes ecosystem-inventory/.

set -uo pipefail

# ---- SCOPE: Faraday product ecosystem only. Edit to change. ----
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
# Deliberately EXCLUDED (separate domains — add above only if you truly want them):
#   pulse-trading  MARZ-ai  RVCG-Consulting  ESL-Gospel-Connection  tomrivera-dev
# Unmapped products to confirm from roster output: Shield, Neuro Grid
# ----------------------------------------------------------------

OUT=ecosystem-inventory
mkdir -p "$OUT"
ROSTER="$OUT/_roster.yaml"
REPOLIST="$OUT/_repos.txt"

list() {
  : > "$ROSTER"; : > "$REPOLIST"
  {
    echo "generated_at: \"$(date -u +%FT%TZ)\""
    echo "owners:"
  } >> "$ROSTER"

  local total=0
  for owner in "${OWNERS[@]}"; do
    echo "  - owner: $owner" >> "$ROSTER"
    echo "    repos:" >> "$ROSTER"
    if ! gh repo list "$owner" --limit 200 \
        --json name,description,primaryLanguage,isPrivate,isArchived,pushedAt,url \
        --jq '.[] | "      - name: \(.name)\n        desc: \(.description // "UNKNOWN" | @json)\n        lang: \(.primaryLanguage.name // "UNKNOWN")\n        private: \(.isPrivate)\n        archived: \(.isArchived)\n        pushed: \(.pushedAt | @json)\n        url: \(.url | @json)"' \
        >> "$ROSTER" 2>/dev/null; then
      echo "      - name: UNKNOWN  # gh repo list failed (perms/typo?) for $owner" >> "$ROSTER"
    fi
    local n
    n=$(gh repo list "$owner" --limit 200 --json nameWithOwner,isArchived \
        --jq '.[] | select(.isArchived==false) | .nameWithOwner' 2>/dev/null | tee -a "$REPOLIST" | wc -l)
    total=$((total + n))
    printf '  %-45s %s repos\n' "$owner" "$n"
  done
  echo "----"
  echo "Wrote $ROSTER and $REPOLIST"
  echo "Owners: ${#OWNERS[@]}   In-scope repos: $total   Clones: 0"
  echo "Next: review _roster.yaml (confirm Shield/Neuro Grid appear), then: ./roster.sh deep"
}

deep() {
  [ -s "$REPOLIST" ] || { echo "run './roster.sh list' first"; exit 1; }
  [ -f ecosystem-discover.js ] || { echo "ecosystem-discover.js not found in cwd — drop it in first, then rerun"; exit 1; }
  mkdir -p repos
  while read -r nwo; do
    [ -z "$nwo" ] && continue
    dest="repos/$(echo "$nwo" | sed 's|/|__|g')"
    [ -d "$dest" ] && continue
    git clone --depth 1 "https://github.com/$nwo.git" "$dest" 2>/dev/null \
      || echo "skip (clone failed): $nwo"
  done < "$REPOLIST"
  node ecosystem-discover.js repos
  echo "Deep inventory complete -> $OUT/*.yaml"
}

case "${1:-}" in
  list) list ;;
  deep) deep ;;
  *) echo "usage: $0 {list|deep}"; exit 1 ;;
esac
