# Production static-data audit

Audit date: 2026-06-22

Scope: all 180 `page.tsx` routes, 43 API routes, 133 production components, server actions, `lib`, and Supabase migrations. Test fixtures, development-only seeds, navigation, enums, validation choices, design tokens, and required product defaults are classified as non-record configuration.

## Inventory and disposition

| Surface | Static production data found | Supabase mapping / correction | Schema change | Status |
|---|---|---|---|---|
| `/admin/admins` | Fabricated activity rows, hardcoded setting values, dead invite button, placeholder access requests | `audit_logs`, `admin_settings`, `admin_access_requests`, `admin_users`; real secure invite and audit write | `0058` | Fixed |
| Admin authentication | Built-in super-admin email and migration seed | `super_admins` + `is_super_admin()` only | Seed removed; cleanup in `0058` | Fixed |
| `/admin/support-tickets` | Sample tickets/admins in migration; dead create/export controls | `support_tickets`; real create form | Sample rows removed; duplicate migration renumbered to `0054` | Fixed |
| `/blog` | Fabricated popular articles/dates, dead search/load-more, two UI-only subscribe forms | `blog_posts`, `newsletter_subscribers`; server filtering and persisted subscription API | `0058` | Fixed |
| `/faq` | Local FAQ record array | public-read `site_faqs` with loading/empty/error behavior | `0058` | Fixed |
| Homepage/features/how-it-works | Fabricated family names, schedules, counts, testimonials | Approved `reviews`; non-record capability diagrams only | Existing `reviews` | Fixed |
| `/dashboard/meals` | Fake grocery list, calorie chart, macro percentages, meal ideas, dead controls | Live `grocery_items`; unsupported nutrition/idea panels removed | None | Fixed |
| `/dashboard/school` | “Resources coming soon” placeholder and dead controls | Family-scoped `school_resources` CRUD with realtime load/error/empty states | `0059` | Fixed |
| Chores/calendar/health/grocery/messages/sports/billing shells | No-op filter/more/report/AI controls | Removed controls with no real behavior; AI CTAs link to the persisted assistant | None | Fixed |
| Security/mobile marketing | Unverified compliance/uptime/Expo/offline claims and dead links | Claims reduced to implemented RLS, private storage, audit, TLS, Supabase, Capacitor behavior | None | Fixed |
| Blog migration | Fabricated blog posts | Admin-authored `blog_posts` only | Seed removed | Fixed |
| `seed_prod.sql` | Five fake families and high-volume fake records | Production seeding disabled | File made non-executable | Fixed |
| Apply bundle | Drifted hand-maintained SQL and seeded operator identity | Canonical ordered migrations only | Bundle deprecated and made non-executable | Fixed |
| Migration ordering | Duplicate versions `0010`, `0026`, `0042`, `0043` | Unique reconciliation versions `0054`-`0057`; `0060` guarantees `blog_posts` exists whichever historical `0010` ran | Files renumbered/reconciled | Fixed |

## Route-group verification

- Auth/onboarding/join: persisted auth, profiles, families, memberships, invitations.
- Family dashboards and modules: family-scoped Supabase queries and writes; record-shaped local fallbacks removed.
- Admin: service-role reads are guarded by database-backed `is_super_admin()`; sensitive mutations write `audit_logs`.
- Marketing: product copy/configuration remains code-owned; testimonials, articles, FAQs, reviews, subscriptions, forms, metrics, and other record data are Supabase-backed.
- APIs/cron/webhooks: request validation and authorization inspected; service-role credentials remain server-only.

## Deployment condition

The configured Supabase URL currently exposes `blog_posts`, but does not expose core `families` or the other audited application tables through PostgREST. The stored service credential is rejected, and the logged-in Supabase CLI account cannot link the project due to insufficient privileges. Repository changes are ready for a canonical `supabase db push`, but the live database cannot be described as updated until valid project access is supplied and the push succeeds.
