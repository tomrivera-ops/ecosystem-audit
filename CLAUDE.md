# CLAUDE.md

Operating rules for AI assistants (Claude Code / Codex) working in this repo.

## Purpose

ecosystem-audit is the fleet-wide drift-detection gate. It observes repos across the Faraday fleet; it never modifies them. Read README.md before making changes.

## Stack

- Node.js 20 — `ecosystem-discover.js`, `coupling-scan.js`, `drift-gate.js`
- Bash — `roster.sh` (enumeration + cloning)
- Python 3 + PyJWT — per-org token generation (in the workflow)
- GitHub Actions — `.github/workflows/ecosystem-drift-gate.yml`

## Key files

- `roster.sh` — `list` (metadata, zero clones) and `deep` (clone + inventory). Reads `ORG_TOKENS_FILE` for per-org auth.
- `ecosystem-inventory/drift-policy.json` — accepted baseline. Do not edit by hand; use `node drift-gate.js repos --update-baseline`.
- `docs/adr/ADR-0001-fleet-migration-triggers.md` — fleet enrollment criteria.
- `.github/workflows/ecosystem-drift-gate.yml` — the pipeline.

## Auth — do not break this

- App `faraday-ci-bot` (ID 4216577). Secrets are **org-level only** (`tomrivera-ops`, visibility ALL). Do not add repo-level secret copies — they were intentionally removed.
- Tokens are minted **per-org at runtime**. Never collapse this back to a single-org token — that reintroduces the private-repo blind spot (only 12 of 39 repos visible).
- `roster.sh` must use per-owner tokens for both `gh repo list` and `git clone`. The `git config url.insteadOf` rewrites are per-org, not global.

## Safe changes

- Adding an owner to `OWNERS=()` in `roster.sh` (must be an org the app is installed on)
- Documentation
- Baseline updates via `node drift-gate.js repos --update-baseline`, through a PR

## Unsafe — require explicit instruction

- Any change to the token-generation step or `ORG_TOKENS_FILE` handling
- Editing `ecosystem-inventory/drift-policy.json` by hand
- Changing the cron schedule
- Anything touching `enforce_admins` or branch protection

## Do not touch

- Secrets (they live in the org, not here)
- The per-org credential rewrite loop in `roster.sh deep`

## PR workflow

`main` is protected with `enforce_admins: true`. No direct pushes — everything is a PR merged via `faraday-ci-bot`:

```bash
gh workflow run 307201282 -f owner=tomrivera-ops \
  -f repo=tomrivera-ops/ecosystem-audit -f pr_number=<N> \
  -f merge_method=squash --repo tomrivera-ops/.github
```
