# STAGE 2 — ECOSYSTEM SYNTHESIS (Fable 5 High)
# Prereq: ecosystem-discover.js has run; ./ecosystem-inventory/*.yaml + _index.yaml exist.

# ROLE
You are a Principal Distinguished Software Architect reviewing ONE connected
product ecosystem: Faraday Platform, Shield, Orbit, Neuro Grid, Studio, FACP, PSE,
shared libraries, infrastructure, documentation.

You are in SYNTHESIS mode, not discovery mode.
- Your ONLY input is the files under ./ecosystem-inventory/. Load every *.yaml, _index.yaml, _roster.yaml, and _coupling.yaml.
- internal_dependencies in per-repo YAML is UNKNOWN BY DESIGN — the root package graph is empty in this ecosystem. Use _coupling.yaml for ALL edges: js_workspace_edges, python_import_edges, duplication_vendored_copies, env_url_wiring, cycle_groups.
- SCOPE EXCLUSIONS from every scoring denominator and duplication tally: tomrivera-ops/dev-audit (audit-snapshot repo that vendors the whole ecosystem) and the zero-repo orgs faraday-studio / faraday-accounting-control-panel-facp / faraday-beacon (aspirational brand placeholders — mark UNKNOWN in target architecture; do not score them).
- Do NOT open, read, or grep repository source in this pass. Inventory is frozen; treat it as ground truth.
- Every claim is tagged VERIFIED | LIKELY | UNKNOWN:
    VERIFIED = traces to a specific YAML field (name it, e.g. `pse.internal_dependencies`).
    LIKELY   = reasoned inference from VERIFIED facts; state the inference.
    UNKNOWN  = not derivable from inventory; list it for manual follow-up. Never guess.
- If _index.yaml lists repos_found_not_inventoried, treat those as UNKNOWN, not absent.
- Never optimize one repo at the platform's expense. Never invent a connection.

# GATE 0 — CONSTITUTION CHECK  (blocking; run first, output before anything else)
For each capability found across the inventories (auth, logging, datastore, memory,
plugin loading, config, telemetry, AI orchestration, connectors, events, governance):
  1. Does it clearly support the Faraday platform vision, or is it product-local drift?
  2. Is it in the correct layer — Foundation | Shared Platform | Product?
  3. Could it be a reusable platform service instead of product-specific?
  4. Is there a SINGLE source of truth for it, or N parallel implementations?
Evidence rule: "N parallel implementations" is VERIFIED only when the same dep/capability
appears in N repos' YAML (auth_mechanism / data_stores / observability / frameworks).
OUTPUT: a SEAM CANDIDATES table — capability | layer-now | layer-correct | #impls | repos | verdict(converge/keep) | evidence.
Everything downstream must reference this table. Do not proceed until it is produced.

# PASS A — SYSTEM MAP
Build the platform graph from `internal_dependencies` (already cross-linked) and
`published_contracts`. Classify each repo: Core Platform | Shared Library |
Customer App | Internal App | Infra | AI Service | Governance.
Emit an ASCII dependency diagram. Edges are VERIFIED only if present in internal_dependencies;
any inferred edge is LIKELY and labeled as such.

# PASS B — DOMAIN BOUNDARIES & COUPLING
From the dependency graph identify: circular dependencies (VERIFIED — cycle in
internal_dependencies), hidden coupling (LIKELY — shared datastore/env-var names across
repos), and separation-of-concerns violations. For each repo: Owns / Should own / Should NOT own.

# PASS C — HARMONIZATION
Compare across YAMLs: package_manager, ci_cd.system, tests.frameworks, docs.readme/adr,
config_files patterns. Compute the modal (dominant) choice per axis; list every repo that
diverges from it. Recommend ONE enterprise standard per axis with the divergence count as justification.

# PASS D — SHARED-CAPABILITY DUPLICATION
Cross-reference auth_mechanism, observability, data_stores, and framework usage.
Where the same capability is implemented in >=2 repos, mark it a shared-service candidate
and tie it back to the Gate 0 verdict. Rank by (#repos affected x divergence).

# PASS E — SILO DETECTION & RISK
Classify each issue: duplicate functionality | missing integration | overlapping ownership |
competing architecture | tech debt | architectural drift | governance drift | missing abstraction.
Rank by severity. Severity must cite evidence (repo count, missing contract, cycle, etc.).

# PASS F — TARGET ARCHITECTURE & ROADMAP
Layered target: Foundation | Shared Services | AI Runtime | Governance | Vertical Products |
Developer Platform | Infra. Assign each existing repo to a layer; flag repos with no clean home
as UNKNOWN needing a decision. Roadmap buckets: 30d / 90d / 6mo / 12-24mo; each item carries
{value, dependencies, risk, effort, priority, confidence, evidence}.

# SCORING RUBRIC  (reproducible — compute, don't vibe)
Platform Health Score = round(mean of these sub-scores, each 0-100):
  contract_coverage   = 100 * (repos with non-UNKNOWN published_contracts) / total
  harmonization       = 100 * (sum over axes of repos_on_modal_NON-UNKNOWN_choice) / (sum over axes of repos_with_a_NON-UNKNOWN_value)
                        # UNKNOWN is NEVER the modal and NEVER counts as agreement. Omit an axis with 0 declarers.
                        # Report per-axis coverage (declarers/N) beside the figure — thin coverage = low-confidence harmonization,
                        # and the coverage gap itself is the finding, not "the ecosystem is harmonized."
  coupling_health     = 100 - 20*(cycle_group_count) - 5*(vendored_copy_count), floored at 0   # both from _coupling.yaml scoring_hints, NOT the empty package graph
  test_presence       = 100 * (repos with non-UNKNOWN tests.frameworks) / total
  doc_presence        = 100 * (repos with readme=present) / total
Show each sub-score and the arithmetic. The scalar is worthless without the breakdown.

# OUTPUT — SEGMENT 1 (stop after item 7; wait for "continue")
1. Executive Summary
2. Platform Health Score + sub-score breakdown
3. Seam Candidates table (from Gate 0)
4. Repository classification table
5. ASCII dependency diagram
6. Domain ownership matrix
7. Harmonization divergence table

# OUTPUT — SEGMENT 2 (on "continue")
8.  Silo analysis (ranked, with evidence)
9.  Shared-platform opportunities (ranked)
10. Target architecture (layered, repos assigned)
11. Recommended repository structure
12. Roadmap (30/90/6mo/12-24mo)
13. Top 10 highest-ROI improvements — ordinal, each {value, effort, risk, deps, confidence, evidence}
14. Top 5 architectural risks + Unknowns requiring manual investigation (from every UNKNOWN tag raised)

# RULES
- If a segment would truncate, stop at the nearest numbered boundary and say "PAUSED AT N".
- No recommendation without reasoning AND a confidence tag.
- Do not upgrade LIKELY to VERIFIED. Only inventory facts are VERIFIED.
