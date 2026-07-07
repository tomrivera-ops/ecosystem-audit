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
| `.github/workflows/ecosystem-drift-gate.yml` | Nightly org-wide drift gate |
| `docs/adr/ADR-0001-fleet-migration-triggers.md` | Fleet enrollment criteria |

## What NEVER lives here (gitignored)

- `repos/` — cloned fleet source. Re-derived on demand from `roster.sh deep`. Committing org source is exactly what made dev-audit a liability.
- `ecosystem-inventory/*.yaml`, `_*.md` reports — derived artifacts. Regenerable, go stale instantly. Transient evidence belongs in CI run artifacts, not version control.

## Governance

Public repo. `main` protected: `enforce_admins: true`, 1 required review, dismiss-stale reviews, no force-push, no deletions. All changes go through PR + `faraday-ci-bot`. See [CLAUDE.md](CLAUDE.md) for AI-assistant operating rules.

## Provenance

Source is never committed here. If you need the fleet at a point in time, re-run `roster.sh deep`.
