# Page audit lane HOME — Home, display, capture and the app shell pages

Owning unit (docs/audit/COORDINATION.md §2): **A-05**. Protocol: docs/audit/pages/README.md.

## Claim

| Agent | Claimed (UTC) | Heartbeat (UTC) | State |
|---|---|---|---|
| Claude-1 (session c1fd8263) | 2026-09-27 12:55 | 2026-09-27 12:55 | FREE |

## Pages

| Route | Source | Status | Checked (UTC) | By | Notes |
|---|---|---|---|---|---|
| `/capture/link` | `app/(app)/capture/link/page.tsx` | UNAUDITED | — | — |  |
| `/capture` | `app/(app)/capture/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/home/assets/[id]` | `app/(app)/dashboard/home/assets/[id]/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/home/diagnose` | `app/(app)/dashboard/home/diagnose/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/home/maintenance` | `app/(app)/dashboard/home/maintenance/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/home` | `app/(app)/dashboard/home/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/home/pros` | `app/(app)/dashboard/home/pros/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/home/service` | `app/(app)/dashboard/home/service/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/home/warranties` | `app/(app)/dashboard/home/warranties/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard` | `app/(app)/dashboard/page.tsx` | UNAUDITED | — | — |  |
| `/display` | `app/(app)/display/page.tsx` | FIXED | 2026-09-27 12:55 | Claude-1 | C1-S9-99 @ dd0e92be: 12px overflow (clock/weather row did not wrap). Remaining: 22 hardcoded string(s) in its own files — C1-S9-101. |
| `/display/setup` | `app/(app)/display/setup/page.tsx` | UNAUDITED | — | — |  |
| `/feedback` | `app/(app)/feedback/page.tsx` | UNAUDITED | — | — |  |
| `/home` | `app/(app)/home/page.tsx` | UNAUDITED | — | — |  |
| `/referrals` | `app/(app)/referrals/page.tsx` | UNAUDITED | — | — |  |
| `/services/[category]` | `app/(app)/services/[category]/page.tsx` | UNAUDITED | — | — |  |
| `/services` | `app/(app)/services/page.tsx` | UNAUDITED | — | — |  |
