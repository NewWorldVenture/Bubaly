# Mobile Production-Readiness — Route & Screen Inventory

Phase 1/3 inventory. **This is a SKELETON** — the app has **200+ `(app)/dashboard`
routes** and **104 module components**, so it is seeded with the schema, the risk
heuristic, and the highest-priority rows. A resuming bot expands it route-by-route
as it audits (Phase 3), flipping `Test`/`Resolution` as work lands. Pairs with
`MOBILE_PROGRESS.md` + `MOBILE_TODO.md`.

## Columns
`Route` · `Screen/feature` · `Role` · `Tier` · `Data source (Supabase tables /
service)` · `Mobile risk` · `Test status` · `Resolution`

## Mobile-risk heuristic (how to triage a route fast)
- **HIGH:** wide tables/data grids, chat/messaging, file/photo upload + camera,
  calendars, maps, multi-step forms, payment/checkout, drag-and-drop, anything with
  `group-hover` row actions (see M-005), full-height panels.
- **MED:** standard forms, list + detail, modals/drawers, dashboards with charts.
- **LOW:** static content, legal, simple read-only cards.

## Global fixes already applied (cover every route)
- Inputs ≥16px on touch → no iOS zoom (M-002, `app/globals.css`).
- Full-height panels use `dvh` (M-001).
- Tables scroll-wrapped, ratcheted (M-003).
- Viewport `viewportFit: cover` + safe-area vars; PWA manifest + service worker.

---

## Seeded rows — critical journeys + known-HIGH-risk screens

| Route | Screen/feature | Role | Data source | Mobile risk | Test | Resolution |
|-------|----------------|------|-------------|-------------|------|------------|
| `/login` `/signup` `/kid-login` `/welcome` | Auth | all/anon | Supabase auth | MED | ⏳ | inputs typed+autocomplete ✓ (M-002 verified) |
| `/(auth)` OTP / phone / magic-link | Passwordless | anon | auth | HIGH | ⏳ | OTP+phone keyboard ✓ (M-002); redirect-return on device untested |
| `/dashboard` (index) `/command-center` | Home dashboard | member | many | HIGH | ⏳ | command-center has group-hover (M-005) |
| `/dashboard/messages` | Messaging | member | messages | HIGH | ⏳ | dvh ✓ (M-001); group-hover:841 (M-005) |
| `/dashboard/concierge` `/front-desk` `/inbox` | Chat / desk / inbox | member | comms | HIGH | ⏳ | dvh + back/archive labeled ✓ (M-001/M-004); more group-hover (M-005) |
| `/dashboard/calendar` | Calendar | member | calendar_events | HIGH | ⏳ | side-by-side + today fix done (PLA-0823); mobile density unaudited |
| `/dashboard/photos` `/memories` | Photos / albums | member | family_photos, storage | HIGH | ⏳ | a11y labels ✓ (PLA-0822); upload-on-device + HEIC untested; carousels ok (M-003) |
| `/dashboard/documents` `/files/*` | Docs / files | member | documents, storage | HIGH | ⏳ | tables wrapped ✓; upload dropzone keyboard gap flagged (A-11); group-hover (M-005) |
| `/dashboard/shopping` `/grocery` | Lists | member | shopping_* | MED | ⏳ | edit labeled ✓ (M-004); group-hover:191/289 + grocery:244 (M-005) |
| `/dashboard/notes` `/journal` | Notes | member | notes | MED | ⏳ | group-hover:280/338 (M-005) |
| `/marketplace/**` | Marketplace + checkout | member | marketplace_* | HIGH | ⏳ | payment dup-tap + mobile checkout return untested |
| `/wallet` `/dashboard/billing` `/payments` | Money / billing | member | wallet_*, stripe | HIGH | ⏳ | billing group-hover:1468 (M-005); Stripe mobile return untested |
| `/(app)/admin/**` (super admin) | Admin console | admin | cross-tenant | MED | ⏳ | many wide tables (wrapped ✓); marketing SEO/AEO perf done (PLA-0832) |
| `/kids/**` `/missions` | Kid flows | child | chores/missions | MED | ⏳ | kids shell dvh ✓ (M-001); submit button has text ✓ |

Legend: ⏳ pending · 🔬 tested · ✅ passed · 🚫 blocked (external).

## Not yet inventoried (bulk — expand during Phase 3)
The remaining ~190 dashboard routes (auto/*, home/*, vacations/*, social/*,
family-*, health/medical, trips, etc.) and their modules. Add rows as audited.
Fastest path: audit **by module component** (`components/modules/*.tsx`, 104 files)
since most routes render one module — fix a module once and it covers its route(s).
