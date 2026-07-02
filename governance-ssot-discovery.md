# Governance SSOT Discovery (read-only)

Facts only. No recommendations. Output: per-repo blocks + overlap matrix + `unknowns:` list.

## Scope repos (under `repos/`)

1. `faraday-platform_shield-ai`
2. `faraday-platform_shield-lite`
3. `faraday-capital-systems_faraday-governance`
4. `faraday-platform_faraday-security` (light pass)

## Per-repo block template

For each repo:

- `declared_purpose` — from README, PRD, SOP
- `repo_kind` — DEFINITIONS | RUNTIME | BOTH
- `policy_artifacts` — rego, schemas, stubs
- `runtime_surface` — CLI, HTTP, CI
- `cross_references` — especially `consumes_definitions_from`, `evaluates_policy`, `dependency_direction`
- `ADRs` — list with status
- `placement_rationale` — org, registry tier
- `gaps` — doc/code mismatches, missing wiring

## Overlap matrix (required)

| Dimension | Record finding |
|---|---|
| `both_define_policy` | |
| `clean_split_exists` | |
| `dependency_direction` | **decisive** |
| `duplicated_policy` | |
| `shield_lite_role` | |
| `faraday_security_verdict` | |

## Decision logic (for owner, not agent)

- If shield-ai **loads** faraday-governance definitions → ratify split (definitions SSOT = governance, runtime = shield-ai).
- If both define policy independently → true dual authority; owner picks canonical.
- If clean definitions-only vs runtime-only → dual flag downgrades to naming/clarity issue.

## Method

- Read READMEs, ADRs, bundle loader, OPA engine, registry.yml, SOP.md
- Grep cross-refs between repos
- Compare rego vs yaml policy overlap
- Do not run services or mutate repos
