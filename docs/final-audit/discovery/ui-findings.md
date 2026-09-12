# UI, Mobile and Navigation Discovery

Snapshot: `c7b56eff`, 2026-09-12. Owned files: this document and `ui-inventory.json`. No application, shared navigation, SQL, dependency, external service, or roadmap changes were made during discovery. No repository `AGENTS.md` was found; the global file is empty.

## Evidence boundary

**No complete user workflow is verified passing by this discovery.** The JSON sets all 392 web routes, seven Expo screens and workflow groups to `NOT_STARTED`. Source code, source-contract tests and import references identify work; they do not establish browser behavior, permission enforcement, provider success or persistence. Two actual source effects were executed in isolated in-memory mocks to reproduce narrow lifecycle failures; neither is a complete PWA/native test.

## Inventory coverage

| Surface | Count |
|---|---:|
| Next.js page route patterns | 392 |
| Dashboard / site-admin routes | 213 / 79 |
| Dynamic web route patterns | 42 |
| Web layouts | 24 |
| Expo screens / layouts | 7 / 3 |
| Web/app/Expo TSX source files, including pages/layouts | 947 |
| Exported major component symbols | 1,045 |
| Files containing interaction sites | 620 |
| Interaction source sites | 6,514 |
| HTML forms / HTML buttons / HTML input-select-textarea sites | 312 / 1,506 / 731 |
| Design-system Button sites | 875 |
| Production navigation-related sources | 33 |
| Existing Vitest / Playwright / node:test files | 1,121 / 9 / 1 |
| Broad marker files / marker lines | 273 / 974 |
| Workflow groups / web routes outside groups | 31 / 0 |

`ui-inventory.json` enumerates each route path, source, permanent discovery ID, inherited layout, exported major components, component imports, dependency files, action imports, API/table/RPC hints, role hints, interaction locations and test-reference candidates. `components[].controls` captures each control tag, line, event/action/href/label/validation attributes and literal label where available. Repeated rows are one source site, not one rendered button instance.

Navigation targets were cross-checked against static/dynamic page patterns. No missing production navigation page was identified by this narrow literal check; a trailing slash and `/sw.js` are not missing page defects. Computed links, feature/CMS data and active state behavior still require execution. The 33 production navigation sources exclude test fixtures.

Web routes outside the main route groups include `/gift/[token]`, `/pay/[handle]`, `/join`, `/onboarding`, `/offline`, `/reviews`, `/reviews/new` and `/s/[slug]`. Additional hidden/auxiliary surfaces include `/marketplace/seed`, `/dashboard/knowledge/seed`, `/dashboard/concierge/runs`, `/dashboard/concierge/runs/[id]`, `/dashboard/assistant/purchases/[approvalId]`, child submission and display setup. Seed pages have explicit super-admin guards in source; this is not authorization verification.

Expo separately exposes sign-in, Today, Calendar, Chores, Grocery, Assistant and Settings. The repository also contains a hosted-web Capacitor shell and an installable PWA: these are three distinct mobile delivery paths, not interchangeable device evidence.

## Prioritized findings

| ID | Severity | Finding and evidence | Required next verification |
|---|---|---|---|
| UI-RISK-001 | High | **Confirmed narrow lifecycle failure:** `components/pwa/register-sw.tsx:47-50` only attaches `window.load`. The component is mounted by authenticated `AppFrame`, which can first mount after that event during client navigation/sign-in. Executing the actual transpiled effect with `document.readyState=complete` produced zero `serviceWorker.register` calls; pre-load plus load produced one. `tests/mobile-pwa-update.test.ts` only checks source strings. | Fix post-load mounting, test actual effect execution and teardown; then verify first login/navigation, service worker installation/update/offline in production browser. |
| UI-RISK-002 | Medium | **Confirmed narrow lifecycle failure:** `components/native/native-bootstrap.tsx:26-69` assigns cleanup only after asynchronous imports/plugin setup. Actual effect execution with immediate unmount produced two added native listeners and zero removals; settled initialization followed by unmount removed both. | Cancel/remove late registrations, verify early-unmount and normal teardown; physical native deep-link/back/resume checks remain separate. |
| UI-RISK-003 | Medium | Static accessibility gap in `components/app/command-bar.tsx:184-205`: `aria-modal` command dialog handles arrows/Enter/Escape, but no Tab focus containment or trigger focus restoration is present. Mobile drawer in `components/app/app-shell.tsx:404-432` similarly declares modal semantics without a drawer focus/escape implementation in that source. | Keyboard/assistive-technology reproduction. Shared-navigation changes remain owner-controlled. |
| UI-RISK-004 | Medium | Static unnamed destructive icon control in `components/home/service-client.tsx:61`: button renders only a Trash icon, with no text, title or aria-label. Similar controls must be expanded from the interaction inventory. | Browser accessibility tree/keyboard check for populated tables, then fix named operation controls with localization. |
| UI-RISK-005 | Medium | Home service create/delete callbacks (`components/home/service-client.tsx:61,70`) await actions without inline catch/feedback; server actions at `app/(app)/dashboard/home/actions.ts:124,141` throw on DB failure. Failure can escape into a route boundary rather than preserve the open form/action context. | Force permission/network/database failure; verify draft retention, actionable error, retry and no false success. |
| UI-RISK-006 | High verification risk | 79 admin pages expose materially sensitive operations and service-role reads. `app/(app)/admin/layout.tsx` guards super-admin and detects service credentials, while six family roles are defined in `lib/constants/roles.ts`. Shared navigation gating is not a data boundary. | Test anonymous/no-family/parent/adult/teen/child/caregiver/guest/super-admin access separately at route, action, API and RLS boundaries. |
| UI-RISK-007 | High verification risk | Billing/trial/closed-account gates, app PIN, active-family switching and durable sessions wrap many independent route groups. `app/(app)/layout.tsx` intentionally does not globally redirect anonymous users; section guards must cover every route. | Complete role/plan/account-state matrix, direct URL, session expiry, browser reopen, family switch and persistence; no blanket pass from shell rendering. |
| UI-RISK-008 | High verification risk | Payments/allowance/gifts/marketplace orders, messaging and social publishing connect UI actions to money/external side effects. Rich controls are present, but source presence does not prove provider acceptance, idempotency or status reconciliation. | Isolated sandbox fixtures, complete status transition/read-back, malformed/duplicate/concurrent inputs and permission checks. |
| UI-RISK-009 | Medium verification risk | Existing mobile/overflow/a11y browser tests loop over 15 shared public routes; Chromium device emulation is default. Signed-in overlays, 213 dashboard routes, 79 admin routes and populated tables do not receive equivalent full mobile journeys. | Authenticated small-phone/tablet/laptop/wide screens, dark/light, long text, loading/errors, keyboard/notch, focus and console/network; physical/WebKit checks separately. |

The two failing probes executed repository source through TypeScript transpilation with fake React hooks/browser/Capacitor objects. They performed no network requests, provider actions or file writes beyond these discovery artifacts. Results are preserved under `narrowBehavioralProbes` in the JSON. They are failure evidence for those branches only.

## Existing tests and limits

The root runner owns the baseline full test execution. This discovery did not rerun the suite. The inventory contains 1,131 test files: 1,121 Vitest, nine Playwright specs and one native storage-patch node test. Test import/reference association is a candidate map, not coverage measurement.

- `public.spec.ts`, `mobile.spec.ts`, `overflow.spec.ts`, `accessibility.spec.ts` use 15 public paths from `tests/e2e/public-routes.ts`. A11y asserts serious/critical axe findings, not full keyboard/assistive-technology compliance.
- `authenticated.spec.ts` requires `E2E_AUTHENTICATED=1`, test account and Supabase credentials. It creates/deletes owned account/family data, signs in, completes onboarding, captures a task and includes selected RLS checks. It does not verify every CRUD route.
- `concierge.spec.ts` additionally needs the explicit model stub flags and local service fixtures; it verifies the “Plan our week” durable-run journey, not a real AI provider.
- `durable-session.spec.ts` requires `E2E_DURABLE_SESSION=1` and disposable local Supabase. It covers cookies, refresh, parallel requests and sign-out using owned accounts.
- `marketing-public.spec.ts` and `csp.spec.ts` add targeted marketing/security browser checks. Existing script-based crawls (`scripts/crawl-authenticated-routes.mjs`, `scripts/crawl-login.mjs`) are additional verification tools; route loading alone cannot pass interactions.
- Expo unit/core tests do not prove native microphone, secure store, push, OS backgrounding or physical rendering. `docs/PHYSICAL_DEVICE_TEST_PLAN.md` and `docs/mobile.md` describe the separate device evidence needed; historical blocker claims there must be rechecked before being adopted.

## Explicit unfinished capability markers

Most of the 974 broad marker matches are normal input placeholder styling, samples, or comments. They are preserved for review without labeling all as unfinished functionality. The specific production TODOs requiring scope decisions are:

- `components/family/invite-form.tsx:31-35`: pre-authorized time-limited caregiver delegation during invite acceptance and cross-household care circles require schema/RLS work. Existing presets only choose the role and describe follow-up sharing.
- `app/(app)/dashboard/concierge/runs/page.tsx:15-19`: run undo and per-tool dead-letter reconciliation need migration-dependent work. The UI currently offers no Undo. SQL remains owner-controlled; absence must not be silently declared a working feature.
- `app/(app)/money/actions.ts:132` and `components/modules/habits-module.tsx:81` reference historical TODO numbers in implementation comments; these need implementation-aware triage rather than treating the number as an unresolved defect.

Eight components had no import from other enumerated TSX files: wallet-dashboard, display-clock, home-ask-bar, all-services-icon, reports-toolbar, engagement-heatmap, memory-timeline and front-door-hero. This is a dead-code **candidate** list, not proof of unreachability: TS/barrel/dynamic imports must be checked before removal.

## Workflow expansion map

Each group has exact route patterns, source anchors, expected behavior and required validation cases in JSON. Groups overlap intentionally where one route serves several business workflows.

| ID | Workflow | Route patterns |
|---|---|---:|
| UI-WF-001 | Sign in, sign up, referral, child PIN and identity stitching | 5 |
| UI-WF-002 | Household setup, calendar import, join and invite acceptance | 2 |
| UI-WF-003 | Global navigation, catalog, search and quick capture | 9 |
| UI-WF-004 | Personal and family dashboards, knowledge/decision/intelligence views | 32 |
| UI-WF-005 | Assistant, concierge, durable run history and purchases | 9 |
| UI-WF-006 | Calendar, conflicts, timetable, rides and signups | 6 |
| UI-WF-007 | Todos, chores, missions, rewards, behavior and habits | 13 |
| UI-WF-008 | Groceries, kitchen, meals, recipes, pantry and nutrition | 11 |
| UI-WF-009 | Members, permissions, reports, safety, access and care | 24 |
| UI-WF-010 | Trust, approvals, delegations, emergency access and security | 4 |
| UI-WF-011 | Messages, announcements, contact center, inbox and contacts | 9 |
| UI-WF-012 | Guardian number, inbound handling, rules and contacts | 5 |
| UI-WF-013 | Household finance, bills, budgets, savings and subscriptions | 13 |
| UI-WF-014 | Wallet accounts, cards, ledger, children, allowance and gifts | 15 |
| UI-WF-015 | Subscription plans, checkout, portal and account closure | 2 |
| UI-WF-016 | Files, vault, documents, binder, capture and paperwork | 12 |
| UI-WF-017 | Health, medical/dental, medication, sleep and nutrition | 7 |
| UI-WF-018 | Home assets, maintenance, service, pros, warranties and moving | 11 |
| UI-WF-019 | Vehicles, insurance, service, licenses, rentals and accidents | 8 |
| UI-WF-020 | Vacations/trips, itinerary, budget, documents and family | 22 |
| UI-WF-021 | Goals, pets, school, sports, celebrations and personal journals | 14 |
| UI-WF-022 | Social accounts, authoring, scheduling, feed and analytics | 17 |
| UI-WF-023 | Calendar/email provider accounts, history and conflicts | 8 |
| UI-WF-024 | Family display and setup self-check | 2 |
| UI-WF-025 | Feedback, referrals and reviews | 4 |
| UI-WF-026 | Marketplace listings, stores, searches, commerce and community | 20 |
| UI-WF-027 | Site administration and operator workflows | 35 |
| UI-WF-028 | Marketing CRM, campaigns, content, assets, growth and analytics | 44 |
| UI-WF-029 | Marketing pages, dynamic content, contact, consent and subscriptions | 30 |
| UI-WF-030 | Profile, household configuration, preferences and setup | 6 |
| UI-WF-031 | Offline, install, updates and native shell lifecycle | 1 |

## Gaps to close before sign-off

All workflow groups still require execution. Inherited-layout import closures over-associate shared shell/catalog/data modules; use `actionWiring` and exact component controls to narrow each action. Dynamic imports, computed URLs, generated feature catalogs, CMS data and translated labels need runtime expansion. Every dynamic route needs valid/missing/unauthorized/expired/malformed fixtures. No local inventory can stand in for actual provider, database persistence, signed-in viewport, console/network, screen-reader, physical iOS/Android or second regression evidence.

## Post-discovery remediation

UI-RISK-001 was subsequently repaired under MOBILE-001 after the master audit existed. The actual React component passed 13 Chromium lifecycle/control tests and 16 existing PWA regression tests. See `../pwa-cycle.md`; the broader installed-PWA workflow remains separately unverified. The initial inventory and narrow failure probes above preserve baseline discovery evidence.

UI-RISK-002 was subsequently repaired under MOBILE-002. The actual React component passed 11 Chromium lifecycle tests with controlled native plugin promises, including unmount at every asynchronous stage and stale callbacks. See `../native-cycle.md`; physical native-runtime verification remains separate.

## Additional discovery UI-RISK-010 — Native protocol-relative destination

After the lifecycle fixes, executing the actual native handler plus installed Next 15.5.25 navigation code verified that a trusted-host input with pathname `//outside.example/path` becomes an external MPA navigation. Exact input/output and dependency execution are recorded in `../native-cycle.md` and `narrowBehavioralProbes`. No request was made to that domain. This is separate from a general origin allowlist; root received the verified finding before further production changes.

UI-RISK-010 was subsequently repaired under SEC-003 after root recorded it. Native pathname validation now uses the existing safeInternalRedirect helper while preserving opaque OAuth query/hash values and existing provider-origin semantics. Four attack cases failed before the fix; 18 native and 13 PWA actual-component Chromium cases now pass. See `../native-cycle.md` for installed Next router evidence and retest limits.

## Additional discovery UI-002 — Public navigation waits on optional content

A clean baseline production Chromium run delivered the correct feature-link click, but its destination RSC stream remained pending for 14.2 seconds during a database outage. The actual installed Supabase SDK reproduced the same 14.1-second delay in SEO/AEO primary-plus-compatibility readers because each query retries at one, two and four seconds. After root recorded UI-002, the SEO and public AEO readers received a shared 1,500 ms deadline per logical read, including compatibility/category fallbacks. Twelve real-SDK execution cases and 21 related regressions pass; the fixed independent probe returns fallback in about 1.5 seconds. The rebuilt production fixture then passed actual desktop feature-card navigation in 1,654 ms and mobile menu navigation in 1,595 ms, including menu close and the expected destination heading. See `../public-navigation-cycle.md`; this does not mark all public workflows passing. Pricing failures in the earlier baseline run came from the fixture's deliberately blank service credential and are separately documented configuration evidence.
