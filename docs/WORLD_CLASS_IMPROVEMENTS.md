# Bubaly experience improvements

Date: 2026-09-05
Baseline: `6e8f20a0` on `main`, matching `origin/main`.

## Scope and existing work

The opportunity mapping in `todo.md` already connects the 50 everyday problems
to existing tools and the recent Closet, Watchlist, Inventory, Sleep, Declutter,
Moving, Projects, Career, Language, and Hydration work. This increment repairs
the existing product experience. It does not create another set of those tools
or change the shared app sidebar.

## Reproduced production findings

- `/welcome` returned 307 to `/login?redirect=%2Fwelcome`, so the public header's
  Get started action could not reach its intended welcome/signup chooser.
- `/kid-login` returned 307 to adult login before children could use PIN sign-in.
- The production Permissions-Policy denied camera, microphone, and geolocation.
  Chromium confirmed all three were disabled, despite existing camera capture,
  voice messages, voice input, check-ins, locator, and weather using those APIs.
- The mobile menu remained expanded after Escape. It lacked a named controlled
  panel, current-page semantics, and a bounded scrolling area on short screens.
- Six homepage feature previews were static, despite corresponding detail cards
  already existing. Seven hidden module entries repeated the same placeholder.
- Desktop (1440px) and mobile (390px) homepage baselines had no horizontal
  overflow, page exceptions, or automated WCAG A/AA violations in the checked
  dark theme. Preserve these existing strengths.

## Implemented repairs and regression coverage

- Expose welcome and kid-login before authentication. Family, admin, and wallet
  routes remain protected; configured and unconfigured auth paths are covered by
  `tests/marketing-entrypoints.test.ts`.
- Allow device APIs for the same origin only. Browser permission remains under
  the user's control; external origins are not delegated access.
- Add menu Escape/focus restoration, dismissal when focus or a pointer leaves,
  route/breakpoint resets, named navigation, current-page markers, scrolling,
  and single interactive links for the sign-in actions.
- Link the homepage previews to existing feature cards with sticky-header-aware
  anchors. Remove repetitive hidden copy and label the walkthrough link honestly.
- Include welcome and kid-login in the existing public accessibility, viewport,
  and rendering matrix. New browser journeys live in
  `tests/e2e/marketing-public.spec.ts`; policy coverage lives in
  `tests/device-permissions-policy.test.ts`.

## Open production requirements

The overall goal remains open. Repository presence is not proof that all tools
work against the production database. GitHub's production environment has no
Supabase secrets; migration run `33945739134` failed with
`Missing SUPABASE_ACCESS_TOKEN repository/environment secret.` The available
Vercel token exposes a different account/team, not the NewWorldVenture project.

Configure the four secrets required by the existing production migration
workflow, inspect the remote migration ledger, apply the reviewed pending
migrations, and verify schema/RLS and authenticated household journeys. Do not
claim the new modules are production-ready until those checks pass. Also verify
the deployed commit and these repaired public journeys after Vercel finishes.

## Pre-push validation

- Full Vitest suite: 726 files, 4,229 tests passed.
- TypeScript passed; lint for changed application files passed without warnings.
- Production build passed, including generation of 243 static pages. Existing
  Supabase Edge-runtime and messages-module hook warnings remain outside this
  change.
- `git diff --check` passed.
- The initial browser run timed out against the dummy DNS backend and was
  stopped. Subsequent production preview launches, including a loopback-only
  launch, were rejected by automatic approval policy. This is not a browser
  pass: the new browser journeys still require a deployed-site run.

## Deployed-site follow-up

Vercel deployed `357e6c03` successfully. The live-site run completed 97 checks:
95 passed, including all 18 new journey checks across desktop, iPhone SE, and
Pixel emulation. Two accessibility checks found the existing Show PIN button on
the newly reachable kid-login page was only 16 x 16px. This follow-up makes it
44 x 44px, adds keyboard focus styling, reserves input space, and gives the PIN
an explicit label separate from the toggle. A browser regression exercises
show/hide behavior without submitting sign-in.

Production schema probes used the site's public anonymous client configuration
and `select=*&limit=0`, with no family records retrieved. `blog_posts` and
`families` returned HTTP 200 and zero rows as controls. All 27 tables below
returned HTTP 404 with PostgREST code `PGRST205` (table not in the schema cache):

| Existing module | Tables unavailable through the production API |
| --- | --- |
| Closet | `wardrobe_items`, `outfits`, `outfit_logs` |
| Watchlist | `watchlist_titles`, `watchlist_votes`, `watch_sessions` |
| Inventory | `home_locations`, `inventory_items`, `inventory_moves` |
| Sleep | `sleep_logs`, `bedtime_routines`, `sleep_checkins` |
| Declutter | `declutter_zones`, `declutter_missions`, `declutter_sessions` |
| Moving | `moves`, `move_tasks`, `move_boxes` |
| Projects | `home_projects`, `project_materials`, `project_quotes` |
| Career | `career_profiles`, `job_applications`, `resume_versions` |
| Language | `language_goals`, `language_sessions`, `vocab_cards` |

This proves these API-backed tools are not ready, even though the general health
probe is green. It does not distinguish unapplied migrations from stale schema
cache or other schema configuration. Inspect the remote ledger and schema with
the correct Supabase credentials, repair the cause, then verify authenticated
CRUD and family isolation. Recreating the modules would not resolve this issue.

The verified public project reference and publishable client key have now been
configured as `SUPABASE_PROJECT_REF` and `SUPABASE_ANON_KEY` in GitHub's
`production` environment. The two remaining missing private credentials are
`SUPABASE_ACCESS_TOKEN` and `SUPABASE_SERVICE_ROLE_KEY`. Add them through GitHub
environment secrets, not chat, before running the existing migration workflow.

The `72521edd` follow-up deployed successfully and passed all 100 live public
browser checks, including the PIN control in both themes, plus all 4,229 unit
tests. The final release inspection found two additional items: the standalone
GitHub TypeScript process exhausted its default heap (job `101318447319`), and
the shared `focus-ring` class paints an unconditional ring. The quality job now
gives typechecking the existing build's 4 GB heap allowance. This increment's
public links and PIN controls use `focus-visible:focus-ring`, with browser
assertions covering both idle and keyboard-focused appearance. The shared
global CSS helper and app sidebar are unchanged.

## Schema readiness follow-up (2026-09-05)

- Extended the existing `db:audit:schema` command from 11 legacy checks to 38 checks, covering all 27 tables introduced by migrations 0240 through 0248. Requests return zero rows, use bounded concurrency and deadlines, and do not follow redirects or print response bodies.
- The Production migration workflow now runs this audit immediately after the ordered migration push, before marketing backfills. It cannot report a successful rollout while required household module schema remains unavailable.
- Validation: 32 focused schema/migration/workflow tests passed; the 4 GB TypeScript check passed. The audit against the live public API passed all 11 legacy checks and reported all 27 new module tables unavailable (HTTP 404). This is an API-schema readiness result, not proof of physical table absence; authenticated migration-ledger and schema inspection are still needed.
- GitHub CI run 33971159244 for b756815631398095675bbefcfdc99a9bbcdb645a completed: quality and mobile configuration jobs passed. Browser tests recorded 394 passed, two flaky menu keyboard cases, and one failing kid-login input-size check (username input rendered at 14 px). These issues remain unresolved in this schema-audit-only follow-up.
- The Production environment contains `SUPABASE_PROJECT_REF` and `SUPABASE_ANON_KEY`. Rollout still requires `SUPABASE_ACCESS_TOKEN` and `SUPABASE_SERVICE_ROLE_KEY`, supplied privately through GitHub environment settings, followed by migration review and authenticated CRUD/RLS verification. Do not treat this follow-up as a completed production rollout.
