# ADR-0001 — Fleet Migration Triggers

**Status:** Accepted
**Date:** 2026-07-05
**Deciders:** tomrivera-PSE

---

## Context

ecosystem-audit runs nightly drift detection across the Faraday fleet.
For the gate to be meaningful, repos must be explicitly enrolled.
This ADR defines the criteria that trigger enrollment.

## Decision

A repository is added to the ecosystem-audit fleet when ANY of the
following criteria are met:

### Automatic triggers
1. **New repo created** in a Faraday org with > 1 commit on main
2. **Repo makes first production deployment** (first tag or release)
3. **Repo introduces a Supabase client, API key, or auth dependency**

### Manual triggers
4. **Ownership transfer** into a Faraday org
5. **Coupling threshold crossed** — repo imports from 2+ other Faraday repos
6. **Explicit enrollment** — operator adds repo to roster.sh manually

### Exclusions
- Archived repos
- Sandbox/lab repos in tomrivera-dev (unless promoted)
- Repos with < 5 commits and no external dependencies

## Process

1. Operator adds repo to `roster.sh` in ecosystem-audit
2. Opens PR with title `chore: enroll <org>/<repo> into fleet`
3. PR merged via `faraday-ci-bot`
4. Next nightly run establishes baseline for new repo

## Consequences

- **Positive:** Drift gate coverage expands automatically as fleet grows
- **Negative:** Manual enrollment step required — no auto-discovery yet
- **Known gap:** Private repos in non-tomrivera-ops orgs require
  cross-org token expansion (tracked: ecosystem-audit issue backlog)

## Related

- Supersedes: `tomrivera-ops/dev-audit` (archived 2026-07-05)
- Implemented in: `tomrivera-ops/ecosystem-audit`
- Bot: `faraday-ci-bot` App ID 4216577
