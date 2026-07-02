# ecosystem-audit

Standing alignment tooling for the Faraday product ecosystem. Replaces the retired
`tomrivera-ops/dev-audit`. **This repo holds tooling and the drift baseline — never
source, never generated reports.**

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

## What NEVER lives here (gitignored)
- `repos/` — cloned fleet source. Re-derived on demand from `roster.sh deep`. Committing
  org source is exactly what made dev-audit a liability.
- `ecosystem-inventory/*.yaml`, `_*.md` reports — derived artifacts. Regenerable, go stale
  instantly. Transient evidence belongs in CI run artifacts, not version control.

## What lives elsewhere
- **ADRs / governance decisions → `faraday-governance/docs/adr/`.** Binding records stay with
  the governance SSOT (ADR-0001). They do not get a second home here.

## Run
```bash
./roster.sh list && ./roster.sh deep     # enumerate + shallow-clone fleet into repos/
node ecosystem-discover.js repos          # per-repo inventory
node coupling-scan.js repos               # coupling facts (+ _coupling.json)
node drift-gate.js repos                  # enforce: exit 1 on NEW drift beyond baseline
```

## The ratchet rule (non-negotiable)
`drift-policy.json` is an audit ledger. Its git history is the record of **who accepted what
drift and when**.
- Accept new drift only via `node drift-gate.js repos --update-baseline` + a reviewed commit.
- **Never** `continue-on-error` the gate. Legitimate exceptions go in the baseline by commit,
  not by silencing CI.
- Tighten rule severities in `drift-policy.json` as the fleet cleans up: flip
  `divergent_gov_schema` → `fail` once shield-ai completes the ADR-0001 migration; flip
  `unregistered_env_url` → `fail` once the service registry seeds `registry.env_urls`.

## Provenance
Source is never committed here. If you need the fleet at a point in time, re-run `roster.sh deep`.
