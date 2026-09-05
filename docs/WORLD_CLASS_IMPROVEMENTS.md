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
