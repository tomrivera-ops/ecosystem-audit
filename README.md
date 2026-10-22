# ecosystem-audit

Nightly drift-detection gate across the Faraday fleet. Enumerates repos across in-scope owners, shallow-clones them, runs coupling and drift analysis, and fails CI when new drift exceeds an accepted baseline.

Supersedes [`dev-audit`](https://github.com/tomrivera-ops/dev-audit) (archived 2026-07-05).

## How it fits the system

This is the fleet-wide governance gate. It does not modify repos — it observes them. Enrollment criteria are defined in [ADR-0001](docs/adr/ADR-0001-fleet-migration-triggers.md). PR approvals/merges across the fleet are handled by the `faraday-ci-bot` GitHub App via the `cli-approve-merge` workflow in `tomrivera-ops/.github`.

## Auth model

- GitHub App `faraday-ci-bot` (ID 4216577), installed on all 15 orgs.
- Credentials live only in `tomrivera-ops` org secrets: `FARADAY_APP_ID`, `FARADAY_APP_PRIVATE_KEY` (visibility: ALL). The repo is public, so it inherits org secrets — no repo-level copies (removed 2026-07-06, org inheritance verified by live run).
- The workflow mints a **per-org installation token** at runtime via the App REST API and writes `/tmp/org-tokens.json`. `roster.sh` reads it and uses the correct token per owner for `gh repo list` and `git clone`. This is what enables private-repo visibility across every org.

## Pipeline

Workflow: `.github/workflows/ecosystem-drift-gate.yml` — cron `0 6 * * *` + `workflow_dispatch`.

1. Generate per-org app tokens (Python / PyJWT)
2. `roster.sh list` → `ecosystem-inventory/_roster.yaml` + `_repos.txt`
3. `roster.sh deep` → per-org credential rewrites, shallow clones into `repos/`, then `ecosystem-discover.js`
4. `coupling-scan.js repos`
5. `drift-gate.js repos` — fails on new drift beyond baseline
6. Upload scan artifacts (14-day retention)

## Approval governance monitor (ADR-0013)

`governance-monitor.js` is a read-only check that the founder (`tomrivera-PSE`) is the only required human approver fleet-wide ([ADR-0013](https://github.com/tomrivera-ops/agent-contracts/blob/main/decisions/ADR-0013-solo-founder-human-approval.md)). It runs in the nightly workflow with the same per-org app tokens, and for each non-archived repo in every owner in `governance/approval-coverage.json` it reads default-branch protection, effective rulesets (repo + org), and environment reviewers.

| Status | Meaning |
|---|---|
| `COMPLIANT` | No approval-count, code-owner, last-push or environment-reviewer gate that a founder-authored PR cannot satisfy |
| `NONCOMPLIANT` | At least one such gate is enforced (blocking) |
| `UNVERIFIED` | A read failed (missing permission, unknown rule type, or GraphQL fallback failed). **Never treated as compliant.** Blocking unless recorded as a known gap in the coverage ledger |
| `EXCEPTION` | Documented external segregation-of-duties obligation in the ledger |
| `NEW_REPO` | Repo not yet in coverage (blocking until added via `--update-baseline` PR) |

GitHub Free private repos return 403 "Upgrade to GitHub Pro" from the REST protection API. For those, the monitor falls back to GraphQL, which still lists branch protection rules and rulesets (including inherited org rulesets) and each open PR's review decision. A repo is COMPLIANT only on positive evidence of no gate (`basis` recorded in the ledger); a GraphQL failure stays UNVERIFIED.

Owners with no `faraday-ci-bot` installation token are never scanned partially (an unauthenticated listing would show public repos only); they are reported as uncovered and block the run unless listed in the ledger's `owner_exceptions` with a reason. Current exceptions: coach-insight, faraday-enterprise, faraday-music, jetson-protocol, payroll-synergy-experts, and the founder account tomrivera-PSE. The app is not installed there because installing it would grant write access beyond what the monitor needs. Verify them with a founder-token run: `GH_TOKEN=$(gh auth token) node governance-monitor.js scan`.

Bot and AI reviews (`faraday-ci-bot`, `chatgpt-codex-connector`) are not human approval. The monitor never changes a protection; findings fail the nightly job and update one deduplicated `governance-drift` issue in this repo (closed automatically when clean). Reports are uploaded as 90-day artifacts; the ledger's git history is the permanent record.

```bash
node governance-monitor.js scan                    # enforce (exit 1 on blocking findings)
node governance-monitor.js scan --update-baseline  # record coverage, through a PR
node --test test/*.test.js                         # fixtures: compliant / noncompliant / missing-permission / new-repo
```

## Baseline

`ecosystem-inventory/drift-policy.json` holds the accepted findings baseline (currently 313 findings across 39 repos / 15 orgs). Finding keys use the `org__repo` format (CI canonical). The gate fails only on **new** keys not in the accepted set; existing findings are warn-only.

### Updating the baseline

`main` is protected (`enforce_admins: true`) — baseline changes route through a PR:

```bash
git checkout -b chore/update-drift-baseline
node drift-gate.js repos --update-baseline
git add ecosystem-inventory/drift-policy.json
git commit -m "chore: update drift baseline"
git push origin chore/update-drift-baseline
gh pr create --base main --head chore/update-drift-baseline \
  --title "chore: update drift baseline" --body "..."
# merge via bot:
gh workflow run 307201282 -f owner=tomrivera-ops \
  -f repo=tomrivera-ops/ecosystem-audit -f pr_number=<N> \
  -f merge_method=squash --repo tomrivera-ops/.github
```

### The ratchet rule (non-negotiable)

`drift-policy.json` is an audit ledger. Its git history is the record of **who accepted what drift and when**.

- Accept new drift only via `node drift-gate.js repos --update-baseline` + a reviewed commit.
- **Never** `continue-on-error` the gate. Legitimate exceptions go in the baseline by commit, not by silencing CI.
- Tighten rule severities in `drift-policy.json` as the fleet cleans up: flip `divergent_gov_schema` → `fail` once shield-ai completes the ADR-0001 migration; flip `unregistered_env_url` → `fail` once the service registry seeds `registry.env_urls`.

## Scope

In-scope owners (edit `OWNERS=(...)` in `roster.sh`):
faraday-platform, faraday-studio, faraday-accounting-control-panel-facp, faraday-build, faraday-beacon, faraday-capital-systems, orbitconsole, signal-interface, tomrivera-PSE, tomrivera-ops

Deliberately excluded: pulse-trading, MARZ-ai, RVCG-Consulting, ESL-Gospel-Connection, tomrivera-dev.

## What lives here (tracked)

| File | Role |
|---|---|
| `roster.sh` | Multi-org enumeration (`list`) + shallow clone (`deep`) |
| `ecosystem-discover.js` | Per-repo inventory (JS / Python / Go), zero API |
| `coupling-scan.js` | Cross-repo coupling graph + `_coupling.json` for the gate |
| `drift-gate.js` | Baseline-aware alignment gate (the ratchet) |
| `ecosystem-inventory/drift-policy.json` | **The ratchet ledger** — accepted-drift baseline + rules |
| `stage2-synthesis-prompt.md` | Synthesis prompt (consumes frozen inventory) |
| `governance-ssot-discovery.md` | Read-only discovery prompt |
| `.github/workflows/ecosystem-drift-gate.yml` | Nightly org-wide drift gate + approval governance scan |
| `.github/workflows/required-checks.yml` | PR gate (`required-checks`): syntax, ledger validity, monitor tests |
| `governance-monitor.js` | Approval-governance drift monitor (read-only) |
| `governance/approval-coverage.json` | Approval-governance coverage ledger |
| `docs/adr/ADR-0001-fleet-migration-triggers.md` | Fleet enrollment criteria |

## What NEVER lives here (gitignored)

- `repos/` — cloned fleet source. Re-derived on demand from `roster.sh deep`. Committing org source is exactly what made dev-audit a liability.
- `ecosystem-inventory/*.yaml`, `_*.md` reports — derived artifacts. Regenerable, go stale instantly. Transient evidence belongs in CI run artifacts, not version control.

## Governance

Public repo. `main` protected: `enforce_admins: true`, PR required with 0 required approvals (ADR-0013), required status check `required-checks`, dismiss-stale reviews, no force-push, no deletions. Founder-authored PRs merge once `required-checks` passes. See [CLAUDE.md](CLAUDE.md) for AI-assistant operating rules.

## Provenance

Source is never committed here. If you need the fleet at a point in time, re-run `roster.sh deep`.

## Human approval authority (2026-10-22)

Founder `tomrivera-PSE` is the **only required human approver** across founder-controlled repositories; no second independent human reviewer is required by default. Independent machine validation, tests, security checks, and audit evidence remain required where configured. GitHub PR authors cannot approve their own PR to satisfy branch-protection review requirements, so configured review-count and CODEOWNERS gates must be inspected and adjusted with administrator permissions to prevent solo-founder deadlocks. Do not treat this documentation as proof that live rulesets were changed. See [`agent-contracts` ADR-0013](https://github.com/tomrivera-ops/agent-contracts/blob/main/decisions/ADR-0013-solo-founder-human-approval.md). Founder authorization for a bounded scope is distinct from a second-human review requirement. No bypass of external segregation-of-duties obligations is authorized.

**Historical workflow note:** The `faraday-ci-bot` merge references above describe repository documentation at the time written; they do not establish live enforcement, current authorization, or a second-human approval requirement. Confirm live workflow/ruleset configuration before changing it.
