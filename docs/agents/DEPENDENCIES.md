# DEPENDENCIES

Cross-unit dependencies that gate verification. Most launch-blocking dependencies
are external/owner-held (see `docs/LAUNCH_BLOCKERS.md`).

| Dependent unit | Depends on | Kind | Status |
|----------------|-----------|------|--------|
| A-08 wallet / A-17 admin / A-14 marketplace | prod migrations 0217/0219/0221/0224 applied | external (human-owned prod apply) | BLOCKED — fixes committed + PG16-proven |
| A-03 Auth Admin live paths | live GoTrue Auth Admin 500 fix | external (owner/infra) | BLOCKED |
| A-09 billing / A-18 integrations live smokes | Stripe/Twilio/Resend/Google real keys | external (credentials) | BLOCKED |
| A-20 authed E2E | Supabase test login + keys | external | BLOCKED |
| A-01 CI green | GitHub Actions runner availability (LB-015) | external (org billing) | BLOCKED — code gates pass locally |
| All units | integration gate (tsc/vitest/build) staying green | internal | GREEN at f17d0275 (QA-01 keeps warm) |

No internal code dependency currently blocks agent progress; the open
dependencies are all external/owner-held. Continue unblocked audit units.
