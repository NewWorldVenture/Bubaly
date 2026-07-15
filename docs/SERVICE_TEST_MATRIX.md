# Service Test Matrix

This matrix is the launch audit index. A service is not complete until its route surfaces, roles,
workflows, Supabase wiring, failure states, responsive states, accessibility, and deployment behavior
have evidence in the issue ledger and a pushed commit.

| Service | Primary route surfaces | Roles to verify | Required test layers | Current status | Next evidence |
| --- | --- | --- | --- | --- | --- |
| Auth and tenant isolation | `/login`, `/signup`, middleware, family switch | anonymous, member, child, parent, admin | unit, API, RLS, E2E, security | In progress | `tests/admin-auth-boundary.test.ts` plus `tests/tenant-isolation-rls.test.ts`; migration 0211 repairs membership self-update drift, while live Auth Admin health and cross-family probes remain |
| Onboarding and invitations | `/onboarding`, `/join`, family settings | owner, parent, guardian, member, invited user | integration, API, E2E, email | In progress | Keyed replay regression passes; live invite expiry, role change, tier gates and authenticated browser flows remain |
| Home and dashboards | `/home`, `/dashboard/*` | parent, child, admin | component, E2E, responsive, accessibility | In progress | Action-by-action dashboard traversal |
| Calendar and planning | `/calendar`, `/dashboard/calendar`, planning routes | all family roles | unit, integration, sync, E2E | In progress | Recurrence, conflict and provider failure matrix |
| Chores and missions | `/missions`, `/kids`, `/parent` | child, parent, guardian | unit, API, upload, E2E, RLS | In progress | Proof upload, dispute, reward and notification paths |
| Wallet and finance | `/wallet/*`, `/pay/*`, `/economy` | parent, guardian, child, public payer | unit, RPC, concurrency, API, E2E | In progress | Deploy 0208 and run reconciliation/concurrency smoke |
| Billing and subscriptions | `/pricing`, `/dashboard/subscriptions`, billing APIs | owner, parent, admin | Stripe integration, webhook, idempotency, E2E | In progress | Live sandbox checkout, failure and refund evidence |
| Food and meals | `/meals`, food and grocery routes | parent, child, member | unit, AI, CRUD, E2E, seed | In progress | Complete relational data and empty-state audit |
| Messages and files | `/messages`, `/files`, `/documents` | family roles, invited users | storage, RLS, upload, download, E2E | In progress | Bucket policy and replacement/delete verification |
| Guardian and safety | `/guardian/*`, safety routes | parent, guardian, child | security, API, callback, privacy, E2E | In progress | Guardian escalation replay/phone-mapping contract passes; live SMS/callback, privacy, role, and RLS tests remain |
| Vacations and travel | `/dashboard/vacations/*`, travel tools | family roles | AI, CRUD, external API, E2E | In progress | Full itinerary/media/recovery walkthrough |
| Marketplace | `/marketplace/*`, seller flows | buyer, seller, admin | RLS, concurrency, payments, media, E2E | In progress | End-to-end listing to handoff and dispute |
| AI assistants | `/ai`, `/api/ai/*`, voice | family roles | request guards, ownership, failure, cost, privacy | In progress | Model outage, quota and streaming verification |
| Notifications and cron | notification center, `/api/cron/*`, Admin digest | system, parent, admin | auth, retry, dedupe, delivery, observability | In progress | Admin digest failure-summary tests pass; every scheduled job still needs replay/failure evidence |
| Admin and marketing | `/admin/*`, marketing routes | Super Admin, admin, support | authorization, CRUD, audit, responsive, E2E | In progress | Admin notification boundary tests pass; complete permission, mutation-failure, live-save, responsive, and browser matrix |
| Third-party integrations | Connections hub, Google/Microsoft/Apple sync, Stripe, Resend, push, OAuth | connected account owner, system | callback, secret, retry, outage, audit | In progress | 25 connection boundary tests; implemented providers route through real OAuth setup and planned adapters fail closed; remaining provider and sandbox callback evidence |
| Mobile and accessibility | Capacitor, all public/app pages | all roles and devices | Playwright, axe, keyboard, touch, performance | In progress | Full viewport/page and assistive-tech matrix |
| Deployment and operations | Vercel, Supabase, GitHub Actions | deployer, operator | build, smoke, rollback, backup/restore, monitoring | In progress | Production launch rehearsal and restore drill |

## Evidence Conventions

- Focused unit tests prove a boundary, not an entire service.
- Live schema probes prove availability, not complete RLS correctness.
- E2E passing counts are recorded with skipped and uncollected tests.
- Every gap becomes an entry in `docs/PRODUCT_LAUNCH_AUDIT.md` or `docs/LAUNCH_BLOCKERS.md`.
