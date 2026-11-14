# Faraday Review shadow enrollment

Status: **DRAFT, inactive.** The reusable `shadow.yml` it calls was merged in
`faraday-build/faraday-review` PR #4 as merge commit
`6407cab707815c538d0fb94241ce4e07feda8946` (2026-11-13). PR #7 (agent-contracts v0.4.0
execution identity) was merged on top of it as merge commit
`b9002669fcc71f347f2cd91d4999a9b48fe4db78` (2026-11-14); this caller is pinned
to that commit.

## What it does
`.github/workflows/faraday-review.yml` calls the reusable Faraday Review shadow
workflow on each pull request. It posts the `faraday-review / governed-summary`
check and one summary comment, and uploads `decision.json`, `telemetry.jsonl`
and `run-binding.json` as an artifact that is retained for 90 days. **It does
not approve or merge**: approval and merge stay false for every class in
Phase 1, and ADR-0012 stays binding.

It is **not** a required status check. Branch protection on `main` keeps
`required-checks` as its only required check, and that does not change.

The workflow does not use the Ecosystem Drift Gate, the permission probe, the
`faraday-ci-bot` App or any secret. It uses only the ambient `GITHUB_TOKEN`
with `contents: read`, `pull-requests: write`, `checks: write` and
`actions: read`.

## Activation (operator or founder; not done by this PR)
1. Done: faraday-review PR #4 merged as `6407cab707815c538d0fb94241ce4e07feda8946`;
   PR #7 merged on top as `b9002669fcc71f347f2cd91d4999a9b48fe4db78`, and both
   reviewer-SHA occurrences in the caller are pinned to the #7 merge.
2. Verify the live permissions and protection before you enable anything:
   ```bash
   gh api repos/tomrivera-ops/ecosystem-audit/branches/main/protection \
     --jq '{checks:.required_status_checks.contexts,admins:.enforce_admins.enabled,reviews:.required_pull_request_reviews.required_approving_review_count}'
   # expected: {"checks":["required-checks"],"admins":true,"reviews":0}
   ```
3. Set the variables:
   ```bash
   gh variable set FARADAY_POLICY_DIGEST -R tomrivera-ops/ecosystem-audit \
     --body "sha256:32eeb3e07271fff267908bc428d77477caa403d9e0f8b0a0244d8c26aec73e12"
   gh variable set FARADAY_REVIEW_SHADOW_ENABLED -R tomrivera-ops/ecosystem-audit --body true
   ```
   If `FARADAY_POLICY_DIGEST` is unset or empty, every run Blocks with
   `policy_digest_unpinned`.
4. Create the founder adjudication labels:
   `faraday/founder-green`, `faraday/founder-yellow`, `faraday/founder-red`,
   `faraday/founder-block`.
5. Open one smoke-test PR. Confirm a single governed summary appears and
   nothing is approved or merged. Record that PR in faraday-review
   `docs/qualification/synthetic-prs.json` so it never counts toward the
   20-real-PR gate.

## Exact-SHA binding check
On each run, `run-binding.json` must show:
- `head_sha` equal to the PR head;
- `reviewer_sha` equal to the pinned SHA;
- `governance_sha` equal to `1b98ab9…`.

The reusable workflow also refuses a run if the caller's `uses:` SHA and
`reviewer_sha` differ.

## Rollback
Unset `FARADAY_REVIEW_SHADOW_ENABLED`, which skips the job immediately. You
can also remove the workflow through a PR. Keep the artifacts: they are
qualification evidence.
