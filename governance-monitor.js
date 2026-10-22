#!/usr/bin/env node
/**
 * governance-monitor.js — read-only approval-governance drift monitor.
 *
 * Policy: ADR-0013 (agent-contracts). The founder is the only required human
 * approver. A founder-authored PR must never depend on a second human approval,
 * because GitHub does not count a PR author's own approval toward review gates.
 *
 *   node governance-monitor.js scan                     # enforce: exit 1 on new findings
 *   node governance-monitor.js scan --update-baseline   # accept current coverage into the baseline
 *   node governance-monitor.js scan --fixtures f.json   # offline run against recorded API responses
 *   node governance-monitor.js alert --report r.json    # upsert one deduplicated tracking issue
 *
 * Statuses per repo:
 *   COMPLIANT     no review count / code-owner / last-push / env-reviewer gate that blocks the founder
 *   NONCOMPLIANT  at least one such gate is enforced
 *   UNVERIFIED    a required read failed (missing permission, plan-limited, unknown ruleset) — never compliant
 *   EXCEPTION     documented exception in the baseline (e.g. external segregation-of-duties obligation)
 *   NEW_REPO      repo is not yet in governance coverage (reported in addition to its status)
 *
 * This script never modifies a protection. Flags are for founder review only.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASELINE_PATH = path.join('governance', 'approval-coverage.json');
const REPORT_DIR = path.join('ecosystem-inventory', 'governance');
const API = 'https://api.github.com';
const ISSUE_LABEL = 'governance-drift';
const FINGERPRINT_MARKER = 'governance-monitor-fingerprint:';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
      else args[a.slice(2)] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

// ---------------------------------------------------------------------------
// API layer (live or fixture-backed). Every response is {status, body}.
// ---------------------------------------------------------------------------

function liveClient({ tokens, defaultToken }) {
  return async function request(owner, method, p, body) {
    const token = (tokens && tokens[owner]) || defaultToken;
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(API + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { message: text.slice(0, 200) }; }
    return { status: res.status, body: parsed };
  };
}

function fixtureClient(fixtures) {
  return async function request(_owner, method, p, body) {
    // GraphQL fixtures are keyed per repo: "POST /graphql owner/name".
    const v = p === '/graphql' && body && body.variables;
    const key = v ? `${method} ${p} ${v.owner}/${v.name}` : `${method} ${p}`;
    if (Object.prototype.hasOwnProperty.call(fixtures, key)) return fixtures[key];
    return { status: 404, body: { message: `fixture missing: ${key}` } };
  };
}

async function paginate(request, owner, p) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const sep = p.includes('?') ? '&' : '?';
    const r = await request(owner, 'GET', `${p}${sep}per_page=100&page=${page}`);
    if (r.status !== 200) return { error: r };
    const items = Array.isArray(r.body) ? r.body : [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return { items: out };
}

// ---------------------------------------------------------------------------
// Classification (pure; unit-tested)
// ---------------------------------------------------------------------------

function readError(r) {
  const msg = (r.body && r.body.message) || `HTTP ${r.status}`;
  return `HTTP ${r.status}: ${msg}`;
}

function isNotProtected(r) {
  return r.status === 404 && /branch not protected/i.test((r.body && r.body.message) || '');
}

function classifyRepo({ repo, protection, rules, environments, founder }) {
  const findings = [];
  const unverified = [];
  const safeguards = { required_status_checks: [], pull_request_required: false };

  if (protection.status === 200) {
    const pr = protection.body.required_pull_request_reviews;
    if (pr) {
      safeguards.pull_request_required = true;
      if ((pr.required_approving_review_count || 0) > 0) {
        findings.push(`branch_protection.required_approving_review_count=${pr.required_approving_review_count}`);
      }
      if (pr.require_code_owner_reviews) findings.push('branch_protection.require_code_owner_reviews=true');
      if (pr.require_last_push_approval) findings.push('branch_protection.require_last_push_approval=true');
    }
    const sc = protection.body.required_status_checks;
    if (sc) safeguards.required_status_checks.push(...(sc.contexts || []));
  } else if (!isNotProtected(protection)) {
    unverified.push(`branch_protection: ${readError(protection)}`);
  }

  if (rules.status === 200) {
    for (const rule of rules.body || []) {
      const src = `ruleset[${rule.ruleset_source_type || '?'}:${rule.ruleset_source || '?'}#${rule.ruleset_id || '?'}]`;
      if (rule.type === 'pull_request') {
        const p = rule.parameters || {};
        safeguards.pull_request_required = true;
        if ((p.required_approving_review_count || 0) > 0) findings.push(`${src}.required_approving_review_count=${p.required_approving_review_count}`);
        if (p.require_code_owner_review) findings.push(`${src}.require_code_owner_review=true`);
        if (p.require_last_push_approval) findings.push(`${src}.require_last_push_approval=true`);
        if (Array.isArray(p.required_reviewers) && p.required_reviewers.length) findings.push(`${src}.required_reviewers`);
      } else if (rule.type === 'required_status_checks') {
        for (const c of (rule.parameters && rule.parameters.required_status_checks) || []) {
          safeguards.required_status_checks.push(c.context);
        }
      } else if (!KNOWN_RULE_TYPES.has(rule.type)) {
        unverified.push(`${src}: unknown rule type "${rule.type}"`);
      }
    }
  } else {
    unverified.push(`rulesets: ${readError(rules)}`);
  }

  if (environments.status === 200) {
    for (const env of (environments.body && environments.body.environments) || []) {
      for (const pr of env.protection_rules || []) {
        if (pr.type !== 'required_reviewers') continue;
        const reviewers = (pr.reviewers || []).map((r) => (r.reviewer && (r.reviewer.login || r.reviewer.slug)) || '?');
        const founderOnly = reviewers.length > 0 && reviewers.every((r) => r === founder);
        if (!founderOnly) findings.push(`environment[${env.name}].required_reviewers=${reviewers.join(',')}`);
        if (pr.prevent_self_review) findings.push(`environment[${env.name}].prevent_self_review=true`);
      }
    }
  } else if (environments.status !== 404) {
    unverified.push(`environments: ${readError(environments)}`);
  }

  let status = 'COMPLIANT';
  if (findings.length) status = 'NONCOMPLIANT';
  else if (unverified.length) status = 'UNVERIFIED';
  // Advisory only: a PR requirement with no required check means nothing automated gates a merge.
  const advisories = [];
  if (status === 'COMPLIANT' && safeguards.pull_request_required && !safeguards.required_status_checks.length) {
    advisories.push('pull request required but no required status check (no automated merge gate)');
  }
  return { repo, status, findings, unverified, advisories, safeguards };
}

const KNOWN_RULE_TYPES = new Set([
  'creation', 'update', 'deletion', 'required_linear_history', 'merge_queue', 'required_deployments',
  'required_signatures', 'pull_request', 'required_status_checks', 'non_fast_forward',
  'commit_message_pattern', 'commit_author_email_pattern', 'committer_email_pattern',
  'branch_name_pattern', 'tag_name_pattern', 'file_path_restriction', 'max_file_path_length',
  'file_extension_restriction', 'max_file_size', 'workflows', 'code_scanning', 'copilot_code_review',
]);

// Apply the baseline: exceptions, accepted UNVERIFIED reasons, and coverage (NEW_REPO).
function applyBaseline(results, baseline) {
  const covered = baseline.repos || {};
  const out = [];
  for (const r of results) {
    const entry = covered[r.repo];
    const res = { ...r, new_repo: !entry };
    if (entry && entry.exception && r.status === 'NONCOMPLIANT') {
      res.status = 'EXCEPTION';
      res.exception = entry.exception;
    }
    res.accepted_unverified = Boolean(entry && entry.accepted_status === 'UNVERIFIED' && r.status === 'UNVERIFIED');
    out.push(res);
  }
  return out;
}

// Blocking findings: any NONCOMPLIANT, any NEW_REPO, any UNVERIFIED not already accepted in the baseline.
function blockingFindings(results, ownerErrors) {
  const keys = [];
  for (const r of results) {
    if (r.status === 'NONCOMPLIANT') for (const f of r.findings) keys.push(`NONCOMPLIANT|${r.repo}|${f}`);
    if (r.new_repo) keys.push(`NEW_REPO|${r.repo}`);
    if (r.status === 'UNVERIFIED' && !r.accepted_unverified) keys.push(`UNVERIFIED|${r.repo}`);
  }
  for (const e of ownerErrors) keys.push(`UNVERIFIED_OWNER|${e.owner}|${e.error}`);
  return keys.sort();
}

function fingerprint(keys) {
  return crypto.createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 16);
}

// GitHub Free private repos: the REST protection/rulesets endpoints answer 403 "Upgrade to
// GitHub Pro", but GraphQL still lists any branch protection rules and rulesets (including
// inherited org rulesets) and reports each open PR's review decision. Zero rules plus no
// REVIEW_REQUIRED PR is positive evidence of no gate; any GraphQL failure stays UNVERIFIED.
const PLAN_LIMITED = /Upgrade to GitHub (Pro|Team)/i;
const GRAPHQL_GATES = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    branchProtectionRules(first: 50) { totalCount nodes { pattern requiredApprovingReviewCount requiresCodeOwnerReviews } }
    rulesets(first: 50, includeParents: true) { totalCount nodes { name enforcement rules(first: 50) { nodes { type
      parameters { ... on PullRequestParameters { requiredApprovingReviewCount requireCodeOwnerReview } } } } } }
    pullRequests(states: OPEN, first: 50) { nodes { number reviewDecision } }
  }
}`;

function isPlanLimited(result) {
  return result.status === 'UNVERIFIED' && result.unverified.length > 0 &&
    result.unverified.every((u) => /HTTP 403/.test(u) && PLAN_LIMITED.test(u));
}

async function graphqlGates(request, owner, full) {
  const [o, name] = full.split('/');
  const r = await request(owner, 'POST', '/graphql', { query: GRAPHQL_GATES, variables: { owner: o, name } });
  const repo = r.status === 200 && r.body && !r.body.errors && r.body.data && r.body.data.repository;
  if (!repo) return { error: r.body && r.body.errors ? `GraphQL: ${r.body.errors.map((e) => e.message).join('; ')}` : readError(r) };
  const findings = [];
  for (const rule of repo.branchProtectionRules.nodes) {
    if ((rule.requiredApprovingReviewCount || 0) > 0) findings.push(`graphql.branch_protection[${rule.pattern}].required_approving_review_count=${rule.requiredApprovingReviewCount}`);
    if (rule.requiresCodeOwnerReviews) findings.push(`graphql.branch_protection[${rule.pattern}].require_code_owner_reviews=true`);
  }
  for (const rs of repo.rulesets.nodes) {
    for (const rule of rs.rules.nodes) {
      const prm = rule.parameters || {};
      if (rule.type !== 'PULL_REQUEST') continue;
      if ((prm.requiredApprovingReviewCount || 0) > 0) findings.push(`graphql.ruleset[${rs.name}:${rs.enforcement}].required_approving_review_count=${prm.requiredApprovingReviewCount}`);
      if (prm.requireCodeOwnerReview) findings.push(`graphql.ruleset[${rs.name}:${rs.enforcement}].require_code_owner_review=true`);
    }
  }
  const open = repo.pullRequests.nodes;
  for (const pr of open) if (pr.reviewDecision === 'REVIEW_REQUIRED') findings.push(`graphql.open_pr#${pr.number}.reviewDecision=REVIEW_REQUIRED`);
  return {
    findings,
    evidence: { branch_protection_rules: repo.branchProtectionRules.totalCount, rulesets: repo.rulesets.totalCount, open_prs_checked: open.length },
  };
}

// A personal account's private repos are only visible through authenticated listings:
// /user/repos (user token) or /installation/repositories (app installation token).
// /users/{login}/repos returns public repos only, so falling back to it is reported, never silent.
async function listUserRepos(request, owner) {
  const mine = await paginate(request, owner, '/user/repos?affiliation=owner');
  if (!mine.error) return { items: mine.items.filter((r) => r.owner && r.owner.login === owner) };
  const inst = await request(owner, 'GET', '/installation/repositories?per_page=100');
  if (inst.status === 200 && inst.body && Array.isArray(inst.body.repositories)) {
    const items = inst.body.repositories.filter((r) => r.owner && r.owner.login === owner);
    if ((inst.body.total_count || 0) <= 100) return { items };
    return { items, partial: `installation lists ${inst.body.total_count} repos; only first 100 scanned` };
  }
  const pub = await paginate(request, owner, `/users/${owner}/repos?type=owner`);
  if (pub.error) return pub;
  return { items: pub.items, partial: 'private repos not listable (public listing only)' };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

async function scan(request, baseline) {
  const founder = baseline.founder;
  const results = [];
  const ownerErrors = [];
  for (const owner of baseline.owners) {
    const listed = owner === founder ? await listUserRepos(request, owner) : await paginate(request, owner, `/orgs/${owner}/repos?type=all`);
    if (listed.error) {
      ownerErrors.push({ owner, error: readError(listed.error) });
      continue;
    }
    if (listed.partial) ownerErrors.push({ owner, error: listed.partial });
    for (const repo of listed.items) {
      if (repo.archived) continue;
      const full = repo.full_name;
      const br = encodeURIComponent(repo.default_branch || 'main');
      const protection = await request(owner, 'GET', `/repos/${full}/branches/${br}/protection`);
      const rules = await request(owner, 'GET', `/repos/${full}/rules/branches/${br}`);
      const environments = await request(owner, 'GET', `/repos/${full}/environments`);
      const result = classifyRepo({ repo: full, protection, rules, environments, founder });
      if (isPlanLimited(result)) {
        const g = await graphqlGates(request, owner, full);
        if (g.error) {
          result.unverified.push(`graphql fallback: ${g.error}`);
        } else {
          result.basis = 'graphql (REST protection API plan-limited)';
          result.graphql_evidence = g.evidence;
          result.unverified = [];
          result.findings.push(...g.findings);
          result.status = result.findings.length ? 'NONCOMPLIANT' : 'COMPLIANT';
        }
      }
      results.push(result);
    }
  }
  return { results: applyBaseline(results, baseline), ownerErrors };
}

function summarize(results, ownerErrors, keys) {
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  counts.NEW_REPO = results.filter((r) => r.new_repo).length;
  return { counts, owner_errors: ownerErrors, blocking: keys, fingerprint: fingerprint(keys) };
}

function renderMarkdown(report) {
  const lines = [`# Approval governance report`, '', `Generated: ${report.generated_at}`, `Founder: \`${report.founder}\``, ''];
  lines.push('| Status | Count |', '|---|---|');
  for (const [k, v] of Object.entries(report.summary.counts)) lines.push(`| ${k} | ${v} |`);
  const viaGraphql = report.results.filter((r) => r.basis).length;
  if (viaGraphql) lines.push('', `${viaGraphql} repo(s) verified via GraphQL because the REST protection API is plan-limited (GitHub Free private repos).`);
  lines.push('');
  if (report.summary.blocking.length) {
    lines.push('## Blocking findings', '');
    for (const k of report.summary.blocking) lines.push(`- \`${k}\``);
    lines.push('');
  }
  const adv = report.results.filter((r) => r.advisories.length);
  if (adv.length) {
    lines.push('## Advisories (non-blocking)', '');
    for (const r of adv) lines.push(`- ${r.repo}: ${r.advisories.join('; ')}`);
    lines.push('');
  }
  lines.push('Human approvals counted here are review-count / code-owner / environment gates. Bot or AI reviews',
    '(e.g. faraday-ci-bot, chatgpt-codex-connector) are not human approval and are never treated as satisfying ADR-0013.',
    'UNVERIFIED means the setting could not be read; it is never reported as compliant.');
  return lines.join('\n') + '\n';
}

function loadTokens() {
  const file = process.env.ORG_TOKENS_FILE;
  if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return {};
}

async function cmdScan(args) {
  const baseline = JSON.parse(fs.readFileSync(args.baseline || BASELINE_PATH, 'utf8'));
  const request = args.fixtures
    ? fixtureClient(JSON.parse(fs.readFileSync(args.fixtures, 'utf8')))
    : liveClient({ tokens: loadTokens(), defaultToken: process.env.GH_TOKEN || process.env.GITHUB_TOKEN });
  const { results, ownerErrors } = await scan(request, baseline);

  if (args['update-baseline']) {
    const repos = { ...(baseline.repos || {}) };
    for (const r of results) {
      const prev = repos[r.repo] || {};
      repos[r.repo] = { ...prev, accepted_status: r.status === 'UNVERIFIED' ? 'UNVERIFIED' : prev.accepted_status || 'COMPLIANT' };
      if (r.status === 'UNVERIFIED') repos[r.repo].unverified_reason = r.unverified[0];
      if (r.status !== 'UNVERIFIED') delete repos[r.repo].unverified_reason;
      if (r.basis) repos[r.repo].basis = r.basis;
      else delete repos[r.repo].basis;
    }
    const sorted = Object.fromEntries(Object.keys(repos).sort().map((k) => [k, repos[k]]));
    const next = { ...baseline, updated_at: new Date().toISOString(), repos: sorted };
    fs.writeFileSync(args.baseline || BASELINE_PATH, JSON.stringify(next, null, 2) + '\n');
    console.log(`baseline updated: ${Object.keys(sorted).length} repos`);
    return 0;
  }

  const keys = blockingFindings(results, ownerErrors);
  const report = {
    generated_at: new Date().toISOString(),
    founder: baseline.founder,
    policy: baseline.policy,
    summary: summarize(results, ownerErrors, keys),
    results,
  };
  const outDir = args.out || REPORT_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'approval-governance.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'approval-governance.md'), renderMarkdown(report));
  console.log(JSON.stringify(report.summary.counts));
  for (const k of keys) console.log(`BLOCKING ${k}`);
  return keys.length ? 1 : 0;
}

// One open issue, labelled governance-drift, identified by fingerprint. Same fingerprint → no new noise.
async function cmdAlert(args) {
  const report = JSON.parse(fs.readFileSync(args.report, 'utf8'));
  const repo = args.repo || process.env.GITHUB_REPOSITORY;
  const owner = repo.split('/')[0];
  const request = args.fixtures
    ? fixtureClient(JSON.parse(fs.readFileSync(args.fixtures, 'utf8')))
    : liveClient({ defaultToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN });
  const write = async (method, p, body) => {
    const r = await request(owner, method, p, body);
    if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${p} failed: ${readError(r)}`);
    return r;
  };
  const fp = report.summary.fingerprint;
  const open = await request(owner, 'GET', `/repos/${repo}/issues?state=open&labels=${ISSUE_LABEL}&per_page=100`);
  if (open.status !== 200) throw new Error(`cannot list issues: ${readError(open)}`);
  const existing = (open.body || []).find((i) => !i.pull_request);
  const clean = report.summary.blocking.length === 0;
  const body = `${renderMarkdown(report)}\n<!-- ${FINGERPRINT_MARKER}${fp} -->\n`;

  if (clean) {
    if (existing) {
      await write('POST', `/repos/${repo}/issues/${existing.number}/comments`, { body: `Resolved: governance scan clean at ${report.generated_at}.` });
      await write('PATCH', `/repos/${repo}/issues/${existing.number}`, { state: 'closed', state_reason: 'completed' });
      return { action: 'closed', number: existing.number };
    }
    return { action: 'none' };
  }
  if (existing) {
    if ((existing.body || '').includes(`${FINGERPRINT_MARKER}${fp}`)) return { action: 'unchanged', number: existing.number };
    await write('PATCH', `/repos/${repo}/issues/${existing.number}`, { body });
    await write('POST', `/repos/${repo}/issues/${existing.number}/comments`, { body: `Findings changed (fingerprint \`${fp}\`). See updated description.` });
    return { action: 'updated', number: existing.number };
  }
  const created = await write('POST', `/repos/${repo}/issues`, {
    title: 'Approval governance drift detected', body, labels: [ISSUE_LABEL],
  });
  return { action: 'created', number: created.body && created.body.number };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'scan') return cmdScan(args);
  if (cmd === 'alert') {
    const r = await cmdAlert(args);
    console.log(JSON.stringify(r));
    return 0;
  }
  console.error('usage: governance-monitor.js scan [--update-baseline] [--fixtures f] [--out dir] | alert --report r.json');
  return 2;
}

module.exports = { classifyRepo, applyBaseline, blockingFindings, fingerprint, scan, fixtureClient, cmdAlert, renderMarkdown };

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error(e.stack || e); process.exit(2); });
}
