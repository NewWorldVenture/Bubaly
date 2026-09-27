# Page audit lane PUBLIC — Public marketing, legal and share pages

Owning unit (docs/audit/COORDINATION.md §2): **A-17**. Protocol: docs/audit/pages/README.md.

## Claim

| Agent | Claimed (UTC) | Heartbeat (UTC) | State |
|---|---|---|---|
| Claude-1 (session c1fd8263) | 2026-09-27 11:05 | 2026-09-27 12:55 | ACTIVE |

## Pages

| Route | Source | Status | Checked (UTC) | By | Notes |
|---|---|---|---|---|---|
| `/acceptable-use` | `app/(marketing)/acceptable-use/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/ai` | `app/(marketing)/ai/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/alternatives/[slug]` | `app/(marketing)/alternatives/[slug]/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): placeholder id only → 404; needs a published row to exercise. Static: no hardcoded copy. Read pending. |
| `/audiences/[slug]` | `app/(marketing)/audiences/[slug]/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): placeholder id only → 404; needs a published row to exercise. Static: no hardcoded copy. Read pending. |
| `/blog/[slug]` | `app/(marketing)/blog/[slug]/page.tsx` | FIXED | 2026-09-27 12:55 | Claude-1 | C1-S9-95 @ 5bf0112f: copy-link copied window.location, not the canonical URL. |
| `/blog` | `app/(marketing)/blog/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/compare/[slug]` | `app/(marketing)/compare/[slug]/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): placeholder id only → 404; needs a published row to exercise. Static: no hardcoded copy. Read pending. |
| `/contact` | `app/(marketing)/contact/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/cookies` | `app/(marketing)/cookies/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/customers/[slug]` | `app/(marketing)/customers/[slug]/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): placeholder id only → 404; needs a published row to exercise. Static: no hardcoded copy. Read pending. |
| `/f/[id]` | `app/(marketing)/f/[id]/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): placeholder id only → 404; needs a published row to exercise. Static: no hardcoded copy. Read pending. |
| `/family-display` | `app/(marketing)/family-display/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/faq` | `app/(marketing)/faq/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/features/[slug]` | `app/(marketing)/features/[slug]/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): placeholder id only → 404; needs a published row to exercise. Static: no hardcoded copy. Read pending. |
| `/features` | `app/(marketing)/features/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/glossary/[slug]` | `app/(marketing)/glossary/[slug]/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): placeholder id only → 404; needs a published row to exercise. Static: no hardcoded copy. Read pending. |
| `/guides/[slug]` | `app/(marketing)/guides/[slug]/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): placeholder id only → 404; needs a published row to exercise. Static: no hardcoded copy. Read pending. |
| `/how-it-works` | `app/(marketing)/how-it-works/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/lp/[slug]` | `app/(marketing)/lp/[slug]/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): placeholder id only → 404; needs a published row to exercise. Static: no hardcoded copy. Read pending. |
| `/mobile` | `app/(marketing)/mobile/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/p/[slug]` | `app/(marketing)/p/[slug]/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): placeholder id only → 404; needs a published row to exercise. Static: no hardcoded copy. Read pending. |
| `/` | `app/(marketing)/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/pricing` | `app/(marketing)/pricing/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/privacy` | `app/(marketing)/privacy/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/questions/[slug]` | `app/(marketing)/questions/[slug]/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): placeholder id only → 404; needs a published row to exercise. Static: no hardcoded copy. Read pending. |
| `/resources/[slug]` | `app/(marketing)/resources/[slug]/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): placeholder id only → 404; needs a published row to exercise. Static: no hardcoded copy. Read pending. |
| `/resources/benchmarks` | `app/(marketing)/resources/benchmarks/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 404, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/security` | `app/(marketing)/security/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/terms` | `app/(marketing)/terms/page.tsx` | IN PROGRESS | 2026-09-27 12:55 | Claude-1 | Anonymous crawl (local prod build): 200, no page errors, no raw keys, no overflow. Static: no hardcoded copy. Read pending. |
| `/gift/[token]` | `app/gift/[token]/page.tsx` | FIXED | 2026-09-27 12:55 | Claude-1 | C1-S9-100 @ dd78be77: English tab title. Remaining: 1 hardcoded string(s) in its own files — C1-S9-101. |
| `/join` | `app/join/page.tsx` | FIXED | 2026-09-27 12:55 | Claude-1 | C1-S9-100 @ dd78be77: English tab title and invite error. |
| `/offline` | `app/offline/page.tsx` | FIXED | 2026-09-27 12:55 | Claude-1 | C1-S9-100 @ dd78be77: English tab title. |
| `/pay/[handle]` | `app/pay/[handle]/page.tsx` | FIXED | 2026-09-27 12:55 | Claude-1 | C1-S9-100 @ dd78be77: English tab title. |
| `/reviews/new` | `app/reviews/new/page.tsx` | FIXED | 2026-09-27 12:55 | Claude-1 | C1-S9-100 @ dd78be77: English tab title, review buttons and star labels. |
| `/reviews` | `app/reviews/page.tsx` | FIXED | 2026-09-27 12:55 | Claude-1 | C1-S9-100 @ dd78be77: English tab title. |
| `/s/[slug]` | `app/s/[slug]/page.tsx` | FIXED | 2026-09-27 12:55 | Claude-1 | C1-S9-100 @ dd78be77: English tab title. |
