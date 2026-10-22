'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../governance-monitor');

const FIX = path.join(__dirname, 'fixtures');
const fleet = JSON.parse(fs.readFileSync(path.join(FIX, 'governance-fleet.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.join(FIX, 'governance-baseline.json'), 'utf8'));

async function runScan(b = baseline) {
  const { results, ownerErrors } = await m.scan(m.fixtureClient(fleet), b);
  return { byRepo: Object.fromEntries(results.map((r) => [r.repo, r])), results, ownerErrors };
}

test('compliant repo: zero review count, founder-only env reviewer, required check kept', async () => {
  const { byRepo } = await runScan();
  const r = byRepo['acme/compliant'];
  assert.strictEqual(r.status, 'COMPLIANT');
  assert.deepStrictEqual(r.findings, []);
  assert.deepStrictEqual(r.safeguards.required_status_checks, ['required-checks']);
  assert.deepStrictEqual(r.advisories, []);
});

test('noncompliant repo: branch-protection count, code-owner gate and org ruleset count are all reported', async () => {
  const { byRepo } = await runScan();
  const r = byRepo['acme/noncompliant'];
  assert.strictEqual(r.status, 'NONCOMPLIANT');
  assert.ok(r.findings.includes('branch_protection.required_approving_review_count=1'));
  assert.ok(r.findings.includes('branch_protection.require_code_owner_reviews=true'));
  assert.ok(r.findings.some((f) => f.startsWith('ruleset[Organization:acme#7].required_approving_review_count=2')));
});

test('missing permission is UNVERIFIED, never COMPLIANT', async () => {
  const { byRepo } = await runScan();
  const r = byRepo['acme/missing-permission'];
  assert.strictEqual(r.status, 'UNVERIFIED');
  assert.strictEqual(r.unverified.length, 2);
  assert.match(r.unverified[0], /HTTP 403/);
});

test('repo absent from coverage is flagged NEW_REPO; archived repos are skipped', async () => {
  const { byRepo } = await runScan();
  assert.strictEqual(byRepo['acme/brand-new'].new_repo, true);
  assert.strictEqual(byRepo['acme/brand-new'].status, 'COMPLIANT');
  assert.strictEqual(byRepo['acme/compliant'].new_repo, false);
  assert.ok(!byRepo['acme/old']);
});

test('blocking keys cover NONCOMPLIANT, NEW_REPO and unaccepted UNVERIFIED', async () => {
  const { results, ownerErrors } = await runScan();
  const keys = m.blockingFindings(results, ownerErrors);
  assert.ok(keys.includes('NEW_REPO|acme/brand-new'));
  assert.ok(keys.includes('UNVERIFIED|acme/missing-permission'));
  assert.ok(keys.some((k) => k.startsWith('NONCOMPLIANT|acme/noncompliant|')));
  assert.ok(!keys.some((k) => k.includes('acme/compliant|')));
});

test('accepted UNVERIFIED and documented EXCEPTION do not block, but keep their status', async () => {
  const b = JSON.parse(JSON.stringify(baseline));
  b.repos['acme/missing-permission'] = { accepted_status: 'UNVERIFIED', unverified_reason: 'plan-limited' };
  b.repos['acme/noncompliant'] = { accepted_status: 'COMPLIANT', exception: 'contractual SoD (fixture)' };
  b.repos['acme/brand-new'] = { accepted_status: 'COMPLIANT' };
  const { results, ownerErrors, byRepo } = await runScan(b);
  assert.strictEqual(byRepo['acme/missing-permission'].status, 'UNVERIFIED');
  assert.strictEqual(byRepo['acme/noncompliant'].status, 'EXCEPTION');
  assert.deepStrictEqual(m.blockingFindings(results, ownerErrors), []);
});

test('owner that cannot be listed is reported as UNVERIFIED_OWNER', async () => {
  const b = { ...baseline, owners: ['acme', 'ghost'] };
  const { results, ownerErrors } = await runScan(b);
  assert.strictEqual(ownerErrors.length, 1);
  assert.ok(m.blockingFindings(results, ownerErrors).some((k) => k.startsWith('UNVERIFIED_OWNER|ghost|')));
});

test('founder account: private repos come from /user/repos; public-only fallback is UNVERIFIED_OWNER', async () => {
  const ok = (repo) => ({
    [`GET /repos/${repo}/branches/main/protection`]: { status: 404, body: { message: 'Branch not protected' } },
    [`GET /repos/${repo}/rules/branches/main`]: { status: 200, body: [] },
    [`GET /repos/${repo}/environments`]: { status: 200, body: { environments: [] } },
  });
  const b = { founder: 'founder', owners: ['founder'], repos: {} };
  const userFx = {
    'GET /user/repos?affiliation=owner&per_page=100&page=1': { status: 200, body: [
      { full_name: 'founder/private-one', default_branch: 'main', private: true, owner: { login: 'founder' } },
      { full_name: 'someorg/not-mine', default_branch: 'main', owner: { login: 'someorg' } },
    ] },
    ...ok('founder/private-one'),
  };
  let res = await m.scan(m.fixtureClient(userFx), b);
  assert.deepStrictEqual(res.results.map((r) => r.repo), ['founder/private-one']);
  assert.deepStrictEqual(res.ownerErrors, []);

  const instFx = {
    'GET /installation/repositories?per_page=100': { status: 200, body: { total_count: 1, repositories: [
      { full_name: 'founder/private-one', default_branch: 'main', owner: { login: 'founder' } },
    ] } },
    ...ok('founder/private-one'),
  };
  res = await m.scan(m.fixtureClient(instFx), b);
  assert.deepStrictEqual(res.results.map((r) => r.repo), ['founder/private-one']);

  const pubFx = {
    'GET /users/founder/repos?type=owner&per_page=100&page=1': { status: 200, body: [
      { full_name: 'founder/public-one', default_branch: 'main', owner: { login: 'founder' } },
    ] },
    ...ok('founder/public-one'),
  };
  res = await m.scan(m.fixtureClient(pubFx), b);
  assert.deepStrictEqual(res.results.map((r) => r.repo), ['founder/public-one']);
  assert.ok(m.blockingFindings(res.results, res.ownerErrors).some((k) => k.startsWith('UNVERIFIED_OWNER|founder|private repos not listable')));
});

test('plan-limited private repo: GraphQL zero rules => COMPLIANT with basis; GraphQL gate => NONCOMPLIANT; GraphQL error => UNVERIFIED', async () => {
  const limited = { status: 403, body: { message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' } };
  const repoFx = (name) => ({
    [`GET /repos/free/${name}/branches/main/protection`]: limited,
    [`GET /repos/free/${name}/rules/branches/main`]: limited,
    [`GET /repos/free/${name}/environments`]: { status: 200, body: { environments: [] } },
  });
  const gql = (rules, rulesets, prs) => ({ status: 200, body: { data: { repository: {
    branchProtectionRules: { totalCount: rules.length, nodes: rules },
    rulesets: { totalCount: rulesets.length, nodes: rulesets },
    pullRequests: { nodes: prs } } } } });
  const fx = {
    'GET /orgs/free/repos?type=all&per_page=100&page=1': { status: 200, body: ['clean', 'gated', 'pr-blocked', 'broken'].map((n) => ({ full_name: `free/${n}`, default_branch: 'main' })) },
    ...repoFx('clean'), ...repoFx('gated'), ...repoFx('pr-blocked'), ...repoFx('broken'),
    'POST /graphql free/clean': gql([], [], [{ number: 1, reviewDecision: null }]),
    'POST /graphql free/gated': gql([], [{ name: 'org-default', enforcement: 'ACTIVE', rules: { nodes: [{ type: 'PULL_REQUEST', parameters: { requiredApprovingReviewCount: 1, requireCodeOwnerReview: false } }] } }], []),
    'POST /graphql free/pr-blocked': gql([{ pattern: 'main', requiredApprovingReviewCount: 0, requiresCodeOwnerReviews: false }], [], [{ number: 7, reviewDecision: 'REVIEW_REQUIRED' }]),
    'POST /graphql free/broken': { status: 200, body: { errors: [{ message: 'Resource not accessible by integration' }] } },
  };
  const { results } = await m.scan(m.fixtureClient(fx), { founder: 'founder', owners: ['free'], repos: {} });
  const by = Object.fromEntries(results.map((r) => [r.repo, r]));
  assert.strictEqual(by['free/clean'].status, 'COMPLIANT');
  assert.match(by['free/clean'].basis, /graphql/);
  assert.deepStrictEqual(by['free/clean'].graphql_evidence, { branch_protection_rules: 0, rulesets: 0, open_prs_checked: 1 });
  assert.strictEqual(by['free/gated'].status, 'NONCOMPLIANT');
  assert.ok(by['free/gated'].findings[0].includes('ruleset[org-default:ACTIVE].required_approving_review_count=1'));
  assert.strictEqual(by['free/pr-blocked'].status, 'NONCOMPLIANT');
  assert.ok(by['free/pr-blocked'].findings.includes('graphql.open_pr#7.reviewDecision=REVIEW_REQUIRED'));
  assert.strictEqual(by['free/broken'].status, 'UNVERIFIED');
  assert.ok(by['free/broken'].unverified.some((u) => u.includes('Resource not accessible by integration')));
});

test('non-plan-limited 403 (missing permission) does not use the GraphQL fallback', async () => {
  const { results } = await m.scan(m.fixtureClient(fleet), baseline);
  const r = results.find((x) => x.repo === 'acme/missing-permission');
  assert.strictEqual(r.status, 'UNVERIFIED');
  assert.strictEqual(r.basis, undefined);
});

test('owner without an installation token is uncovered; only a ledger owner_exception accepts it', async () => {
  const b = { ...baseline, owners: ['acme', 'no-app'], repos: { ...baseline.repos, 'acme/brand-new': { accepted_status: 'COMPLIANT' } } };
  const hasToken = (o) => o !== 'no-app';
  let { results, ownerErrors } = await m.scan(m.fixtureClient(fleet), b, { hasToken });
  assert.deepStrictEqual(ownerErrors.map((e) => e.owner), ['no-app']);
  assert.ok(m.blockingFindings(results, ownerErrors).some((k) => k.startsWith('UNVERIFIED_OWNER|no-app|no app installation token')));
  ({ results, ownerErrors } = await m.scan(m.fixtureClient(fleet), { ...b, owner_exceptions: { 'no-app': 'documented gap (test)' } }, { hasToken }));
  assert.strictEqual(ownerErrors[0].accepted, true);
  assert.ok(!m.blockingFindings(results, ownerErrors).some((k) => k.includes('no-app')));
  assert.ok(results.some((r) => r.repo === 'acme/compliant'), 'covered owners are still scanned');
});

test('owner_exceptions never excuse other owner failures', async () => {
  const b = { ...baseline, owners: ['ghost'], owner_exceptions: { ghost: 'only covers missing token' } };
  const { results, ownerErrors } = await m.scan(m.fixtureClient(fleet), b);
  assert.ok(m.blockingFindings(results, ownerErrors).some((k) => k.startsWith('UNVERIFIED_OWNER|ghost|HTTP 404')));
});

test('--update-baseline promotes a re-verified repo from accepted UNVERIFIED to COMPLIANT', () => {
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-ratchet-'));
  const b = JSON.parse(JSON.stringify(baseline));
  b.repos['acme/compliant'] = { accepted_status: 'UNVERIFIED', unverified_reason: 'old gap' };
  const bp = path.join(dir, 'b.json');
  fs.writeFileSync(bp, JSON.stringify(b));
  execFileSync(process.execPath, [path.join(__dirname, '..', 'governance-monitor.js'), 'scan', '--update-baseline',
    '--fixtures', path.join(FIX, 'governance-fleet.json'), '--baseline', bp], { stdio: 'pipe' });
  const after = JSON.parse(fs.readFileSync(bp, 'utf8')).repos;
  assert.deepStrictEqual(after['acme/compliant'], { accepted_status: 'COMPLIANT' });
  assert.strictEqual(after['acme/missing-permission'].accepted_status, 'UNVERIFIED');
});

test('environment gates: non-founder reviewer and prevent_self_review are noncompliant', () => {
  const ok200 = { status: 200, body: [] };
  const r = m.classifyRepo({
    repo: 'x/y', founder: 'founder',
    protection: { status: 404, body: { message: 'Branch not protected' } },
    rules: ok200,
    environments: { status: 200, body: { environments: [{ name: 'prod', protection_rules: [
      { type: 'required_reviewers', prevent_self_review: true, reviewers: [{ reviewer: { login: 'someone-else' } }] },
    ] }] } },
  });
  assert.strictEqual(r.status, 'NONCOMPLIANT');
  assert.deepStrictEqual(r.findings, ['environment[prod].required_reviewers=someone-else', 'environment[prod].prevent_self_review=true']);
});

test('unknown ruleset rule type is UNVERIFIED', () => {
  const r = m.classifyRepo({
    repo: 'x/y', founder: 'founder',
    protection: { status: 404, body: { message: 'Branch not protected' } },
    rules: { status: 200, body: [{ type: 'future_human_gate', ruleset_id: 1 }] },
    environments: { status: 404, body: {} },
  });
  assert.strictEqual(r.status, 'UNVERIFIED');
});

test('PR required with no required check yields a non-blocking advisory', () => {
  const r = m.classifyRepo({
    repo: 'x/y', founder: 'founder',
    protection: { status: 200, body: { required_pull_request_reviews: { required_approving_review_count: 0 }, required_status_checks: null } },
    rules: { status: 200, body: [] },
    environments: { status: 200, body: { environments: [] } },
  });
  assert.strictEqual(r.status, 'COMPLIANT');
  assert.strictEqual(r.advisories.length, 1);
});

test('fingerprint is order-independent after sorting and changes with findings', () => {
  assert.strictEqual(m.fingerprint(['a', 'b']), m.fingerprint(['a', 'b']));
  assert.notStrictEqual(m.fingerprint(['a']), m.fingerprint(['a', 'b']));
});

const ISSUES = '/repos/o/r/issues';
const WRITE_OK = {
  [`POST ${ISSUES}`]: { status: 201, body: { number: 99 } },
  [`PATCH ${ISSUES}/5`]: { status: 200, body: {} },
  [`POST ${ISSUES}/5/comments`]: { status: 201, body: {} },
};

async function alertWith(report, open, writes = WRITE_OK) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-'));
  const rp = path.join(dir, 'r.json');
  const fxPath = path.join(dir, 'fx.json');
  fs.writeFileSync(rp, JSON.stringify(report));
  fs.writeFileSync(fxPath, JSON.stringify({ ...writes, [`GET ${ISSUES}?state=open&labels=governance-drift&per_page=100`]: { status: 200, body: open } }));
  return m.cmdAlert({ report: rp, repo: 'o/r', fixtures: fxPath });
}

const dirty = { generated_at: 't', founder: 'f', summary: { counts: {}, blocking: ['NEW_REPO|a/b'], fingerprint: 'abc123' }, results: [] };
const clean = { generated_at: 't', founder: 'f', summary: { counts: {}, blocking: [], fingerprint: 'e3b0' }, results: [] };

test('alert dedup: creates once, unchanged on same fingerprint, updates on change, closes when clean', async () => {
  assert.strictEqual((await alertWith(dirty, [])).action, 'created');
  assert.strictEqual((await alertWith(dirty, [{ number: 5, body: 'x <!-- governance-monitor-fingerprint:abc123 -->' }])).action, 'unchanged');
  assert.strictEqual((await alertWith(dirty, [{ number: 5, body: 'x <!-- governance-monitor-fingerprint:old -->' }])).action, 'updated');
  assert.strictEqual((await alertWith(clean, [{ number: 5, body: '' }])).action, 'closed');
  assert.strictEqual((await alertWith(clean, [])).action, 'none');
});

test('alert fails loudly when the issue write is rejected', async () => {
  await assert.rejects(alertWith(dirty, [], {}), /POST \/repos\/o\/r\/issues failed: HTTP 404/);
});

test('CLI scan writes report and exits 1 on blocking findings', async () => {
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-cli-'));
  let code = 0;
  try {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'governance-monitor.js'), 'scan',
      '--fixtures', path.join(FIX, 'governance-fleet.json'), '--baseline', path.join(FIX, 'governance-baseline.json'), '--out', dir], { stdio: 'pipe' });
  } catch (e) { code = e.status; }
  assert.strictEqual(code, 1);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'approval-governance.json'), 'utf8'));
  assert.strictEqual(report.summary.counts.NONCOMPLIANT, 1);
  assert.ok(fs.readFileSync(path.join(dir, 'approval-governance.md'), 'utf8').includes('never reported as compliant'));
});
