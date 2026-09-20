# Hosted source provenance and results

Pull-request CI checks GitHub's generated merge revision, which can include newer main commits than the PR branch has integrated. A trigger head identifies the proposed branch; the checkout log identifies the executed source. Vercel deployment results are separate.

| Trigger head | Executed merge | Main parent in checkout log | Browser result |
|---|---|---|---|
| 1956a9e0074b81c348eaa865d29d1366d16813a7 | 9ab9346b2bcae9cd81b0ad0e5e50a05ed0140e89 | 4abd08ed36d0678977f64c4abec2cc2e9a59b3ce | Run34713478585, job103606352274: 1,056 PASS, 7.9 minutes; no failed/flaky/skipped summary entries. Completed2026-09-12 19:27:20UTC. |
| cc91568425c9a3f42765b9230a39f3b3d3748428 | 40eb05d4f4af5d88fd6fcd6cf1d8a02bd7049515 | dace02669ea1cdd03ab9bd98bdb420f0940e0130 | Run34714322612, job103608614422: 1,055 PASS and one FLAKY, 8.7 minutes; no final failure. CI completed2026-09-12 19:45:10UTC. |

The latter quality job103608614348 passes 1,186 files /14,312 unit tests in158.28seconds, completed19:37:32UTC. Its extra incoming-main tests explain why its count differs from the earlier private 1,180-file /14,151-test Guardian gate. Database and mobile checks pass. Finance run34714322619 passes. The exact cc Vercel deployment3wPuTf8QcxRKk79kXji84Pypewqy passes, updated19:31:31UTC; preview https://bubaly-4of0z4jjg-newworldventure.vercel.app.

The flaky case is the first child-device PIN login, before submitting: the Sign in button stayed disabled until the 120-second test deadline. The retry passed. No failure artifact exists, so the log cannot establish the form's React state or the cause. See child-login-readiness-cycle.md for the separate controlled investigation. The real meal journey passed in both runs. Do not describe the latter run as a clean 1,056-case pass.

Evidence: sanitized job logs `Temp/bubaly-meal-hosted-e2e-34713478585-sanitized.log`, `Temp/bubaly-guardian-e2e-34714322612-sanitized.log`, and the child investigation `Temp/bubaly-child-pin-ci-flake-34714322612-evidence.md`. The prior checkpoint labels refer to trigger heads; this document records the actual recent checkout revisions.
