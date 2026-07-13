# User Journeys

Status of the core end-to-end journeys (deep-dive records in `todo.md` + `docs/AGENT_HANDOFF.md`).

| Journey | Status | Notes |
|---|---|---|
| First visit → pricing → live demo | ✅ hardened | Email gate → 5-min demo clock → upgrade path; one-demo-per-email; leads captured to CRM |
| Registration → onboarding → first value | ✅ audited | Value-first wizard; replay-safe finalize (no duplicate families); welcome email sends; lifecycle tracked in `onboarding_progress` |
| Invite member → accept | ✅ | Invite flow + role assignment; pending-invite states |
| Daily use: home brief → calendar → chores → messages | ✅ deep-dived | Messages (voice notes, read receipts) + Calendar (recurrence, edit/delete) fixed in dedicated passes |
| Kid login (PIN) | ✅ | Brute-force throttle (0137) |
| Wallet: allowance → chores → spend | ✅ to key-boundary | Real-time card auth gate; Issuing flip-live checklist in production-readiness.md |
| Provider calendar sync connect → two-way sync | ✅ to key-boundary | Google + Microsoft end-to-end; 4h background sync |
| Offline → reconnect | ✅ v1 | Read-cache + banner + auto-resync; offline writes = deferred v2 (owner scope) |
| Plan upgrade/cancel/trial expiry | ✅ | 5-day trial paywall gate; Stripe checkout; grandfathered existing families |
| Account closure | ✅ | Soft close (`closed_at`), reopenable |
| Long-absence return | ✅ | Since-yesterday recap + daily brief rebuild context |
