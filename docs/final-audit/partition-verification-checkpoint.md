# Session, audience and finance verification checkpoint

Application source: `b80e55bf8ebe46b695e412a1104ed45430e1bac9`. This continues draft [PR #510](https://github.com/NewWorldVenture/Bubaly/pull/510); it is not final production sign-off. The production audit remains incomplete.

## Changes verified

- AUTH-002 / DATA-002: persistent cache partitions use stable session and server access identity. Account/session/access changes retire previous rows and copied descendant state, including when storage deletion fails and the browser restarts. Normal token rotation and first agreeing restoration preserve forms. Two independently reproduced SDK event/error races were fixed and retested.
- PUSH-005: marketing audience, profile and suppression reads traverse complete bounded pages before sending. Incomplete or malformed reads fail visibly before delivery; retries after read recovery preserve consent and suppression behavior.
- DATA-003: finance loading, cache revalidation and read errors no longer appear as verified zero balances or successful empty results. Retry reaches the required reads and retains payment search state.

## Combined local gates

Tests ran from a git-archive snapshot in the existing private clean installation. The shared workspace dependency junction was not modified. Source and lockfile provenance are separate from deployed state; no live payment, messaging or account writes were performed locally.

| Check | Result | Evidence |
| --- | --- | --- |
| Full Vitest suite | PASS | 1,140 files / 12,782 tests, 77.56 seconds. |
| Strict TypeScript | PASS | Full `tsc --noEmit --incremental false --pretty false`, no diagnostics. The final generated route types match the already-checked artifact byte for byte. |
| Component/browser regression | PASS | 144 actual Chromium checks, 12.4 seconds: cache/session/SDK, PWA/native lifecycle, display clock/ownership and finance read states. |
| Full lint | PASS | Four unchanged baseline hook warnings; no new suppressions. |
| Query/schema reference audit | PASS | 484 declared tables, 77 functions, 136 API routes. This is source reference validation, not live authorization proof. |
| Translation gate | PASS | All declared gated surfaces. Three new auth status strings per base locale; all previous values and ordering preserved. There are eleven additions per locale across the complete PR. |
| Production build | PASS | Frozen source built successfully; 243 generated pages, shared first-load JS 103 kB and middleware 92.5 kB. |
| Final-build startup | PASS | Home readiness 2,089 ms; feature navigation 1,631 ms; no page errors. Localhost runner terminated normally. |

Private configuration uses `audit-fixture.invalid` and dummy Supabase credentials, with external email/payment/AI keys blank. Expected unavailable-provider fixture logs are not a blanket production console/network pass.

Temporary host evidence uses prefix `bubaly-partition-` and suffix `-20260912.log`: `units`, `types`, `components`, `lint`, `query-audit`, `i18n-gate`, `build`, `public-start`, and `public-probe`. The source archive is `bubaly-audit-partition-source-20260912.tar`.

The route-type SHA-256 before and after the production build is `3682dc788460e3c47d8cda480b7a5197d34ba886f230b9f26a415217518d9402`. The passed strict TypeScript check covers those exact final artifacts.

## CI provenance

This application checkpoint, published as `19a6907fdf906de3d44da583f2aa87a88298e697`, passed all four jobs in [CI run 34698217047](https://github.com/NewWorldVenture/Bubaly/actions/runs/34698217047). Its disposable Supabase browser job reports 576 passing tests in 4.5 minutes, including authenticated and durable-session workflows with no skips. Vercel deployment metadata also reports success; anonymous application probes encounter Vercel Authentication, as documented in vercel-preview-19a6907f.md. The earlier 9d238e0c checkpoint separately passed all four jobs in run34697312616 with 540 browser tests. Neither earlier result is substituted for later social/rewards source verification.

## Remaining limits

The cache partition does not prove immediate recognition of an unobserved remote permission change while offline, encrypt undeletable disk data, or provide a cold offline authenticated shell. Deployed provider/session policy and physical device behavior remain separate.

Marketing pagination is not a transactional snapshot of changing consent/suppressions. Campaign failure/status/recovery and distributed delivery receipts remain open. Finance full CRUD, authorization, persisted readback and complete transaction totals are not signed off by presentation tests. Seventeen additional shared-hook callers still omit read errors.

The master `finalaudit.md` retains these limitations, the remaining privacy and social publishing defects, the permanent discovery records, and the pending second whole audit regression. Production readiness remains **NO**.
