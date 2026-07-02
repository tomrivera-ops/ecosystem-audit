#!/usr/bin/env node
/**
 * drift-gate.js — baseline-aware alignment gate (the ratchet).
 *
 *   node drift-gate.js repos              # enforce: exit 1 on NEW drift
 *   node drift-gate.js repos --init       # seed drift-policy.json from current fleet
 *   node drift-gate.js repos --update-baseline  # merge current findings into accepted set
 *
 * Requires coupling-scan output: ecosystem-inventory/_coupling.json
 * (run `node coupling-scan.js repos` first, or this script runs it for you).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const POLICY_PATH = path.join('ecosystem-inventory', 'drift-policy.json');
const COUPLING_JSON = path.join('ecosystem-inventory', '_coupling.json');
const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo', 'out', '.cache', 'vendor', '__pycache__', '.venv', 'venv']);

const GOV_SCHEMA_FILES = new Set([
  'audit-event.schema.json',
  'governance-ref.schema.json',
  'evidence.schema.json',
  'product-registry.schema.json',
  'promotion.schema.json',
]);

const CANONICAL_GOV_MARKERS = [
  'faraday-capital-systems.github.io/faraday-governance',
  'github.com/faraday-capital-systems/faraday-governance',
];

const DEFAULT_RULES = {
  vendored_copy: 'warn',
  divergent_gov_schema: 'warn',
  unregistered_env_url: 'warn',
  python_import_edge: 'warn',
  js_import_edge: 'warn',
  import_cycle: 'warn',
};

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORE.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else {
      yield path.join(dir, entry.name);
    }
  }
}

function loadCoupling(parent) {
  if (!exists(COUPLING_JSON)) {
    execSync(`node coupling-scan.js ${JSON.stringify(parent)}`, { stdio: 'inherit' });
  }
  return JSON.parse(fs.readFileSync(COUPLING_JSON, 'utf8'));
}

function listRepos(parent) {
  if (!exists(parent)) {
    console.error(`repos parent missing: ${parent}`);
    process.exit(1);
  }
  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !IGNORE.has(e.name))
    .map((e) => e.name)
    .sort();
}

function isCanonicalGovId(id) {
  if (!id) return false;
  return CANONICAL_GOV_MARKERS.some((m) => id.includes(m));
}

function scanGovSchemas(parent, repos) {
  const findings = [];
  const govOwner = repos.find((r) => r.includes('faraday-governance'));
  for (const repo of repos) {
    if (repo === govOwner) continue;
    const root = path.join(parent, repo);
    for (const file of walk(root)) {
      const base = path.basename(file);
      if (!GOV_SCHEMA_FILES.has(base)) continue;
      let id = '';
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        id = j.$id || '';
      } catch {
        id = '(unparseable)';
      }
      if (!isCanonicalGovId(id)) {
        findings.push({
          kind: 'divergent_gov_schema',
          key: `${repo}|${base}|${id}`,
          repo,
          file: path.relative(root, file),
          schema_id: id,
        });
      }
    }
  }
  return findings;
}

function collectFindings(parent, coupling) {
  const findings = [];

  for (const dup of coupling.duplication_vendored_copies || []) {
    const repos = [...dup.repos].sort();
    findings.push({
      kind: 'vendored_copy',
      key: `${dup.package}|${repos.join(',')}`,
      package: dup.package,
      repos,
    });
  }

  for (const edge of coupling.python_import_edges || []) {
    findings.push({
      kind: 'python_import_edge',
      key: `${edge.from}|${edge.to}|${edge.via}`,
      ...edge,
    });
  }

  for (const edge of coupling.js_workspace_edges || []) {
    findings.push({
      kind: 'js_import_edge',
      key: `${edge.from}|${edge.to}|${edge.via}`,
      ...edge,
    });
  }

  for (const group of coupling.cycle_groups || []) {
    const members = [...(group.members || group)].sort();
    findings.push({
      kind: 'import_cycle',
      key: members.join('->'),
      members,
    });
  }

  const registry = {};
  for (const row of coupling.env_url_wiring || []) {
    for (const name of row.env_names || []) {
      findings.push({
        kind: 'unregistered_env_url',
        key: `${row.repo}|${name}`,
        repo: row.repo,
        env_name: name,
      });
    }
  }

  findings.push(...scanGovSchemas(parent, listRepos(parent)));

  return { findings, registry_hint: registry };
}

function emptyAccepted() {
  return {
    vendored_copy: [],
    divergent_gov_schema: [],
    unregistered_env_url: [],
    python_import_edge: [],
    js_import_edge: [],
    import_cycle: [],
  };
}

function buildPolicy(findings, registryHint, prior) {
  const accepted = prior?.accepted ? { ...emptyAccepted(), ...prior.accepted } : emptyAccepted();
  for (const kind of Object.keys(emptyAccepted())) {
    if (!Array.isArray(accepted[kind])) accepted[kind] = [];
  }
  const keys = new Set(Object.values(accepted).flat());
  for (const f of findings) {
    if (!keys.has(f.key)) {
      accepted[f.kind].push(f.key);
      keys.add(f.key);
    }
  }
  return {
    version: 1,
    seeded_at: prior?.seeded_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    rules: { ...DEFAULT_RULES, ...(prior?.rules || {}) },
    registry: prior?.registry || { env_urls: {} },
    accepted,
    notes: prior?.notes || 'Ratchet ledger. Accept new drift only via reviewed --update-baseline commit.',
  };
}

function loadPolicy() {
  if (!exists(POLICY_PATH)) {
    console.error(`missing ${POLICY_PATH} — run with --init first`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
}

function savePolicy(policy) {
  fs.mkdirSync(path.dirname(POLICY_PATH), { recursive: true });
  fs.writeFileSync(POLICY_PATH, JSON.stringify(policy, null, 2) + '\n');
}

function acceptedSet(policy) {
  const set = new Set();
  for (const arr of Object.values(policy.accepted || {})) {
    for (const k of arr) set.add(k);
  }
  return set;
}

function main() {
  const args = process.argv.slice(2);
  const init = args.includes('--init');
  const update = args.includes('--update-baseline');
  const parent = args.find((a) => !a.startsWith('--')) || 'repos';

  const coupling = loadCoupling(parent);
  const { findings } = collectFindings(parent, coupling);

  if (init) {
    const policy = buildPolicy(findings, {}, null);
    savePolicy(policy);
    console.log(`drift-policy.json: seeded ${findings.length} accepted finding(s)`);
    return;
  }

  if (update) {
    const prior = exists(POLICY_PATH) ? loadPolicy() : null;
    const policy = buildPolicy(findings, {}, prior);
    savePolicy(policy);
    console.log(`drift-policy.json: updated baseline (${findings.length} finding(s) in fleet)`);
    return;
  }

  const policy = loadPolicy();
  const known = acceptedSet(policy);
  const newFindings = findings.filter((f) => !known.has(f.key));

  if (newFindings.length === 0) {
    console.log('drift-gate: PASS — no new drift beyond baseline');
    return;
  }

  const byKind = {};
  for (const f of newFindings) {
    byKind[f.kind] = byKind[f.kind] || [];
    byKind[f.kind].push(f);
  }

  let failed = false;
  for (const [kind, items] of Object.entries(byKind)) {
    const severity = (policy.rules || {})[kind] || DEFAULT_RULES[kind] || 'warn';
    console.error(`\n[${severity.toUpperCase()}] NEW ${kind} (${items.length}):`);
    for (const item of items.slice(0, 20)) {
      console.error(`  - ${item.key}`);
    }
    if (items.length > 20) console.error(`  ... and ${items.length - 20} more`);
    if (severity === 'fail') failed = true;
  }

  console.error(`\ndrift-gate: ${failed ? 'FAIL' : 'PASS with warnings'} — ${newFindings.length} new finding(s)`);
  console.error('Accept via: node drift-gate.js repos --update-baseline  (then commit drift-policy.json)');
  if (failed) process.exit(1);
}

main();
