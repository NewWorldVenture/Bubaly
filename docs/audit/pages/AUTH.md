# Page audit lane AUTH — Sign-in, sign-up, kid login, onboarding

Owning unit (docs/audit/COORDINATION.md §2): **A-03/A-04**. Protocol: docs/audit/pages/README.md.

## Claim

| Agent | Claimed (UTC) | Heartbeat (UTC) | State |
|---|---|---|---|
| Claude-1 (session c1fd8263) | 2026-09-27 11:05 | 2026-09-27 12:55 | ACTIVE |

## Pages

| Route | Source | Status | Checked (UTC) | By | Notes |
|---|---|---|---|---|---|
| `/auth/step-up` | `app/(app)/auth/step-up/page.tsx` | FIXED | 2026-09-27 12:55 | Claude-1 | C1-S9-100 @ dd78be77: English tab title. |
| `/auth/complete` | `app/(auth)/auth/complete/page.tsx` | FIXED | 2026-09-27 12:55 | Claude-1 | C1-S9-100 @ dd78be77: English tab title. Remaining: 3 hardcoded string(s) in its own files — C1-S9-101. |
| `/auth/recovery` | `app/(auth)/auth/recovery/page.tsx` | FIXED | 2026-09-27 12:55 | Claude-1 | C1-S9-100 @ dd78be77: English tab title. Remaining: 2 hardcoded string(s) in its own files — C1-S9-101. |
| `/auth/signout/complete` | `app/(auth)/auth/signout/complete/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/kid-login` | `app/(auth)/kid-login/page.tsx` | FIXED | 2026-09-27 12:55 | Claude-1 | C1-S9-100 @ dd78be77: English tab title. |
| `/login` | `app/(auth)/login/page.tsx` | FIXED | 2026-09-27 12:55 | Claude-1 | C1-S9-100 @ dd78be77: English tab title. Remaining: 2 hardcoded string(s) in its own files — C1-S9-101. |
| `/signup` | `app/(auth)/signup/page.tsx` | FIXED | 2026-09-27 12:55 | Claude-1 | C1-S9-100 @ dd78be77: English tab title. |
| `/welcome` | `app/(auth)/welcome/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/onboarding` | `app/onboarding/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200 → /login?redirect=%2Fonboarding, no page errors, no raw keys, no overflow. Static: 2 flagged string(s) — see C1-S9-100 (not copy / I18N-001). Read pending. |
