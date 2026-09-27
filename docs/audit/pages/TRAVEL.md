# Page audit lane TRAVEL — Vacations, trips, concierge, trip intel

Owning unit (docs/audit/COORDINATION.md §2): **A-13**. Protocol: docs/audit/pages/README.md.

## Claim

| Agent | Claimed (UTC) | Heartbeat (UTC) | State |
|---|---|---|---|
| Claude-1 (session c1fd8263) | 2026-09-27 12:55 | 2026-09-27 12:55 | FREE |

## Pages

| Route | Source | Status | Checked (UTC) | By | Notes |
|---|---|---|---|---|---|
| `/dashboard/concierge` | `app/(app)/dashboard/concierge/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/concierge/runs/[id]` | `app/(app)/dashboard/concierge/runs/[id]/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/concierge/runs` | `app/(app)/dashboard/concierge/runs/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/trip-intel` | `app/(app)/dashboard/trip-intel/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/trips` | `app/(app)/dashboard/trips/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/vacations/[id]/activities` | `app/(app)/dashboard/vacations/[id]/activities/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/vacations/[id]/ai-assistant` | `app/(app)/dashboard/vacations/[id]/ai-assistant/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/vacations/[id]/budget` | `app/(app)/dashboard/vacations/[id]/budget/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/vacations/[id]/documents` | `app/(app)/dashboard/vacations/[id]/documents/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/vacations/[id]/emergency` | `app/(app)/dashboard/vacations/[id]/emergency/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/vacations/[id]/family` | `app/(app)/dashboard/vacations/[id]/family/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/vacations/[id]/itinerary` | `app/(app)/dashboard/vacations/[id]/itinerary/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/vacations/[id]/lodging` | `app/(app)/dashboard/vacations/[id]/lodging/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/vacations/[id]/overview` | `app/(app)/dashboard/vacations/[id]/overview/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/vacations/[id]/packing` | `app/(app)/dashboard/vacations/[id]/packing/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/vacations/[id]` | `app/(app)/dashboard/vacations/[id]/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/vacations/[id]/travel` | `app/(app)/dashboard/vacations/[id]/travel/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/vacations/[id]/weather` | `app/(app)/dashboard/vacations/[id]/weather/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/vacations/calendar` | `app/(app)/dashboard/vacations/calendar/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/vacations/new` | `app/(app)/dashboard/vacations/new/page.tsx` | FIXED | 2026-09-27 12:55 | Claude-1 | C1-S9-96 @ 48df75c0: dialog open on arrival failed hydration; useHydrated gate. Remaining: 3 hardcoded string(s) in its own files — C1-S9-101. |
| `/dashboard/vacations` | `app/(app)/dashboard/vacations/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/vacations/reports` | `app/(app)/dashboard/vacations/reports/page.tsx` | UNAUDITED | — | — |  |
| `/dashboard/weekend` | `app/(app)/dashboard/weekend/page.tsx` | UNAUDITED | — | — |  |
