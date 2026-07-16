# Product Launch Audit Ledger

This is the issue-level evidence ledger for launch. Each entry includes the required service, route,
role, scenario, severity, launch impact, root cause, resolution, Supabase impact, tests, validation,
commit, status, and remaining dependency. New findings must be added before or with their repair.

## Resolved Issues

### PLA-0368 - Wallet card surfaces implied an issued payment card before provider setup

- Status: Resolved in source; live provider and deployed verification remain open.
- Severity: P1.
- Surface: `/wallet/cards` and `/wallet/children/[childId]`.
- Finding: provider-disabled card mode used “coming soon” copy, and child detail rendered Visa-like preview art without explicitly stating that no card had been issued.
- Repair: provider-disabled mode now says spending cards are unavailable until configured; child detail now renders a clearly labeled non-issued preview with ledger-only language and no payment-card number/brand simulation.
- Evidence: `tests/wallet-card-availability.test.ts`, Stripe capability suite, 478 test files/3,246 tests, typecheck, lint, clean 250-route build, and `git diff --check` passed; source commit `faf75b75`.
- Remaining launch gate: verify real Stripe Issuing account capability, feature-flag/RLS state, and deployed browser behavior before enabling or advertising card issuance.

### PLA-0367 - Intelligence and Briefing context reads hid failures as safe-looking defaults

- Timestamp: 2026-07-16 08:22 America/New_York
- Service: Intelligence Network preferences and Briefing Kitchen Mode
- Route: corresponding family module routes under `/dashboard`
- Affected files: `components/modules/intelligence-module.tsx`, `components/modules/briefing-module.tsx`, `tests/household-read-boundaries.test.ts`
- Role: authenticated family members and household managers
- Scenario: a failed consent read could silently appear as privacy-disabled defaults, while failed event/reminder reads could leave Kitchen Mode looking current with incomplete context.
- Severity: P1
- Launch impact: users could make privacy decisions from unverified state or miss time-sensitive household context while the interface appeared healthy.
- Root cause: both surfaces ignored realtime query errors; Kitchen Mode also lacked a coordinated retry for its two context reads.
- Resolution: Intelligence now blocks controls behind a retryable ErrorState; Briefing Kitchen Mode retries calendar and reminder reads together before rendering.
- Supabase impact: no schema change; existing consent and household context reads now have explicit failure contracts.
- Tests run: `tests/household-read-boundaries.test.ts` (9 focused assertions); full Vitest; typecheck; lint; clean production build; diff check.
- Validation evidence: 477 test files, 3,244 tests, 250-route build, and diff check passed; known build warnings remain documented.
- Commit: `9682ff06`
- Status: Resolved in code; branch pushed, with `main` publication and live verification tracked separately
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed AI/context verification

### PLA-0366 - Tax, subscription, memory, and routine reads hid failures as empty state

- Timestamp: 2026-07-16 08:13 America/New_York
- Service: Tax Vault, Subscriptions, Trip Memories, and Routines
- Route: corresponding family module routes under `/dashboard`
- Affected files: `components/modules/tax-vault-module.tsx`, `components/modules/subscriptions-module.tsx`, `components/modules/trip-memories-module.tsx`, `components/modules/routines-panel.tsx`, `tests/household-read-boundaries.test.ts`
- Role: authenticated family members and household managers
- Scenario: failed reads either rendered a healthy empty state or allowed trip and routine summaries to derive from partial query results.
- Severity: P1
- Launch impact: families could miss tax records, recurring charges, travel memories, or saved routines while the UI appeared usable.
- Root cause: modules ignored realtime query errors; Trip Memories and Routines also lacked coordinated loading and retry behavior across dependent reads.
- Resolution: all four surfaces now expose retryable ErrorState UI; Trip Memories and Routines coordinate every required read before rendering derived state.
- Supabase impact: no schema change; existing family-scoped record, travel, and routine reads now have explicit failure contracts.
- Tests run: `tests/household-read-boundaries.test.ts` (8 focused assertions); full Vitest; typecheck; lint; clean production build; diff check.
- Validation evidence: 477 test files, 3,243 tests, 250-route build, and diff check passed; known build warnings remain documented.
- Commit: `0cecf444`
- Status: Resolved in code; branch pushed, with `main` publication and live verification tracked separately
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed records/routines verification

### PLA-0365 - Coordination modules hid failed reads as empty or partial states

- Timestamp: 2026-07-16 08:06 America/New_York
- Service: Concierge Plans, Voice History, Next Actions, Group Voting, and Weekend Planner
- Route: corresponding family module routes under `/dashboard`
- Affected files: `components/modules/concierge-module.tsx`, `components/modules/voice-module.tsx`, `components/modules/next-actions-module.tsx`, `components/modules/voting-module.tsx`, `components/modules/weekend-module.tsx`, `tests/household-read-boundaries.test.ts`
- Role: authenticated family members and household managers
- Scenario: failed reads either rendered a healthy empty state, exposed incomplete history, or allowed planning, voting, and weekend summaries to derive from partial query results.
- Severity: P1
- Launch impact: families could miss saved plans, voice captures, next actions, poll options/votes, budgets, or local events while the UI appeared usable.
- Root cause: modules ignored realtime query errors; multi-query surfaces also lacked coordinated loading and retry behavior.
- Resolution: all five modules now surface retryable ErrorState UI; Next Actions, Voting, and Weekend Planner coordinate every required read before rendering derived state.
- Supabase impact: no schema change; existing family-scoped planning, AI, voting, and local-event reads now have explicit failure contracts.
- Tests run: `tests/household-read-boundaries.test.ts` (7 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 477 test files, 3,242 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `0b228692`
- Status: Resolved in code; branch pushed, with `main` publication and live verification tracked separately
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed coordination verification

### PLA-0364 - Daily household modules hid failed reads as empty or partial states

- Timestamp: 2026-07-16 07:56 America/New_York
- Service: Prep Plans, Photos, Pets, Recipes, Reminders, Shopping, Todos, and Utilities
- Route: corresponding family module routes under `/dashboard`
- Affected files: `components/modules/planning-module.tsx`, `components/modules/photos-module.tsx`, `components/modules/pets-module.tsx`, `components/modules/recipes-module.tsx`, `components/modules/reminders-module.tsx`, `components/modules/shopping-module.tsx`, `components/modules/todos-module.tsx`, `components/modules/utilities-module.tsx`, `tests/household-read-boundaries.test.ts`
- Role: authenticated family members and household managers
- Scenario: failed reads either rendered a healthy empty state, exposed a raw error without recovery, or allowed dependent list/media/care state to render from partial query results.
- Severity: P1
- Launch impact: families could miss preparation plans, photos, pet care, recipes, reminders, shopping items, tasks, or utility cost history while the UI appeared usable.
- Root cause: modules ignored realtime query errors; multi-query surfaces also lacked coordinated loading and retry behavior.
- Resolution: all eight modules now surface retryable ErrorState UI; Prep Plans, Photos, Pets, Reminders, Shopping, and Todos coordinate dependent reads before rendering derived state.
- Supabase impact: no schema change; existing family-scoped planning, media, care, food, task, and utility reads now have explicit failure contracts.
- Tests run: `tests/household-read-boundaries.test.ts` (6 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 477 test files, 3,241 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `d8a0213a`
- Status: Resolved in code; branch pushed, with `main` publication and live verification tracked separately
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed daily household verification

### PLA-0363 - Household insight modules hid failed reads as empty or partial states

- Timestamp: 2026-07-16 07:50 America/New_York
- Service: Knowledge Graph, Family Tree, Experience Scorecard, Expenses, Insurance, and Life & Milestones
- Route: corresponding family module routes under `/dashboard`
- Affected files: `components/modules/graph-module.tsx`, `components/modules/family-tree-module.tsx`, `components/modules/experience-scorecard-module.tsx`, `components/modules/expenses-module.tsx`, `components/modules/insurance-module.tsx`, `components/modules/life-events-module.tsx`, `tests/household-read-boundaries.test.ts`
- Role: authenticated family members and household managers
- Scenario: failed reads either rendered a healthy empty state or allowed graph, scorecard, settlement, policy, or playbook summaries to derive from partial query results.
- Severity: P1
- Launch impact: families could miss relationship data, household financial obligations, insurance coverage, or life-event plans while the UI appeared usable.
- Root cause: modules ignored realtime query errors; multi-query surfaces also lacked coordinated loading and retry behavior.
- Resolution: all six modules now surface retryable ErrorState UI; Graph, Expenses, and Life & Milestones coordinate every required read before rendering derived state.
- Supabase impact: no schema change; existing family-scoped insight, finance, coverage, and planning reads now have explicit failure contracts.
- Tests run: `tests/household-read-boundaries.test.ts` (5 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 477 test files, 3,240 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `468611d5`
- Status: Resolved in code; branch pushed, with `main` publication and live verification tracked separately
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed household insight verification

### PLA-0362 - Household modules hid failed reads as empty or partial states

- Timestamp: 2026-07-16 07:41 America/New_York
- Service: Announcements, Contacts, Screen Time, Celebrations, and Household Binder
- Route: corresponding family module routes under `/dashboard`
- Affected files: `components/modules/announcements-module.tsx`, `components/modules/contacts-module.tsx`, `components/modules/screen-time-module.tsx`, `components/modules/celebrations-module.tsx`, `components/modules/binder-module.tsx`, `tests/household-read-boundaries.test.ts`
- Role: authenticated family members and household managers
- Scenario: failed reads either rendered a healthy empty state, exposed a raw error without recovery, or allowed dependent data to render from partial query results.
- Severity: P1
- Launch impact: families could miss announcements, contacts, screen-time limits, celebrations, or household reference information while the UI appeared usable.
- Root cause: several modules ignored realtime query errors; Announcements and Screen Time also lacked coordinated loading and retry behavior across multiple reads.
- Resolution: all five modules now surface retryable ErrorState UI; Announcements coordinates announcements and read-receipt queries, and Screen Time coordinates entries and limits before rendering derived state.
- Supabase impact: no schema change; existing family-scoped household reads now have explicit page-level failure contracts.
- Tests run: `tests/household-read-boundaries.test.ts` (4 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 477 test files, 3,239 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `943990b3`
- Status: Resolved in code; branch pushed, with `main` publication and live verification tracked separately
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed household verification

### PLA-0361 - Devices, Immunizations, and Security hid safety reads as empty states

- Timestamp: 2026-07-16 07:34 America/New_York
- Service: Smart Home Devices, Immunizations, and Home Security
- Route: device, immunization, and security module routes under `/dashboard`
- Affected files: `components/modules/devices-module.tsx`, `components/modules/immunizations-module.tsx`, `components/modules/security-module.tsx`, `tests/safety-read-boundaries.test.ts`
- Role: authenticated family members and household managers
- Scenario: failed device, immunization, or security-event reads fell through to empty safety states after loading.
- Severity: P1
- Launch impact: families could miss connected-device status, vaccine records, or home-security events while the UI appeared healthy.
- Root cause: all three single-query modules ignored their realtime query error state.
- Resolution: all three now render sanitized retryable ErrorState UI before their empty safety states.
- Supabase impact: no schema change; existing family-scoped safety reads now have explicit failure contracts.
- Tests run: `tests/safety-read-boundaries.test.ts` (3 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 477 test files, 3,237 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `ab367ebd`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed safety verification

### PLA-0360 - Medical Records hid active-medication read failures from clinical records

- Timestamp: 2026-07-16 07:27 America/New_York
- Service: Medical Records
- Route: `/dashboard/medical-records` and kind-specific medical-records routes
- Affected files: `components/modules/medical-records-module.tsx`, `tests/health-read-boundaries.test.ts`
- Role: authenticated family members, household managers, and health-history users
- Scenario: the active-medications read could fail while providers, insurance, and medical profiles rendered as healthy, leaving medication context incomplete.
- Severity: P1
- Launch impact: families could view a partial clinical record while believing all related medical data was current.
- Root cause: the module excluded medication loading/error state from its existing three-query gate.
- Resolution: Medical Records now coordinates four required reads and retries providers, policies, profiles, and active medications together before rendering records.
- Supabase impact: no schema change; existing family-scoped clinical reads now have an explicit page-level failure contract.
- Tests run: `tests/health-read-boundaries.test.ts` (3 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 476 test files, 3,234 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `eb3ff4b8`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed health verification

### PLA-0359 - Health and Medications hid required clinical reads as partial history

- Timestamp: 2026-07-16 07:14 America/New_York
- Service: Health Dashboard and Medications
- Route: `/dashboard/health`, `/dashboard/medications`
- Affected files: `components/modules/health-module.tsx`, `components/modules/medications-module.tsx`, `tests/health-read-boundaries.test.ts`
- Role: authenticated family members, household managers, and health-history users
- Scenario: symptom/goal reads and medication schedule/dose reads could fail while the UI derived health summaries, adherence, or empty states from partial arrays.
- Severity: P1
- Launch impact: families could miss symptoms, goals, medication schedules, dose history, or clinical follow-up context.
- Root cause: both modules ignored secondary realtime query loading/error state; Medications only guarded the medication list.
- Resolution: Health now coordinates six reads; Medications coordinates medication, schedule, and dose reads. Both render sanitized retryable ErrorState UI before derived clinical states.
- Supabase impact: no schema change; existing family-scoped clinical reads now have explicit failure contracts.
- Tests run: `tests/health-read-boundaries.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 476 test files, 3,233 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `32dc4248`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed health verification

### PLA-0358 - Finances summary hid account and planning read failures as zero metrics

- Timestamp: 2026-07-16 07:09 America/New_York
- Service: Finances
- Route: `/dashboard/finances`
- Affected files: `components/modules/finances-module.tsx`, `tests/finances-read-boundary.test.ts`
- Role: authenticated family members and household managers
- Scenario: any of five required finance reads could fail while the summary derived balances, spending, and upcoming obligations from empty fallback arrays.
- Severity: P1
- Launch impact: families could see misleading zero balances or make financial decisions from incomplete data.
- Root cause: the module only waited on account and transaction loading and ignored every query error.
- Resolution: Finances now coordinates all five reads and renders sanitized retryable ErrorState UI before financial metrics; retry refreshes the complete read set.
- Supabase impact: no schema change; existing family-scoped financial reads now have an explicit page-level failure contract.
- Tests run: `tests/finances-read-boundary.test.ts` (1 focused assertion); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 475 test files, 3,231 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `541c1a40`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed finance verification

### PLA-0357 - Decision Engine and Health Visits hid required reads as empty states

- Timestamp: 2026-07-16 07:03 America/New_York
- Service: Decision Engine and Health Visits
- Route: `/dashboard/decisions`, health module routes using `/dashboard/health-visits`
- Affected files: `components/modules/decisions-module.tsx`, `components/modules/health-visits-module.tsx`, `tests/household-read-boundaries.test.ts`
- Role: authenticated family members, household managers, and health-history users
- Scenario: a failed decision or option read could show no decisions; a failed health-visit read could show an empty medical history.
- Severity: P1
- Launch impact: families could make choices without available trade-offs or miss health-history and follow-up context.
- Root cause: both modules ignored realtime query errors; Decision Engine also failed to coordinate its paired decision/options reads.
- Resolution: Decision Engine now coordinates both reads and retries them together; Health Visits renders sanitized retryable ErrorState UI before its empty history.
- Supabase impact: no schema change; existing family-scoped reads now have explicit failure contracts.
- Tests run: `tests/household-read-boundaries.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 474 test files, 3,230 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `59b280ae`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed household verification

### PLA-0356 - Behavior insights hid behavior-log read failures as no logged behavior

- Timestamp: 2026-07-16 06:56 America/New_York
- Service: Behavior and Parenting Insights
- Route: `/dashboard/behavior`
- Affected files: `components/modules/behavior-module.tsx`, `tests/behavior-read-boundary.test.ts`
- Role: authenticated family members and household managers
- Scenario: a failed `behavior_logs` read could render “No behavior logged yet,” indistinguishable from a household with no recorded behavior.
- Severity: P1
- Launch impact: parents could lose visibility into behavior history and the insight context built from it.
- Root cause: the module ignored the `useRealtimeQuery` error state before choosing its empty state.
- Resolution: Behavior now renders sanitized retryable ErrorState UI before behavior summaries and the empty state on any read failure.
- Supabase impact: no schema change; the existing family-scoped behavior read now has an explicit failure contract.
- Tests run: `tests/behavior-read-boundary.test.ts` (1 focused assertion); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 473 test files, 3,228 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `42625b69`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed behavior verification

### PLA-0355 - Location map hid coordinate, geofence, and history read failures as no sharing

- Timestamp: 2026-07-16 06:51 America/New_York
- Service: Family Location
- Route: `/dashboard/locator`
- Affected files: `components/modules/locator-module.tsx`, `tests/family-location-read-boundary.test.ts`
- Role: authenticated family members and household managers
- Scenario: one or more location reads could fail while the map and live-location sections rendered from empty or partial arrays.
- Severity: P1
- Launch impact: families could miss a member location, geofence, or recent safety history while the page appeared usable.
- Root cause: the module only gated on the locations query loading state and ignored errors from all three required reads.
- Resolution: Location now waits for all three reads and renders sanitized retryable ErrorState UI with a coordinated retry before the map.
- Supabase impact: no schema change; existing family-scoped location reads now have an explicit page-level failure contract.
- Tests run: `tests/family-location-read-boundary.test.ts` (1 focused assertion); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 472 test files, 3,227 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `632f677d`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed family-location verification

### PLA-0354 - Play Dates hid family scheduling read failures as no play dates

- Timestamp: 2026-07-16 06:45 America/New_York
- Service: Play Dates
- Route: `/dashboard/family/play-dates`
- Affected files: `components/family/play-dates-view.tsx`, `tests/family-safety-read-boundaries.test.ts`
- Role: authenticated family members and household planners
- Scenario: a failed `play_dates` read could render “No play dates yet,” indistinguishable from a household with no scheduled social activity.
- Severity: P1
- Launch impact: families could miss upcoming child-safety and pickup coordination details.
- Root cause: the view ignored the `useRealtimeQuery` error state before choosing its empty state.
- Resolution: Play Dates now renders sanitized retryable ErrorState UI before the empty schedule on any read failure.
- Supabase impact: no schema change; the existing family-scoped schedule read now has an explicit failure contract.
- Tests run: `tests/family-safety-read-boundaries.test.ts` (3 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 471 test files, 3,226 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `4f5edc92`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed family-safety verification

### PLA-0353 - Driving Safety and Find Phone hid family location read failures

- Timestamp: 2026-07-16 06:37 America/New_York
- Service: Driving Safety and Find Phone
- Route: `/dashboard/family/driving-safety`, `/dashboard/family/find-phone`
- Affected files: `components/family/driving-safety-view.tsx`, `components/family/find-phone-view.tsx`, `tests/family-safety-read-boundaries.test.ts`
- Role: authenticated family members and safety operators
- Scenario: driving-trip reads could fail while the page showed no trips or zeroed summary metrics; Find Phone could show partial device data when locations or saved places failed.
- Severity: P1
- Launch impact: families could miss driving-safety activity or use incomplete location data.
- Root cause: both views ignored `useRealtimeQuery` errors; Find Phone did not coordinate its location and saved-place read failures.
- Resolution: both views now render sanitized retryable ErrorState UI before empty/partial states; Find Phone retries both required reads together.
- Supabase impact: no schema change; existing family-scoped reads now have explicit failure contracts.
- Tests run: `tests/family-safety-read-boundaries.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 471 test files, 3,225 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `00128cc4`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed family-safety verification

### PLA-0352 - Family check-in feed hid safety read failures as no check-ins

- Timestamp: 2026-07-15 17:33 America/New_York
- Service: Family Check In
- Route: `/dashboard/check-in`
- Affected files: `components/family/check-in-view.tsx`, `tests/family-check-in-boundary.test.ts`
- Role: authenticated family members and safety operators
- Scenario: the family check-in read could fail while the feed rendered “No check-ins yet,” indistinguishable from a household with no safety activity.
- Severity: P1
- Launch impact: family members could miss safety status updates during an incident.
- Root cause: the view ignored the `useRealtimeQuery` error state before choosing its empty state.
- Resolution: Family Check In now renders a sanitized retryable ErrorState before the empty feed on any read failure.
- Supabase impact: no schema change; the existing family-scoped safety feed now has an explicit failure contract.
- Tests run: `tests/family-check-in-boundary.test.ts` (1 focused assertion); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 470 test files, 3,223 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `b72a02d2`
- Status: Resolved in code; audit evidence was stamped in `ce9822ad` and the source, test, and docs were published to remote `main`
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed Check In verification

### PLA-0351 - Weather and packing views hid failed trip dependencies as empty plans

- Timestamp: 2026-07-15 17:27 America/New_York
- Service: Trip Weather and Trip Packing
- Route: `/dashboard/vacations/[id]/weather`, `/dashboard/vacations/[id]/packing`
- Affected files: `components/vacations/trip-weather.tsx`, `components/vacations/trip-packing.tsx`, `tests/trip-weather-packing-boundary.test.ts`
- Role: authenticated family members and household trip planners
- Scenario: weather, packing, or activity dependency reads could fail while pages rendered no forecast or no packing items.
- Severity: P1
- Launch impact: travelers could plan without current weather or lose visibility into a partially unavailable packing plan.
- Root cause: both views used fallback arrays while ignoring secondary query loading and errors.
- Resolution: Weather now validates its trip and snapshot reads; Packing validates all five required reads and renders sanitized retry states before empty-state UI.
- Supabase impact: no schema change; existing family-scoped trip dependency reads now have explicit page-level failure contracts.
- Tests run: `tests/trip-weather-packing-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 469 test files, 3,222 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `2a86d411`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed Weather/Packing verification

### PLA-0350 - Emergency summary hid contact and medical read failures as no emergency data

- Timestamp: 2026-07-15 17:23 America/New_York
- Service: Trip Emergency Summary
- Route: `/dashboard/vacations/[id]/emergency`
- Affected files: `components/vacations/trip-emergency.tsx`, `tests/trip-emergency-boundary.test.ts`
- Role: authenticated family members and household trip planners
- Scenario: contact or medical reads could fail while the emergency summary returned null, indistinguishable from having no safety information.
- Severity: P1
- Launch impact: travelers could miss emergency contacts or medical details during a time-sensitive situation.
- Root cause: the summary checked only array lengths and ignored both query loading and error state.
- Resolution: Emergency Summary now tracks both required reads, distinguishes loading from empty, and renders a sanitized retryable ErrorState before returning no summary.
- Supabase impact: no schema change; existing family-scoped safety reads now have an explicit failure contract.
- Tests run: `tests/trip-emergency-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 468 test files, 3,220 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `da83e4b`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed Emergency verification

### PLA-0349 - Vacation CRUD and budget views hid failed financial and trip-detail reads

- Timestamp: 2026-07-15 17:17 America/New_York
- Service: Vacation shared CRUD sections and Trip Budget
- Route: `/dashboard/vacations/[id]/budget` plus shared lodging, travel, activity, document, family, and emergency sections
- Affected files: `components/vacations/shared.tsx`, `components/vacations/trip-budget.tsx`, `tests/vacation-crud-read-boundary.test.ts`
- Role: authenticated family members and household trip planners
- Scenario: shared CRUD list reads or budget/expense reads could fail while sections rendered empty lists or zero financial totals.
- Severity: P1
- Launch impact: families could miss trip records or make budget decisions from incomplete data.
- Root cause: `TripCrudSection` ignored read errors, and Trip Budget did not track loading or errors for its summary queries.
- Resolution: shared vacation CRUD sections now show sanitized retry states, while Trip Budget waits for both required reads and retries them together.
- Supabase impact: no schema change; existing family-scoped child-table and budget reads now have explicit failure handling.
- Tests run: `tests/vacation-crud-read-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 467 test files, 3,218 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `3adef7e6`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed vacation CRUD verification

### PLA-0348 - Trip itinerary hid failed day and item reads as an empty schedule

- Timestamp: 2026-07-15 17:11 America/New_York
- Service: Trip Itinerary
- Route: `/dashboard/vacations/[id]/itinerary`
- Affected files: `components/vacations/trip-itinerary.tsx`, `tests/trip-itinerary-boundary.test.ts`
- Role: authenticated family members and household trip planners
- Scenario: trip, day, or itinerary-item reads could fail while the page rendered no days planned or an incomplete schedule.
- Severity: P1
- Launch impact: families could miss planned activities or incorrectly rebuild an itinerary from incomplete data.
- Root cause: only the itinerary days query exposed loading state; trip and item read failures were ignored.
- Resolution: Trip Itinerary now tracks all three query handles, waits for complete data, and renders a sanitized retryable ErrorState before showing an empty schedule.
- Supabase impact: no schema change; existing family-scoped itinerary reads now have an explicit page-level failure contract.
- Tests run: `tests/trip-itinerary-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 466 test files, 3,216 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `7e6ce831`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed Itinerary verification

### PLA-0347 - Trip overview hid incomplete readiness and itinerary reads

- Timestamp: 2026-07-15 17:05 America/New_York
- Service: Trip Overview
- Route: `/dashboard/vacations/[id]/overview`
- Affected files: `components/vacations/trip-overview.tsx`, `tests/trip-overview-boundary.test.ts`
- Role: authenticated family members and household trip planners
- Scenario: any secondary overview read could fail while readiness, budget, transport, weather, or recommendation summaries rendered from partial arrays.
- Severity: P1
- Launch impact: families could treat an incomplete trip overview as current and act on an inaccurate readiness score or financial summary.
- Root cause: only the trip query exposed loading state; the other 16 required reads ignored loading and error state.
- Resolution: Trip Overview now centralizes all 17 query handles, waits for complete data, and renders a sanitized retryable ErrorState before deriving readiness or summaries.
- Supabase impact: no schema change; existing family-scoped trip reads now have an explicit page-level failure contract.
- Tests run: `tests/trip-overview-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 465 test files, 3,214 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `f36ea6c5`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed Trip Overview verification

### PLA-0346 - Vacation reports hid incomplete financial and travel-score reads

- Timestamp: 2026-07-15 16:58 America/New_York
- Service: Vacation Reports
- Route: `/dashboard/vacations/reports`
- Affected files: `components/vacations/vacations-reports.tsx`, `tests/vacations-reports-boundary.test.ts`
- Role: authenticated family members and household trip planners
- Scenario: expense, budget, or travel-score reads could fail while the report rendered trip counts and partial financial totals as if complete.
- Severity: P1
- Launch impact: families could make travel budget decisions from incomplete or stale report data.
- Root cause: only the trips query exposed loading state; secondary report reads ignored their loading and error contracts.
- Resolution: Vacation Reports now tracks all four required reads, waits for complete data, and renders a sanitized retryable ErrorState before deriving totals or charts.
- Supabase impact: no schema change; existing family-scoped report reads now have an explicit failure contract.
- Tests run: `tests/vacations-reports-boundary.test.ts` (2 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 464 test files, 3,212 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `194e4ecb`
- Status: Resolved in code; documentation and remote publication pending for this increment
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed Vacation Reports verification

### PLA-0345 - Connections hub hid family connection read failures as disconnected providers

- Timestamp: 2026-07-15 16:34 America/New_York
- Service: Family Connections hub and integration directory
- Route: `/dashboard/connections`
- Affected files: `components/modules/connections-module.tsx`, `tests/connections-ui-boundary.test.ts`
- Role: authenticated family members and household integration operators
- Scenario: the realtime `family_connections` query could fail while the module rendered every provider as disconnected or showed an empty connection summary.
- Severity: P1
- Launch impact: families could mistake unavailable connection data for revoked credentials and make incorrect setup decisions.
- Root cause: the module ignored the `useRealtimeQuery` error state even though the hook preserved real read failures.
- Resolution: Connections now renders a sanitized retryable ErrorState and wires retry to the query refresh callback before deriving provider statuses.
- Supabase impact: no schema change; the existing family-scoped realtime read now has visible UI failure handling.
- Tests run: `tests/connections-ui-boundary.test.ts` (3 focused assertions); full Vitest; typecheck; lint; dependency audit; clean production build; migration audit; schema probes; diff check.
- Validation evidence: 463 test files, 3,210 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `299e2608`
- Status: Resolved in code; live provider callbacks, RLS, role, browser, and deployed evidence remains open
- Remaining dependencies: provider sandbox callbacks, cross-family RLS, browser, backup, and deployed Connections verification

### PLA-0344 - Sync conflict and account routes hid required read failures

- Timestamp: 2026-07-15 16:21 America/New_York
- Service: Family Sync conflict resolution and connected accounts
- Route: `/dashboard/sync/conflicts`, `/dashboard/sync/accounts`, `/dashboard/sync/accounts/[provider]`
- Affected files: `app/(app)/dashboard/sync/conflicts/page.tsx`, `app/(app)/dashboard/sync/accounts/page.tsx`, `app/(app)/dashboard/sync/accounts/[provider]/page.tsx`, `tests/sync-route-read-boundaries.test.ts`
- Role: authenticated family members and household integration operators
- Scenario: conflict or connected-account reads could fail while the UI rendered “No open conflicts” or “Not connected”.
- Severity: P1
- Launch impact: families could miss records requiring manual resolution or believe provider credentials were absent when data was unavailable.
- Root cause: query errors were discarded before empty-state and provider-status rendering.
- Resolution: all three routes now log failures and render sanitized retry states before showing conflict or account status.
- Supabase impact: no schema change; family-scoped sync conflict and account reads now have explicit failure contracts.
- Tests run: `tests/sync-route-read-boundaries.test.ts` (1 focused test); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Validation evidence: 463 test files, 3,209 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `ec14b828`
- Status: Resolved in code; live provider callbacks, conflict-resolution, RLS, role, browser, and deployed evidence remains open
- Remaining dependencies: provider sandbox callbacks, conflict-resolution action drills, cross-family RLS, browser, backup, and deployed Sync verification

### PLA-0343 - Family Sync showed zero health and history after required reads failed

- Timestamp: 2026-07-15 16:16 America/New_York
- Service: Family Sync hub and synchronization history
- Route: `/dashboard/sync`, `/dashboard/sync/history`
- Affected files: `app/(app)/dashboard/sync/page.tsx`, `app/(app)/dashboard/sync/history/page.tsx`, `tests/sync-read-boundary.test.ts`
- Role: authenticated family members and household integration operators
- Scenario: connection, calendar, conflict, run, or audit-history reads could fail while the pages rendered zero health metrics or “no runs” empty states.
- Severity: P1
- Launch impact: families could miss provider outages, open conflicts, or failed synchronization and assume their data was current.
- Root cause: query results were used without checking their error fields.
- Resolution: all required hub and history reads now fail visibly with sanitized route-specific retry states before health or history data is derived.
- Supabase impact: no schema change; family-scoped sync operational reads now have explicit failure contracts.
- Tests run: `tests/sync-read-boundary.test.ts` (1 focused test); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Validation evidence: 462 test files, 3,208 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `91394c90`
- Status: Resolved in code; live provider callbacks, recovery/conflict, RLS, role, browser, and deployed evidence remains open
- Remaining dependencies: provider sandbox callbacks, retry/conflict drills, cross-family RLS, browser, backup, and deployed Sync verification

### PLA-0342 - Admin Users rendered partial access data after required reads failed

- Timestamp: 2026-07-15 16:12 America/New_York
- Service: Super Admin Users & Families access management
- Route: `/admin/users`
- Affected files: `app/(app)/admin/users/page.tsx`, `tests/admin-users-read-boundary.test.ts`
- Role: Super Admin and access-management operators
- Scenario: any required profile, family, membership, subscription, invitation, role, permission, or super-admin read could fail while the page rendered partial users, empty filters, or misleading access counts.
- Severity: P1
- Launch impact: operators could change access based on incomplete or stale membership and permission data.
- Root cause: query failures were collected into a warning banner but the page continued to derive metrics and rows from partial results.
- Resolution: the page now logs the failure and renders a sanitized retryable ErrorState before any access data is derived or shown.
- Supabase impact: no schema change; required service-role access reads now have an explicit fail-closed contract.
- Tests run: `tests/admin-users-read-boundary.test.ts` (1 focused test); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Validation evidence: 461 test files, 3,207 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `3e44cb89`
- Status: Resolved in code; live Super Admin role/RLS, browser, audit-log, backup, and deployed evidence remains open
- Remaining dependencies: authenticated access matrix, cross-tenant RLS, audit-log routing, backup, and deployed Users verification

### PLA-0341 - Admin Social hid publishing and provider errors as zero metrics

- Timestamp: 2026-07-15 16:06 America/New_York
- Service: Super Admin Social Platform and publishing operations
- Route: `/admin/social`
- Affected files: `app/(app)/admin/social/page.tsx`, `tests/admin-social-read-boundary.test.ts`
- Role: Super Admin, social operators, and families using social publishing
- Scenario: any of six account, post, publish-result, AI-generation, or provider-error reads could fail while the page rendered zero operational metrics and appeared healthy.
- Severity: P1
- Launch impact: operators could miss failed publishing, AI generation failures, and provider incidents.
- Root cause: Promise query results were used without checking their error fields.
- Resolution: all six required reads now fail visibly with a retryable sanitized ErrorState before metrics or credential readiness are rendered.
- Supabase impact: no schema change; service-role Social operational reads now have explicit failure contracts.
- Tests run: `tests/admin-social-read-boundary.test.ts` (1 focused test); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Validation evidence: 461 test files, 3,207 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `709aca24`
- Status: Resolved in code; live social callbacks, publish/retry, RLS, role, browser, and deployed evidence remains open
- Remaining dependencies: provider sandbox callbacks, publish/retry drills, credential/secret rotation, role/RLS, browser, backup, and deployed Social verification

### PLA-0340 - Admin Sync hid provider and queue read failures as healthy metrics

- Timestamp: 2026-07-15 16:35 America/New_York
- Service: Super Admin Sync Platform and third-party integration operations
- Route: `/admin/sync`
- Affected files: `app/(app)/admin/sync/page.tsx`, `tests/admin-sync-read-boundary.test.ts`
- Role: Super Admin, integration operator, and household provider-sync user
- Scenario: connection, fatal provider error, dead-letter job, webhook-signature, or provider-catalog reads could fail while the page rendered zero failures and a complete catalog.
- Severity: P1
- Launch impact: operators could miss provider outages, failed jobs, or signature failures and assume synchronization was healthy.
- Root cause: Promise query results were used without checking error fields.
- Resolution: all five required reads now fail visibly with a retryable sanitized ErrorState before metrics are rendered.
- Supabase impact: no schema change; service-role sync operational reads now have explicit failure contracts.
- Tests run: `tests/admin-sync-read-boundary.test.ts` (1 focused test); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Validation evidence: 460 test files, 3,206 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `6a9d7494`
- Status: Resolved in code; live callback, retry, RLS, role, browser, and deployed integration evidence remains open
- Remaining dependencies: provider sandbox callbacks, dead-letter recovery, signature-failure drills, and deployed Admin Sync verification

### PLA-0339 - Admin dashboard hid command-center read failures as zero or empty metrics

- Timestamp: 2026-07-15 16:20 America/New_York
- Service: Super Admin command center and operational dashboard
- Route: `/admin`
- Affected files: `app/(app)/admin/page.tsx`, `tests/admin-overview-read-boundary.test.ts`
- Role: Super Admin and operational administrator
- Scenario: required family, member, subscription, storage, audit, ticket, notification, or actor reads could fail while dashboard cards and activity rendered plausible incomplete values.
- Severity: P1
- Launch impact: operators could make billing, support, security, or deployment decisions from partial command-center data.
- Root cause: Promise results and the secondary actor lookup were destructured without preserving error state.
- Resolution: all required result errors are checked before metrics are derived; actor profile failures have a separate sanitized retry state.
- Supabase impact: no schema change; service-role dashboard reads now fail visibly instead of substituting empty arrays/zero counts.
- Tests run: `tests/admin-overview-read-boundary.test.ts` (1 focused test); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Validation evidence: 459 test files, 3,205 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `167524d9`
- Status: Resolved in code; live Super Admin role/browser, alert-routing, RLS, and outage evidence remains open
- Remaining dependencies: execute authenticated command-center and degraded-Supabase drills against deployed services

### PLA-0338 - Admin Security hid Auth and audit read failures as empty signals

- Timestamp: 2026-07-15 16:05 America/New_York
- Service: Super Admin Security and Auth Admin operations
- Route: `/admin/security`
- Affected files: `app/(app)/admin/security/page.tsx`, `tests/admin-security-read-boundary.test.ts`
- Role: Super Admin and security operator
- Scenario: Auth Admin users, invites, audit logs, families, or actor profiles could fail while the page rendered empty account security and sensitive activity signals.
- Severity: P1
- Launch impact: operators could miss unconfirmed, banned, or newly created accounts and audit activity during an authentication or database outage.
- Root cause: parallel results and actor lookup results were destructured without preserving error state.
- Resolution: required reads now fail visibly with sanitized retryable ErrorState responses; server logs retain diagnostics without exposing them to the UI.
- Supabase impact: no schema change; Auth Admin and service-role audit reads now have explicit failure contracts.
- Tests run: `tests/admin-security-read-boundary.test.ts` (1 focused test); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Validation evidence: 458 test files, 3,204 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `f13af1c2`
- Status: Resolved in code; live Auth Admin, role, browser, RLS, and outage evidence remains open
- Remaining dependencies: restore healthy Auth Admin users endpoint and execute authenticated security-operation drills

### PLA-0337 - Admin wallet overview hid required read failures as zero metrics

- Timestamp: 2026-07-15 15:50 America/New_York
- Service: Super Admin wallet overview and financial operations
- Route: `/admin/wallet`
- Affected files: `app/(app)/admin/wallet/page.tsx`, `tests/admin-wallet-read-boundary.test.ts`
- Role: Super Admin and financial operator
- Scenario: any of seven parallel wallet, approval, ledger, feature-flag, or audit reads could fail while the page rendered zero-valued metrics and controls.
- Severity: P1
- Launch impact: operators could misread wallet exposure, pending work, feature availability, or audit activity during a partial outage.
- Root cause: Promise results were destructured without retaining or checking errors.
- Resolution: all seven result errors are checked before deriving metrics; server diagnostics remain private and the UI renders a retryable ErrorState.
- Supabase impact: no schema change; existing service-role read path is now fail-visible.
- Tests run: `tests/admin-wallet-read-boundary.test.ts`, `tests/admin-wallet-reconciliation-boundary.test.ts` (2 focused tests); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Validation evidence: 457 test files, 3,203 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `93f3594b`
- Status: Resolved in code; live Super Admin role/browser/outage evidence remains open
- Remaining dependencies: isolated Supabase read-failure, role, browser, RLS, and deployed admin smoke drills

### PLA-0336 - Admin wallet reconciliation hid ledger read failures as a healthy report

- Timestamp: 2026-07-15 15:45 America/New_York
- Service: Super Admin wallet reconciliation and ledger observability
- Route: `/admin/wallet/reconciliation`
- Affected files: `app/(app)/admin/wallet/reconciliation/page.tsx`, `tests/admin-wallet-reconciliation-boundary.test.ts`
- Role: Super Admin and financial operator
- Scenario: a failed bucket or transaction read became an empty array and the page could show a healthy report during a Supabase outage.
- Severity: P1
- Launch impact: operators could miss wallet anomalies or act on incomplete financial evidence.
- Root cause: parallel Supabase result errors were discarded during destructuring.
- Resolution: both read results are retained and checked; a server-side diagnostic is logged and the page renders a retryable ErrorState before reconciliation.
- Supabase impact: no schema change; existing service-role read boundary is now fail-visible.
- Tests run: `tests/admin-wallet-reconciliation-boundary.test.ts`, `tests/wallet-reconcile.test.ts` (12 focused tests); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Validation evidence: 456 test files, 3,202 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `712ee9b3`
- Status: Resolved in code; live Super Admin role/browser/outage evidence remains open
- Remaining dependencies: isolated Supabase read-failure, role, browser, RLS, and deployed admin smoke drills

### PLA-0335 - Stripe Checkout completion depended on a best-effort tracking insert

- Timestamp: 2026-07-15 15:40 America/New_York
- Service: Stripe Billing and abandoned-checkout lifecycle
- Route: `/api/billing/checkout`, `/api/billing/change-plan`, `/api/webhooks/stripe`
- Affected files: `app/api/billing/checkout/route.ts`, `app/api/billing/change-plan/route.ts`, `app/api/webhooks/stripe/route.ts`, `tests/billing-read-boundary.test.ts`
- Role: family manager, Stripe webhook processor, billing operator
- Scenario: a valid Stripe Checkout session could exist without a local tracking row when the pre-checkout insert failed; completion then treated the absent row as fatal.
- Severity: P1
- Launch impact: completed billing could produce a failed webhook and leave abandoned-checkout follow-up state unresolved.
- Root cause: tracking creation was best-effort but completion required a prior row.
- Resolution: validated plan metadata is attached to Checkout and the signed completion webhook upserts `checkout_sessions` by its unique session ID.
- Supabase impact: no schema change; the service-role checkout lifecycle now repairs missing tracking rows and preserves the existing service-only table boundary.
- Tests run: focused billing/webhook boundary suite (8 tests); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Validation evidence: 455 test files, 3,201 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `726a5e57`
- Status: Resolved in code; live Stripe completion/replay evidence remains open
- Remaining dependencies: isolated test-mode Checkout completion, duplicate delivery, and abandoned-checkout cron drills

### PLA-0334 - Billing provider mutations could return success after local sync failure

- Timestamp: 2026-07-15 15:40 America/New_York
- Service: Stripe Billing mutation and portal access
- Route: `/api/billing/change-plan`, `/api/billing/cancel`, `/api/billing/portal`
- Affected files: `app/api/billing/change-plan/route.ts`, `app/api/billing/cancel/route.ts`, `app/api/billing/portal/route.ts`, `tests/billing-read-boundary.test.ts`
- Role: family manager, household member, billing administrator, paid subscriber
- Scenario: Stripe could accept a plan change or cancellation while the local sync failed, while portal access and cancellation input needed explicit server-side boundaries.
- Severity: P0
- Launch impact: UI and entitlement state could diverge from Stripe or a non-manager could open billing management.
- Root cause: provider mutation and local persistence were reported as one full-success state without exposing a partial outcome.
- Resolution: plan change and cancellation return retryable `providerUpdated` partial-success responses on local sync failure; portal access is manager/admin-only; cancellation input is runtime-validated.
- Supabase impact: no schema change; local subscription updates remain family-scoped and now expose persistence failure to the caller.
- Tests run: focused billing/webhook boundary suite (8 tests); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check.
- Validation evidence: 455 test files, 3,201 tests, 0 production dependency vulnerabilities, 250-route build, 230-migration audit, and 11 schema probes passed.
- Commit: `726a5e57`
- Status: Resolved in code; live Stripe mutation/reconciliation evidence remains open
- Remaining dependencies: isolated test-mode change-plan, cancellation, portal, retry, and provider/local reconciliation drills

### PLA-0333 - Stripe webhook money effects could be acknowledged after failed side effects

- Timestamp: 2026-07-15 17:00 America/New_York
- Service: Stripe Billing and Stripe Issuing webhook processing
- Route: `/api/webhooks/money`, `/api/webhooks/stripe`, `lib/stripe/webhook.ts`
- Affected files: `app/api/webhooks/money/route.ts`, `app/api/webhooks/stripe/route.ts`, `lib/stripe/webhook.ts`, `tests/stripe-webhook-replay-contract.test.ts`
- Role: Stripe event processor, cardholder household, family manager, and paid subscriber
- Scenario: capture debit failure could be followed by hold release, authorization API failure could return success, card mapping failure could be treated as unknown card, and unknown subscription prices could become Free
- Severity: P0
- Launch impact: Stripe and wallet ledger state could diverge, paid entitlement could be lost, or financial events could be acknowledged without durable effects
- Root cause: webhook handlers ignored helper failures and unknown price mapping used a Free fallback
- Resolution: capture checks debit persistence before releasing holds; authorization/card mapping failures throw for retry; billing webhooks reject missing/unknown prices
- Supabase impact: no schema change; event claims remain replay-safe and wallet/subscription writes retain existing scoping and idempotency boundaries
- Tests run: `tests/stripe-webhook-replay-contract.test.ts`, `tests/stripe-issuing-auth.test.ts`, `tests/wallet-money-action-boundaries.test.ts` (19 focused tests); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check
- Validation evidence: latest full gate passed with 455 test files, 3,198 tests, 0 production dependency vulnerabilities, and a 250-route build
- Commit: `632402bf`
- Status: Resolved in code; live webhook evidence remains open
- Remaining dependencies: execute isolated Stripe signature, authorization, capture, reversal, duplicate-delivery, subscription, refund, connected-account, reconciliation, RLS, and browser drills against deployed services

### PLA-0332 - Shared wallet ledger helpers hid money-state read and release failures

- Timestamp: 2026-07-15 16:30 America/New_York
- Service: Shared Family Wallet ledger and Stripe Issuing card holds
- Route: `lib/wallet/server.ts`, Stripe issuing webhook handlers
- Affected files: `lib/wallet/server.ts`, `app/(app)/wallet/actions.ts`, `tests/wallet-money-action-boundaries.test.ts`
- Role: household member, family manager, or Stripe webhook processor
- Scenario: bucket/balance reads could become zero/default state, credits could use missing buckets, captured card spends could write without a Spend bucket, and hold-release update failures could be acknowledged
- Severity: P0
- Launch impact: financial state could diverge from actual wallet availability or a captured authorization hold could remain active after capture
- Root cause: shared money primitives discarded required Supabase read/update errors
- Resolution: balance, allocation, duplicate, bucket, and hold-release failures now fail closed; card capture requires a real Spend bucket and release failure propagates for retry
- Supabase impact: no schema change; existing ledger family scoping, RLS, and Stripe event processing boundaries remain in force
- Tests run: `tests/wallet-money-action-boundaries.test.ts` (7 focused tests); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check
- Validation evidence: latest full gate passed with 455 test files, 3,197 tests, 0 production dependency vulnerabilities, and a 250-route build
- Commit: `1439d361`
- Status: Resolved in code; live workflow evidence remains open
- Remaining dependencies: execute isolated authorization, capture, reversal, duplicate-delivery, reconciliation, RLS, concurrency, and browser drills against deployed Supabase/Stripe

### PLA-0331 - Wallet actions and entitlement reads hid Supabase failures

- Timestamp: 2026-07-15 16:00 America/New_York
- Service: Family Wallet money actions and subscription entitlement resolution
- Route: wallet server actions, `resolveFamilyPlanLevel`
- Affected files: `app/(app)/wallet/actions.ts`, `lib/server/plan.ts`, `tests/wallet-money-action-boundaries.test.ts`
- Role: household member, family manager, or any authenticated feature consumer gated by the active plan
- Scenario: failed wallet, ledger, gift, goal, Pay-ID, approval, transfer, subscription, or family reads could become not-found/default state or silently Free-tier entitlement
- Severity: P0
- Launch impact: users could make decisions from incomplete financial state, receive incorrect access, or encounter inconsistent paid-feature behavior during a Supabase outage
- Root cause: required query errors were discarded in action-level reads and plan resolution reduced unavailable reads to empty/default values
- Resolution: wallet actions now fail closed on required read errors; entitlement resolution logs and throws when subscription/family state is unavailable or the family row is missing
- Supabase impact: no schema change; existing family scoping, service-role entitlement read, and RLS boundaries remain in force
- Tests run: `tests/wallet-money-action-boundaries.test.ts` (6 focused tests); full Vitest; typecheck; lint; dependency audit; production build; migration audit; schema probes; diff check
- Validation evidence: latest full gate passed with 455 test files, 3,196 tests, 0 production dependency vulnerabilities, and a 250-route build
- Commit: `77402ceb`
- Status: Resolved in code; live workflow evidence remains open
- Remaining dependencies: execute isolated subscription/tier, wallet activation, approval-insert failure, concurrency, reconciliation, RLS, and browser drills against deployed Supabase

### PLA-0330 - Wallet money actions acknowledged incomplete required writes

- Timestamp: 2026-07-15 15:30 America/New_York
- Service: Family Wallet provisioning and spend approvals
- Route: `activateFamilyWalletAction`, `requestSpendAction`
- Affected files: `app/(app)/wallet/actions.ts`, `tests/wallet-money-action-boundaries.test.ts`
- Role: family manager provisioning a wallet, or household member requesting a spend approval
- Scenario: disclosure, member, child-wallet, bucket, or rule writes could fail while activation still returned success; a held debit could remain without a parent-approval row after approval creation failed
- Severity: P0
- Launch impact: incomplete wallet setup or unresolved held money movement could create false financial state and support incidents
- Root cause: required Supabase result errors were discarded and the multi-write spend-approval flow had no compensation path
- Resolution: activation now checks every required read/write and fails closed; approval-row failure cancels the family-scoped held debit before returning a sanitized error
- Supabase impact: no schema change; existing family predicates, RLS, and approval status transitions remain in force
- Tests run: `tests/wallet-money-action-boundaries.test.ts` (5 focused tests); full Vitest; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: latest full gate passed with 455 test files, 3,195 tests, 0 production dependency vulnerabilities, and a 250-route build
- Commit: `99bc0457`
- Status: Resolved in code; live workflow evidence remains open
- Remaining dependencies: execute isolated activation, approval-insert failure, concurrency, reconciliation, RLS, and browser drills against deployed Supabase

### PLA-0275 - Vacation AI persistence could leave partial itinerary state

- Timestamp: 2026-07-14
- Service: Vacation AI
- Route: `/api/ai/trip`, `/dashboard/vacations/[id]/ai-assistant`
- Affected files: `app/api/vacations/ai/route.ts`, `tests/vacation-ai-persistence-boundaries.test.ts`
- Role: authenticated family member with vacation access
- Scenario: generated recommendations, itinerary, activities, packing and concierge writes fail mid-request
- Severity: P1
- Launch impact: partial or cross-vacation data could be shown as a successful plan
- Root cause: context reads and follow-up writes were not uniformly checked or compensated
- Resolution: fail-closed reads, checked writes, compensation, and family/vacation conversation scoping
- Supabase impact: family/vacation filters and cleanup writes now define the persistence boundary
- Tests run: focused persistence, full Vitest, typecheck, lint, build, public E2E baseline
- Validation evidence: `tests/vacation-ai-persistence-boundaries.test.ts`, commit history
- Commit: `adfe3139`
- Status: Resolved in code; full service and provider audit remains open
- Remaining dependencies: live provider outage/cost and complete vacation UI workflow test

### PLA-0276 - AI meal planning could replace slots after a partial save

- Timestamp: 2026-07-14
- Service: Meals and AI planning
- Route: `/api/ai/meals/plan`, meal planner UI
- Affected files: `app/api/ai/meals/plan/route.ts`, `tests/ai-meal-plan-persistence.test.ts`
- Role: authenticated family member
- Scenario: generated plan writes fail after existing meal slots are removed
- Severity: P1
- Launch impact: meal plans could be silently incomplete or orphan generated rows
- Root cause: candidate/pantry reads and replacement writes were not fail-closed
- Resolution: checked reads, slot restoration, generated-row cleanup, and all-assignment success requirement
- Supabase impact: meal slot and generated meal writes now have explicit recovery behavior
- Tests run: focused AI meal tests, full Vitest, typecheck, lint, build
- Validation evidence: `tests/ai-meal-plan-persistence.test.ts`
- Commit: `45f911f6`
- Status: Resolved in code; full food service audit remains open
- Remaining dependencies: complete CRUD/import/empty-state and seed-profile verification

### PLA-0277 - AI chat accepted unverified conversation ownership

- Timestamp: 2026-07-14
- Service: AI chat and privacy
- Route: `/api/ai/chat`
- Affected files: `app/api/ai/chat/route.ts`, `tests/ai-chat-ownership.test.ts`
- Role: authenticated family member
- Scenario: client-supplied conversation UUID is reused across family or user boundaries
- Severity: P1
- Launch impact: private conversation history could be read or appended incorrectly
- Root cause: duplicate-tolerant upsert was not followed by explicit ownership read
- Resolution: family and user ownership are revalidated before history/messages are loaded or written
- Supabase impact: conversation reads and message persistence are scoped to active family and user
- Tests run: ownership regression, full Vitest, typecheck, lint, build
- Validation evidence: `tests/ai-chat-ownership.test.ts`
- Commit: `090ded80`
- Status: Resolved in code; complete AI/provider audit remains open
- Remaining dependencies: provider failure, streaming, quota, cost and role testing

### PLA-0278 - Chore transitions could silently diverge

- Timestamp: 2026-07-14
- Service: Chores and missions
- Route: `/missions`, `/kids`, parent review actions
- Affected files: `app/(app)/missions/actions.ts`, `tests/chore-state-transition-persistence.test.ts`
- Role: child submitter, parent/guardian reviewer
- Scenario: submission, assignment, dispute, reward or creation follow-up write fails
- Severity: P1
- Launch impact: proof and reward state could disagree, creating financial or trust disputes
- Root cause: related state transitions were best effort
- Resolution: checked transitions, rollback, dispute cleanup, parent-review fallback, and chore compensation
- Supabase impact: submission/assignment/dispute rows remain coordinated on failure
- Tests run: focused transition tests, full Vitest, typecheck, lint, build
- Validation evidence: `tests/chore-state-transition-persistence.test.ts`
- Commit: `19121862`
- Status: Resolved in code; full mission UI/role/upload audit remains open
- Remaining dependencies: complete browser, notification and dispute workflow matrix

### PLA-0279 - Manual allowance could skip failed payment

- Timestamp: 2026-07-15
- Service: Family Wallet allowances
- Route: `/wallet/allowance`
- Affected files: `app/(app)/wallet/actions.ts`, `tests/wallet-allowance-persistence.test.ts`
- Role: manager with Basic+ wallet access
- Scenario: due allowance credit fails after the schedule advances
- Severity: P1
- Launch impact: a child could permanently miss an allowance
- Root cause: rule reads and schedule writes were not fail-closed
- Resolution: checked schedule write, rollback on credit failure, success-only counters
- Supabase impact: allowance rule state remains due when credit does not persist
- Tests run: focused wallet persistence, full Vitest, typecheck, lint, audit, build
- Validation evidence: `tests/wallet-allowance-persistence.test.ts`
- Commit: `a466600b`
- Status: Resolved in code; live migration/RLS and full wallet audit remain open
- Remaining dependencies: deploy verification and concurrency/reconciliation tests

### PLA-0280 - Allowance cron ignored schedule and credit failures

- Timestamp: 2026-07-15
- Service: Scheduled wallet automation
- Route: `/api/cron/wallet-allowance`
- Affected files: `app/api/cron/wallet-allowance/route.ts`, `tests/cron-wallet-allowance-persistence.test.ts`
- Role: system cron with service-role access
- Scenario: schedule update or wallet credit fails during a due run
- Severity: P1
- Launch impact: duplicate or missing scheduled payments and invisible cron failures
- Root cause: schedule update was unchecked and happened after credit
- Resolution: checked schedule claim before credit, rollback on failure, visible failed response
- Supabase impact: allowance rule schedule and immutable ledger stay recoverable
- Tests run: focused cron/manual allowance tests, full Vitest, typecheck, lint, audit, build
- Validation evidence: `tests/cron-wallet-allowance-persistence.test.ts`
- Commit: `f5cbd014`
- Status: Resolved in code; scheduled-job replay and alerting audit remains open
- Remaining dependencies: cron observability and live replay smoke

### PLA-0281 - Goal funding could debit without updating goal progress

- Timestamp: 2026-07-15 07:49 America/New_York
- Service: Family Wallet savings goals
- Route: `/wallet/goals`
- Affected files: `supabase/migrations/0208_atomic_wallet_goal_funding.sql`, `lib/wallet/server.ts`, `lib/database.types.ts`, `app/(app)/wallet/actions.ts`, `tests/wallet-goal-persistence.test.ts`
- Role: parent/guardian manager
- Scenario: Save-bucket balance is checked, debit is inserted, and goal update/audit fails or races
- Severity: P1
- Launch impact: money can leave the Save bucket without matching goal progress
- Root cause: separate best-effort client writes and non-locking balance read
- Resolution: manager-checked row-locking RPC atomically rechecks balance, debits ledger, updates goal/status, and writes audit
- Supabase impact: new `wallet_fund_goal` function and migration `0208`; typed wrapper replaces direct writes
- Tests run: focused goal/atomic contracts, 403-file/3,024-test suite, typecheck, lint, audit, schema probes, seed invariant, clean build
- Validation evidence: `tests/wallet-goal-persistence.test.ts`, `npm.cmd run db:audit:schema`, 250-route build
- Commit: `7a20e160`
- Status: Resolved in code and pushed to `main`; remote migration application remains a dependency
- Remaining dependencies: reconcile/apply migration remotely, then run authenticated wallet concurrency smoke

## Open Launch Findings

### AUDIT-AUTH-001 - Privileged admin action guard coverage was implicit

- Timestamp: 2026-07-15 07:59 America/New_York
- Service: Authentication and tenant isolation
- Route: `/admin/*`, `middleware.ts`
- Affected files: `tests/admin-auth-boundary.test.ts`, `app/(app)/admin/layout.tsx`, `middleware.ts`, `lib/marketing/admin.ts`
- Role: Super Admin, standard authenticated user, anonymous visitor
- Scenario: a future admin server action accidentally creates a service-role client without rechecking privilege
- Severity: P2
- Launch impact: regression risk could expose cross-family or site-wide data through a privileged action
- Root cause: guard convention existed in code but had no repository-wide drift test
- Resolution: static regression test now scans all service-role admin action files and asserts explicit privileged guards plus page/session gates
- Supabase impact: protects service-role access to cross-family tables; it does not replace live RLS verification
- Tests run: `tests/admin-auth-boundary.test.ts`, full 405-file/3,030-test suite, typecheck, lint, dependency audit
- Validation evidence: all 38 service-role admin action files passed the guard scan
- Commit: `f464ac9e`
- Status: Resolved in code; auth unit remains in progress
- Remaining dependencies: live Auth Admin health, cross-tenant RLS probes, authenticated E2E roles

### PLA-B001 - Auth Admin health is unverified

- Timestamp: 2026-07-16 08:26 America/New_York (latest retest)
- Service: Authentication and tenant operations
- Route: Supabase Auth Admin users endpoint
- Affected files: `scripts/audit-supabase-auth.mjs`, auth configuration and deployment secrets
- Role: operator, admin, all authenticated roles
- Scenario: production user administration and account lifecycle are exercised
- Severity: P0
- Launch impact: cannot certify account creation, recovery, admin control, or role lifecycle
- Root cause: live endpoint currently returns HTTP 500 `Database error finding users` while public Auth health passes
- Resolution: none yet; tracked as `LB-001`
- Supabase impact: Auth Admin health and user lifecycle remain unverified
- Tests run: `npm.cmd run db:audit:auth` (public Auth health passed; Admin users failed with request `019f6ae2-b616-7860-9608-8f23138c5e72`)
- Validation evidence: `docs/LAUNCH_BLOCKERS.md`, `docs/PRODUCTION_READINESS_REPORT.md`
- Commit: n/a
- Status: Open
- Remaining dependencies: Supabase operator diagnosis and live retest

### PLA-B002 - Remote migration history and credential rotation are unverified

- Timestamp: 2026-07-15
- Service: Supabase deployment and secrets
- Route: database migration/deployment pipeline
- Affected files: migrations, deployment environment configuration, secret manager
- Role: deployer/operator
- Scenario: launch applies the checkout to production and revokes historical credentials
- Severity: P0
- Launch impact: schema drift or leaked credentials can invalidate all feature-level evidence
- Root cause: checkout is not linked to a confirmed remote migration ledger; historical credential rotation is pending
- Resolution: none yet; tracked as `LB-002` and `LB-003`
- Supabase impact: migration application, key revocation and RLS posture are not fully proven
- Tests run: local migration audit and 11 schema probes only
- Validation evidence: `docs/LAUNCH_BLOCKERS.md`, `docs/SUPABASE_WIRING_MATRIX.md`
- Commit: n/a
- Status: Open
- Remaining dependencies: Supabase access and secret-manager operation

### PLA-0282 - Onboarding finalization could duplicate records on replay

- Timestamp: 2026-07-15 08:10 America/New_York
- Service: Onboarding and household provisioning
- Route: `/onboarding`
- Affected files: `app/onboarding/actions.ts`, `lib/onboarding/idempotency.ts`, `lib/database.types.ts`, `supabase/migrations/0210_onboarding_idempotency.sql`, `tests/onboarding-idempotency.test.ts`
- Role: new account owner; family administrator
- Scenario: browser timeout, double-submit, or partial required write followed by a resumed wizard submission
- Severity: P1
- Launch impact: duplicate managed members, invitations, calendar events, import markers, and repeated invite email delivery
- Root cause: multi-table finalization used blind inserts without a stable submission/item identity
- Resolution: authenticated deterministic SHA-256 submission/item keys, nullable database columns with family-scoped unique indexes, keyed upserts, existing-invite token reuse without duplicate delivery, and a service-only `onboarding_claim_family` RPC with a per-user transactional advisory lock
- Supabase impact: migration `0210_onboarding_idempotency.sql` adds four nullable columns and four unique indexes; no destructive data operation
- Tests run: focused onboarding safety/idempotency/migration tests, full Vitest, typecheck, lint, dependency audit, migration audit, diff check, production build
- Validation evidence: 8 focused tests; 406 files/3,033 tests; 226 numbered migrations with next `0211`; 250-route build; 0 dependency vulnerabilities
- Commit: `6148080d`
- Status: Resolved in code; remote migration application, live RLS, and authenticated E2E remain open dependencies
- Remaining dependencies: apply `0210`, exercise partial-failure replay in isolated Supabase, verify invite/email behavior and cross-tenant denial

### PLA-0283 - Guardian escalation could replay telephony or miss parent phones

- Timestamp: 2026-07-15 08:30 America/New_York
- Service: Guardian emergency escalation
- Route: `/api/guardian/escalate`
- Affected files: `app/api/guardian/escalate/route.ts`, `lib/guardian/escalation.ts`, `lib/guardian/callbacks.ts`, `tests/guardian-escalation-replay.test.ts`
- Role: Guardian system notifying family parents/managers
- Scenario: a valid internal escalation request is retried or needs to resolve parent phone numbers
- Severity: P1
- Launch impact: duplicate SMS/calls or silent failure to notify parents
- Root cause: the route had no durable callback claim before telephony, and it queried `profiles.id` using `family_members.id` instead of `family_members.user_id`
- Resolution: bounded Zod payload validation, communication-aware deterministic event IDs, service-only callback claim/error/processed state, and correct profile lookup through `user_id`
- Supabase impact: reuses `guardian_callback_events` from migration `0181_guardian_callback_replay.sql`; no schema change
- Tests run: `tests/guardian-escalation-replay.test.ts` and `tests/guardian-callback-security.test.ts` (11 tests), typecheck, diff check
- Validation evidence: claim occurs before `sendSms`/`initiateCall`; parent phones resolve from profile IDs; callback errors remain retryable
- Commit: `6148080d`
- Status: Resolved in code; live provider, role/privacy, and RLS verification remain open
- Remaining dependencies: run isolated Twilio retry/failure smoke tests and verify parent notification privacy in Supabase

### PLA-0284 - Family membership RLS allowed self-promotion and family reassignment

- Timestamp: 2026-07-15 08:42 America/New_York
- Service: Authentication, tenant isolation, and RLS
- Route: `/family/members`, `/family/permissions`, direct authenticated Supabase membership writes
- Affected files: `supabase/migrations/0118_rls_drift_repair.sql`, `supabase/migrations/0211_family_members_update_rls.sql`, `tests/tenant-isolation-rls.test.ts`
- Role: any authenticated family member; parent/manager administrator
- Scenario: a non-manager updates their own `family_members` row to change role, `is_active`, or `family_id`
- Severity: P0
- Launch impact: tenant membership and role boundaries could be escalated or reassigned, undermining all family-scoped RLS
- Root cause: migration `0118` restored the legacy `or user_id = auth.uid()` UPDATE exception without a manager-only `WITH CHECK`
- Resolution: migration `0211_family_members_update_rls.sql` reasserts manager-only `USING` and `WITH CHECK` policies; profile and child-login writes remain server-side service-role operations after auth guards
- Supabase impact: policy-only repair on `family_members`; no destructive data change; migration must be applied remotely
- Tests run: four focused files, 9 tests; typecheck; migration filename audit; diff check
- Validation evidence: migration contains manager-only update predicates and no self-update exception; ordinary account actions have no direct client membership update path
- Commit: `eb99f0a0`
- Status: Resolved in code; remote migration application and authenticated two-tenant RLS verification remain open
- Remaining dependencies: apply `0211`, prove non-manager deny/manager allow behavior, and re-run Auth Admin health

### PLA-0285 - Admin notification failures were silent to operators

- Timestamp: 2026-07-15 09:04 America/New_York
- Service: Admin operations and notification observability
- Route: `/admin/notifications`, global admin notification bell
- Affected files: `lib/admin/notify.ts`, `app/(app)/admin/notifications-actions.ts`, `components/admin/admin-notifications-list.tsx`, `components/admin/admin-notification-bell.tsx`, `tests/admin-notification-boundary.test.ts`
- Role: Super Admin; server-side alert producers
- Scenario: an `admin_notifications` insert or mark-read update fails at the Supabase boundary
- Severity: P1
- Launch impact: operational alerts could disappear without diagnostics, or a Super Admin could be shown stale unread state after a failed mutation
- Root cause: returned Supabase insert errors were ignored, and the client refreshed regardless of the mark-read action result
- Resolution: log returned insert errors and expose sanitized action failures through accessible alert states; refresh only after success
- Supabase impact: existing service-role-only `admin_notifications` table; no migration or data change
- Tests run: `tests/admin-notification-boundary.test.ts` and `tests/admin-notifications.test.ts` (12 tests), full 409-file/3,045-test suite, typecheck, lint, dependency audit, migration audit, diff check, and production build
- Validation evidence: producer checks query errors; both history and bell handlers branch on `{ ok: false }` before `router.refresh()`; 250-route build passed; live schema audit passed all 11 checks
- Commit: `991ad4dd`
- Status: Resolved in code; live Super Admin workflow and failure-injection evidence remain open
- Remaining dependencies: failure injection, auth permission, alert routing, and browser/operator smoke tests

### PLA-0286 - Connections hub reported label-only integrations as live

- Timestamp: 2026-07-15 09:14 America/New_York
- Service: Family Connections and third-party integrations
- Route: `/dashboard/connections`
- Affected files: `components/modules/connections-module.tsx`, `lib/connections/providers.ts`, `tests/connections-providers.test.ts`, `tests/connections-ui-boundary.test.ts`
- Role: authenticated family members
- Scenario: a member clicked Connect for Gmail, banking, grocery, or smart-home providers without a real OAuth/sync flow
- Severity: P1
- Launch impact: the UI could show an integration as Connected after saving only a label, while no credentials, sync account, or data ingestion existed
- Root cause: the module upserted `family_connections` directly from a free-form account field and treated the directory record as a live integration
- Resolution: live Google, Microsoft, and Apple entries now route to their real sync setup pages; unsupported providers no longer open a fake account modal or persist a false-success row
- Supabase impact: no schema change; removes the false-positive write path while retaining family-scoped reads and disconnects
- Tests run: `tests/connections-providers.test.ts`, `tests/connections-adapter.test.ts`, and `tests/connections-ui-boundary.test.ts` (23 tests), full 410-file/3,048-test suite, typecheck, lint, dependency audit, migration audit, diff check, and production build
- Validation evidence: UI contract asserts no label-only upsert/modal and asserts implemented-provider routing; full suite and 250-route build pass
- Commit: `6bd8758f`
- Status: Resolved in code; full third-party integration audit remains open
- Remaining dependencies: push verification and real Gmail, banking, grocery, and smart-home provider implementations

### PLA-0287 - Admin digest cron hid feed and delivery failures

- Timestamp: 2026-07-15 09:24 America/New_York
- Service: Notifications, cron, and operational observability
- Route: `/api/cron/admin-digest`
- Affected files: `app/api/cron/admin-digest/route.ts`, `lib/admin/digest.ts`, `tests/admin-digest.test.ts`
- Role: Super Admin recipients; operations owner
- Scenario: the `admin_notifications` query fails, Resend is disabled, or one recipient delivery fails
- Severity: P1
- Launch impact: the daily digest could claim a quiet day for an unavailable feed, count skipped email as delivered, or return HTTP 200 after partial failure
- Root cause: the route ignored the Supabase read error and counted only boolean success rather than the email provider's `{ ok, skipped }` result
- Resolution: fail closed with a sanitized 502 on feed errors; summarize sent/skipped/failed delivery; return 502 when any recipient fails
- Supabase impact: no schema change; operational read failures are now visible to cron monitoring
- Tests run: `tests/admin-digest.test.ts`, `tests/cron-auth.test.ts`, and `tests/admin-notification-boundary.test.ts` (20 tests), full 411-file/3,061-test suite, typecheck, lint, dependency audit, migration audit, diff check, and production build
- Validation evidence: delivery summary tests cover disabled email and partial failure; static route contracts cover feed-error 502 and non-2xx delivery handling; 250-route build passes
- Commit: `50cbbeef`
- Status: Resolved in code; live cron/provider delivery remains open
- Remaining dependencies: Resend sandbox delivery, alert routing, scheduled invocation, and remote deployment verification

### PLA-0288 - Legacy connection adapters reported planned sync as runnable

- Timestamp: 2026-07-15 09:33 America/New_York
- Service: Family Connections and third-party integrations
- Route: legacy adapter registry and sync planner contract
- Affected files: `lib/connections/adapter.ts`, `lib/connections/adapters/google-calendar.ts`, `lib/connections/adapters/gmail.ts`, `lib/connections/adapters/index.ts`, `tests/connections-adapter.test.ts`
- Role: authenticated family member; background sync worker
- Scenario: Google Calendar or Gmail OAuth keys were present and a saved connection existed, but the planned adapter methods returned empty success without making provider calls
- Severity: P1
- Launch impact: a future worker could mark a provider sync as runnable and advance an empty cursor or report zero pushed items as success
- Root cause: the reference adapters declared capabilities and used key presence as readiness even though their provider I/O was still TODO
- Resolution: planned adapters now declare `isImplemented: false`, the planner blocks them as unsupported, and credentialed methods return explicit unavailable errors; only implemented adapters are reported by `syncableProviderIds()`
- Supabase impact: no schema change; prevents false-positive sync execution before provider credentials, token lifecycle, and API calls are wired
- Tests run: focused Connections suite (25 tests), full 411-file/3,063-test suite, typecheck, lint, dependency audit, migration audit, diff check, and production build
- Validation evidence: planner and credentialed execution regressions cover fail-closed behavior; 250-route build passes
- Commit: `0ae5cdb0`
- Status: Resolved in code; full third-party integration audit remains open
- Remaining dependencies: implement real Gmail, banking, grocery, and smart-home providers, then verify OAuth callbacks, token storage, retries, and provider sandbox behavior

### PLA-0289 - Provider sync cron returned success after account failures

- Timestamp: 2026-07-15 09:35 America/New_York
- Service: Notifications, cron, and provider synchronization
- Route: `/api/cron/provider-sync`
- Affected files: `app/api/cron/provider-sync/route.ts`, `tests/cron-provider-sync.test.ts`
- Role: scheduled system worker; connected account owner
- Scenario: one or more account syncs failed, but the cron response still returned HTTP 200 with `ok: true`
- Severity: P1
- Launch impact: scheduler and alerting could record a failed provider run as successful, delaying retry or operator response
- Root cause: the route counted failures but hard-coded the final response to success
- Resolution: final status now derives from `failed === 0`; any account failure returns sanitized HTTP 502 and `ok: false`, while per-account details remain available
- Supabase impact: no schema change; existing sync failure rows and audit logging remain unchanged
- Tests run: `tests/cron-provider-sync.test.ts`, `tests/cron-auth.test.ts`, and `tests/database-error-boundaries.test.ts` (7 tests), full 412-file/3,065-test suite, typecheck, lint, dependency audit, migration audit, diff check, and production build
- Validation evidence: route contract covers non-2xx failure status and sanitized response fields; 250-route build passes
- Commit: `24e0b64d`
- Status: Resolved in code; live scheduled invocation and provider callback evidence remain open
- Remaining dependencies: run an authenticated provider failure/retry drill, verify alert routing, and validate remote cron deployment

### PLA-0290 - Batch crons hid partial failures behind success responses

- Timestamp: 2026-07-15 09:44 America/New_York
- Service: Scheduled automation, calendar feeds, Autopilot, model refresh, and marketplace settlement
- Route: `/api/cron/calendar-feeds`, `/api/cron/autopilot-scan`, `/api/cron/model-refresh`, `/api/cron/close-auctions`
- Affected files: `app/api/cron/calendar-feeds/route.ts`, `app/api/cron/autopilot-scan/route.ts`, `app/api/cron/model-refresh/route.ts`, `app/api/cron/close-auctions/route.ts`, `tests/cron-batch-failure-status.test.ts`
- Role: scheduled system worker; affected family and marketplace operators
- Scenario: one or more feed, family refresh, Autopilot, or auction settlement operations failed while the cron endpoint still returned HTTP 200 or omitted the failure count
- Severity: P1
- Launch impact: scheduler monitoring could mark partial outages as healthy and delay retries or operator response
- Root cause: batch routes exposed counters but hard-coded success status, and auction RPC errors were only logged
- Resolution: each route now derives `ok` from its failure counter, returns sanitized HTTP 502 on partial failure, and includes settlement failures in the auction summary
- Supabase impact: no schema change; failed work remains retryable and existing transaction boundaries are unchanged
- Tests run: `tests/cron-batch-failure-status.test.ts`, `tests/cron-provider-sync.test.ts`, `tests/cron-auth.test.ts`, and `tests/database-error-boundaries.test.ts` (11 tests), full 413-file/3,069-test suite, typecheck, lint, dependency audit, migration audit, diff check, and production build
- Validation evidence: static contracts cover all four routes; 250-route build passes
- Commit: `f8226011` (published in merge `59c422ac`)
- Status: Resolved in code; live scheduled invocation and retry/alert routing evidence remain open
- Remaining dependencies: execute isolated failure drills for each cron, verify retry behavior, alert routing, and remote deployment

### PLA-0291 - Notification delivery crons hid push and generation failures

- Timestamp: 2026-07-15 09:50 America/New_York
- Service: Notifications, push delivery, and scheduled automation
- Route: `/api/cron/notifications`, `/api/cron/push-scan`
- Affected files: `app/api/cron/notifications/route.ts`, `app/api/cron/push-scan/route.ts`, `tests/cron-notification-failure-status.test.ts`
- Role: scheduled system worker; family notification recipients
- Scenario: notification generation or push dispatch/delivery failed while the cron endpoint returned HTTP 200 without a failure summary
- Severity: P1
- Launch impact: push outages could be recorded as healthy and notification generation failures could remain hidden until users reported missing alerts
- Root cause: both routes logged per-family/dispatch failures but returned delivery data without deriving endpoint status from those failures
- Resolution: generation, dispatch, and push result failures now contribute to a sanitized failure count; any non-zero count returns `ok: false` and HTTP 502
- Supabase impact: no schema change; existing notification delivery markers and retry behavior remain unchanged
- Tests run: `tests/cron-notification-failure-status.test.ts`, `tests/cron-batch-failure-status.test.ts`, `tests/cron-provider-sync.test.ts`, `tests/cron-auth.test.ts`, and `tests/database-error-boundaries.test.ts` (13 tests), full 414-file/3,071-test suite, typecheck, lint, dependency audit, migration audit, diff check, and production build
- Validation evidence: static contracts cover both routes and preserve sanitized errors; 250-route build passes
- Commit: `92eb434a`
- Status: Resolved in code; live push/email provider delivery and scheduled retry evidence remain open
- Remaining dependencies: run live push/email provider failure drills, verify alert routing, and validate remote cron deployment

### PLA-0292 - Notification email delivery hid provider and persistence failures

- Timestamp: 2026-07-15 09:56 America/New_York
- Service: Notifications and email delivery
- Route: `/api/cron/notifications`, `deliverNotificationEmails`
- Affected files: `lib/server/notification-emails.ts`, `app/api/cron/notifications/route.ts`, `tests/notification-email-boundary.test.ts`, `tests/cron-notification-failure-status.test.ts`
- Role: scheduled system worker; family notification recipients
- Scenario: pending notification reads, preference/recipient lookups, email sends, or `sent_at` resolution updates failed while the helper returned only a sent count
- Severity: P1
- Launch impact: email outages could be mistaken for an empty queue, and successful sends could be retried without a visible persistence failure
- Root cause: Supabase errors were ignored and provider failures were not represented in the return value
- Resolution: the helper now returns `sent`, `failed`, and `skipped`, checks each read/update boundary, leaves failed sends unresolved for retry, and feeds email failures into the cron's sanitized 502 response
- Supabase impact: no schema change; failed `sent_at` updates remain retryable and successful sends preserve existing resolution behavior
- Tests run: `tests/notification-email-boundary.test.ts`, `tests/cron-notification-failure-status.test.ts`, `tests/cron-auth.test.ts`, and `tests/database-error-boundaries.test.ts` (9 tests), full 415-file/3,073-test suite, typecheck, lint, dependency audit, migration audit, diff check, and production build
- Validation evidence: helper and cron contracts cover read/send/update failures; 250-route build passes
- Commit: `a704a41f`
- Status: Resolved in code; live Resend/provider failure and retry evidence remain open
- Remaining dependencies: run sandbox email failure/duplicate/retry drills, verify alert routing, and validate remote cron deployment

### PLA-0293 - Concurrent protected requests could create duplicate first families

- Timestamp: 2026-07-15 10:08 America/New_York
- Service: Authentication, onboarding, and tenant provisioning
- Route: `requireUserContext` / `ensureActiveFamily`
- Affected files: `lib/server/ensure-family.ts`, `supabase/migrations/0212_atomic_family_provisioning.sql`, `lib/database.types.ts`, `tests/ensure-family-concurrency.test.ts`
- Role: newly authenticated account owner
- Scenario: multiple tabs, refreshes, or parallel protected server components reach family provisioning before the first membership is visible
- Severity: P1
- Launch impact: one account could receive multiple household spaces, splitting preferences and subsequent family data
- Root cause: the membership check, family insert, owner membership, subscription, and active-family preference were separate service-role statements with no per-user lock
- Resolution: the primary provisioning path now calls a service-only security-definer RPC guarded by `pg_advisory_xact_lock` and performs the first-family writes in one transaction; a compatibility fallback preserves rolling deployments until migration `0212` is applied
- Supabase impact: adds `ensure_family_for_user` in migration `0212`; no destructive data changes; the RPC only creates a family when no active membership exists
- Tests run: `tests/ensure-family-concurrency.test.ts` and `tests/onboarding-idempotency.test.ts` (5 tests), typecheck, migration audit, and diff check
- Validation evidence: migration audit passes for 228 numbered SQL files with next version `0213`; the regression contract verifies the lock, service-role grant, and primary RPC path
- Commit: `e0674b15`
- Status: Resolved in code; remote migration application and authenticated concurrent onboarding verification remain open
- Remaining dependencies: apply `0212`, run an isolated two-request first-login drill, and verify the resulting account has exactly one active family and one active-family preference

### PLA-0294 - Admin document deletion could orphan private storage objects

- Timestamp: 2026-07-15 10:20 America/New_York
- Service: Super Admin content management and private document storage
- Route: `/admin/content`
- Affected files: `app/(app)/admin/actions.ts`, `components/admin/document-row-actions.tsx`, `tests/admin-document-delete-boundary.test.ts`
- Role: Super Admin
- Scenario: storage removal failed or the database row was missing while the action still continued toward deletion
- Severity: P1
- Launch impact: the console could report success while leaving private objects orphaned, or delete a row without a confirmed target
- Root cause: storage removal errors and missing/empty database delete results were ignored; the client-supplied path was trusted over the database row
- Resolution: the action now loads the document target, uses its canonical `storage_path`, stops on storage failure, and requires a returned database row before auditing success
- Supabase impact: no schema change; storage and row deletion remain Super Admin-only and retryable after failure
- Tests run: `tests/admin-document-delete-boundary.test.ts`, `tests/admin-auth-boundary.test.ts`, and `tests/admin-management-action-boundaries.test.ts` (6 tests), full 417-file/3,079-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contract verifies storage failure ordering, canonical path use, missing-row handling, and confirmed delete result
- Commit: `34a24ddd`
- Status: Resolved in code; live storage failure drill and Super Admin browser verification remain open
- Remaining dependencies: run an isolated storage error/delete retry drill and verify object/row parity after success and failure

### PLA-0295 - Admin family creation relied on an optional trigger for owner access

- Timestamp: 2026-07-15 10:24 America/New_York
- Service: Super Admin user and family management
- Route: `/admin/users`
- Affected files: `app/(app)/admin/actions.ts`, `tests/admin-family-create-boundary.test.ts`
- Role: Super Admin creating a family for an existing account
- Scenario: the family insert succeeded while the `handle_new_family` trigger was missing, unapplied, or failed to create the owner membership/subscription
- Severity: P1
- Launch impact: the new owner could not see the family, and the admin console could report a successful family creation with incomplete tenant state
- Root cause: `adminCreateFamilyAction` inserted only the family and trusted a non-authoritative trigger
- Resolution: the action now checks owner lookup failures, explicitly upserts the parent membership, ensures a trial subscription, and rolls back the new family on required-write failure
- Supabase impact: no schema change; existing trigger-created rows are reconciled idempotently
- Tests run: `tests/admin-family-create-boundary.test.ts`, `tests/admin-document-delete-boundary.test.ts`, and `tests/admin-auth-boundary.test.ts` (6 tests), full 418-file/3,081-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contract covers owner lookup, membership reconciliation, trial creation, and cleanup paths
- Commit: `46a227b1`
- Status: Resolved in code; live Super Admin family creation and rollback verification remain open
- Remaining dependencies: run an isolated trigger-disabled family creation drill and verify owner visibility, subscription state, and rollback parity

### PLA-0296 - Admin users hid super-admin allowlist read failures

- Timestamp: 2026-07-15 10:28 America/New_York
- Service: Super Admin user and access management
- Route: `/admin/users`
- Affected files: `app/(app)/admin/users/page.tsx`, `tests/admin-users-read-boundary.test.ts`
- Role: Super Admin
- Scenario: the `super_admins` query failed while the page continued rendering the DB-backed allowlist as an empty set
- Severity: P1
- Launch impact: an operator could misread a privileged-access outage as “no database admins” and make unsafe access decisions
- Root cause: the page included seven Supabase result errors in `loadErrors` but omitted `superAdminsRes`
- Resolution: `super_admins` is now included in the same visible error aggregation used by the users/families page
- Supabase impact: no schema change; read failure behavior is now explicit and non-destructive
- Tests run: `tests/admin-users-read-boundary.test.ts`, `tests/admin-auth-boundary.test.ts`, and `tests/admin-read-boundaries.test.ts` (6 tests), full 419-file/3,082-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contract verifies the allowlist result is part of the visible Supabase error path
- Commit: `c8ec95b1`
- Status: Resolved in code; live Super Admin browser/read-failure verification remains open
- Remaining dependencies: run an isolated `super_admins` read failure drill and verify the page preserves the error banner and does not present an empty allowlist as authoritative

### PLA-0297 - Admin content page hid Supabase read failures as empty content

- Timestamp: 2026-07-15 10:34 America/New_York
- Service: Super Admin content management and document storage
- Route: `/admin/content`
- Affected files: `app/(app)/admin/content/page.tsx`, `tests/admin-content-read-boundary.test.ts`
- Role: Super Admin
- Scenario: documents, family labels, or uploader profile reads failed while the page substituted empty arrays
- Severity: P1
- Launch impact: a storage/database outage could appear as an empty content library, hiding operational data and encouraging incorrect follow-up actions
- Root cause: all three Supabase errors were discarded during destructuring
- Resolution: the page now aggregates the three read errors, logs the boundary, and renders a refreshable error state instead of an empty table
- Supabase impact: no schema change; read behavior is explicit and non-destructive
- Tests run: `tests/admin-content-read-boundary.test.ts`, `tests/admin-users-read-boundary.test.ts`, and `tests/admin-read-boundaries.test.ts` (5 tests), full 420-file/3,083-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contract covers documents, families, profiles, and the visible error state
- Commit: `5c4bad4d`
- Status: Resolved in code; live content outage and Super Admin browser evidence remain open
- Remaining dependencies: run an isolated content-read failure drill and verify the refresh path preserves the operator context

### PLA-0298 - Admin reports hid analytics read failures as zero metrics

- Timestamp: 2026-07-15 10:40 America/New_York
- Service: Super Admin reports and analytics
- Route: `/admin/reports`
- Affected files: `app/(app)/admin/reports/page.tsx`, `tests/admin-reports-read-boundary.test.ts`
- Role: Super Admin
- Scenario: any count, trend, subscription, document, or audit-log query failed while the page substituted empty arrays or zero counts
- Severity: P1
- Launch impact: operators could make decisions from fabricated zero-valued growth, revenue, activity, or storage metrics during a data outage
- Root cause: all eight Supabase result errors were discarded during destructuring
- Resolution: the page now preserves each result error, logs the boundary, and renders a refreshable error state before deriving metrics
- Supabase impact: no schema change; analytics failures are explicit and non-destructive
- Tests run: `tests/admin-reports-read-boundary.test.ts`, `tests/admin-content-read-boundary.test.ts`, and `tests/admin-read-boundaries.test.ts` (5 tests), full 421-file/3,084-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contract verifies the count and activity error paths plus the visible error state
- Commit: `5353c8ce`
- Status: Resolved in code; live analytics outage and Super Admin browser evidence remain open
- Remaining dependencies: run isolated count/trend read-failure drills and verify no zero-valued report is presented as authoritative

### PLA-0299 - Admin audit views hid incomplete history after read failures

- Timestamp: 2026-07-15 10:45 America/New_York
- Service: Super Admin audit and audit-log history
- Routes: `/admin/audit`, `/admin/audit-logs`
- Affected files: `app/(app)/admin/audit/page.tsx`, `app/(app)/admin/audit-logs/page.tsx`, `tests/admin-audit-read-boundary.test.ts`
- Role: Super Admin
- Scenario: the audit-log, family, or actor-profile query failed while either page substituted an empty result and presented incomplete history
- Severity: P1
- Launch impact: operators could miss sensitive actions or trust an incomplete audit trail during a Supabase outage
- Root cause: audit read errors were discarded by both page loaders
- Resolution: both pages now preserve read errors, log the boundary, and render a refreshable error state before filtering or displaying history
- Supabase impact: no schema change; audit-read failures are explicit and non-destructive
- Tests run: `tests/admin-audit-read-boundary.test.ts`, `tests/admin-read-boundaries.test.ts`, and `tests/admin-auth-boundary.test.ts` (7 tests), full 422-file/3,086-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contracts verify log, family, actor-profile, and complete-history failure paths plus visible retry states
- Commit: `03442ccf`
- Status: Resolved in code; live audit outage and Super Admin browser evidence remain open
- Remaining dependencies: run isolated audit-read failure drills and verify the operator can distinguish unavailable history from an empty history

### PLA-0300 - Admin operational pages hid usage read failures as zero metrics

- Timestamp: 2026-07-15 10:54 America/New_York
- Service: Super Admin system and data operations
- Routes: `/admin/system`, `/admin/backup`
- Affected files: `app/(app)/admin/system/page.tsx`, `app/(app)/admin/backup/page.tsx`, `tests/admin-system-read-boundary.test.ts`
- Role: Super Admin
- Scenario: a privileged count, profile, subscription, document, or tracked-table query failed while the page substituted zero-valued usage metrics
- Severity: P1
- Launch impact: operators could interpret unavailable system usage, storage, or table counts as an empty but healthy platform
- Root cause: Supabase read errors were discarded while deriving counts and storage totals
- Resolution: both pages now preserve query errors, log the read boundary, and render refreshable error states before displaying usage metrics
- Supabase impact: no schema change; operational-read failures are explicit and non-destructive
- Tests run: `tests/admin-system-read-boundary.test.ts`, `tests/admin-audit-read-boundary.test.ts`, and `tests/admin-read-boundaries.test.ts` (6 focused tests across 3 files), full 423-file/3,092-test suite, migration audit, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contracts verify system and table-count failure paths plus visible retry states
- Commit: `ecfb4f95`; merged remote work is preserved in `4accc171`
- Status: Resolved in code; live operational outage and Super Admin browser evidence remain open
- Remaining dependencies: run isolated usage-read failure drills and verify the operator can distinguish unavailable metrics from zero metrics

### PLA-0301 - Admin billing and notifications hid read failures as empty views

- Timestamp: 2026-07-15 11:00 America/New_York
- Service: Super Admin billing and notification center
- Routes: `/admin/billing`, `/admin/notifications`
- Affected files: `app/(app)/admin/billing/page.tsx`, `app/(app)/admin/notifications/page.tsx`, `tests/admin-billing-notifications-read-boundary.test.ts`
- Role: Super Admin
- Scenario: subscription, billing-customer, family, or admin-notification queries failed while the page substituted empty arrays or zero counts
- Severity: P1
- Launch impact: operators could miss revenue state or operational alerts during a Supabase read outage
- Root cause: billing and notification read errors were discarded during page loading
- Resolution: both pages now preserve read errors, log the boundary, and render refreshable error states before computing metrics or digest summaries
- Supabase impact: no schema change; billing and alert-feed read failures are explicit and non-destructive
- Tests run: `tests/admin-billing-notifications-read-boundary.test.ts` (2 focused tests), full 424-file/3,094-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contracts verify all three billing reads, the notification feed read, and visible retry states
- Commit: `c0bd9ffa`
- Status: Resolved in code; live billing/notification outage and Super Admin browser evidence remain open
- Remaining dependencies: run isolated billing and notification read-failure drills and verify no empty view is presented as authoritative

### PLA-0302 - Admin feedback and integrations hid read failures as empty or unconfigured

- Timestamp: 2026-07-15 11:04 America/New_York
- Service: Super Admin feedback queue and integrations
- Routes: `/admin/feedback`, `/admin/integrations`
- Affected files: `app/(app)/admin/feedback/page.tsx`, `app/(app)/admin/integrations/page.tsx`, `tests/admin-feedback-integrations-read-boundary.test.ts`
- Role: Super Admin
- Scenario: feedback ideas/comments/alerts or connected-account status failed to load while the UI substituted an empty board or “not configured” status
- Severity: P1
- Launch impact: operators could miss user feedback or misdiagnose a connected integration during an outage
- Root cause: feedback queue and Google Calendar connected-account read errors were discarded
- Resolution: both pages now preserve read errors, log the boundary, and render refreshable error states before displaying queue or integration status
- Supabase impact: no schema change; feedback and connected-account failures are explicit and non-destructive
- Tests run: `tests/admin-feedback-integrations-read-boundary.test.ts` (2 focused tests), full 425-file/3,096-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contracts verify feedback ideas/comments/notification reads, connected-account reads, and visible retry states
- Commit: `9f4c6fa9`
- Status: Resolved in code; live feedback/integration outage and Super Admin browser evidence remain open
- Remaining dependencies: run isolated feedback and connected-account read-failure drills and verify no empty/configuration status is presented as authoritative

### PLA-0303 - Admin subscriptions hid billing reads as empty plan totals

- Timestamp: 2026-07-15 11:10 America/New_York
- Service: Super Admin subscriptions and billing history
- Route: `/admin/subscriptions`
- Affected files: `app/(app)/admin/subscriptions/page.tsx`, `tests/admin-subscriptions-read-boundary.test.ts`
- Role: Super Admin
- Scenario: subscription, family, or billing-customer reads failed while the page substituted empty arrays and zero-valued plan metrics
- Severity: P1
- Launch impact: operators could misread unavailable subscription state as no customers, no revenue, or no churn
- Root cause: three Supabase read errors were discarded during page loading
- Resolution: the page now preserves read errors, logs the boundary, and renders a refreshable error state before deriving plan metrics
- Supabase impact: no schema change; subscription-read failures are explicit and non-destructive
- Tests run: `tests/admin-subscriptions-read-boundary.test.ts` (1 focused test), full 426-file/3,097-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contract verifies subscription, family, and billing-customer failure paths plus the visible error state
- Commit: `7092ab60`
- Status: Resolved in code; live billing outage and Super Admin browser evidence remain open
- Remaining dependencies: run isolated subscription-read failure drills and verify no zero-valued plan report is presented as authoritative

### PLA-0304 - Admin Stripe hid financial reads as zero or unavailable capabilities

- Timestamp: 2026-07-15 11:22 America/New_York
- Service: Super Admin Stripe financial mode
- Route: `/admin/stripe`
- Affected files: `lib/stripe/capabilities.ts`, `app/(app)/admin/stripe/page.tsx`, `tests/admin-stripe-read-boundary.test.ts`
- Role: Super Admin
- Scenario: feature flags, Stripe settings, connected accounts, financial accounts, cards, authorizations, or webhook events failed to load while the page substituted empty or zero-valued status
- Severity: P1
- Launch impact: operators could misdiagnose financial readiness or miss Stripe operational failures
- Root cause: the admin page discarded Supabase read errors and the capability helper exposed no diagnostic error path
- Resolution: added an error-aware feature-flag helper for diagnostics, preserved consumer ledger fallback, and made the admin page fail visibly on any financial read failure
- Supabase impact: no schema change; financial-read failures are explicit and non-destructive
- Tests run: `tests/admin-stripe-read-boundary.test.ts` (2 focused tests), full 427-file/3,099-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contracts verify error-aware capability reads, Stripe settings, feature flags, financial tables, webhooks, and the visible retry state
- Commit: `748d0a7d`
- Status: Resolved in code; live Stripe credentials, callbacks, permissions, and browser evidence remain open
- Remaining dependencies: run isolated Stripe read-failure and callback drills with production-safe test credentials

### PLA-0305 - Marketing Ads and Automation hid list read failures as empty planning views

- Timestamp: 2026-07-15 11:28 America/New_York
- Service: Admin marketing planning
- Routes: `/admin/marketing/ads`, `/admin/marketing/automation`
- Affected files: `app/(app)/admin/marketing/ads/page.tsx`, `app/(app)/admin/marketing/automation/page.tsx`, `tests/admin-marketing-read-boundary.test.ts`
- Role: Marketing Admin / Super Admin
- Scenario: advertising campaign or automation workflow reads failed while the page substituted an empty list and zero counts
- Severity: P1
- Launch impact: operators could mistake unavailable campaign/workflow state for no planned marketing activity
- Root cause: primary Supabase list errors were discarded by both pages
- Resolution: both pages now preserve read errors, log the boundary, and render refreshable error states before displaying planning data
- Supabase impact: no schema change; marketing-read failures are explicit and non-destructive
- Tests run: `tests/admin-marketing-read-boundary.test.ts` (2 focused tests), full 428-file/3,101-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contracts verify campaign/workflow failure paths and visible retry states
- Commit: `e20a11d4`
- Status: Resolved in code; live marketing permission, write-action, and browser evidence remain open
- Remaining dependencies: audit all remaining marketing list/detail pages and run isolated read/write failure drills

### PLA-0306 - Marketing dashboard and Analytics hid customer-loader failures as zero metrics

- Timestamp: 2026-07-15 11:35 America/New_York
- Service: Admin marketing customer metrics
- Routes: `/admin/marketing`, `/admin/marketing/analytics`
- Affected files: `lib/marketing/customers.ts`, `app/(app)/admin/marketing/page.tsx`, `app/(app)/admin/marketing/analytics/page.tsx`, `tests/admin-marketing-dashboard-read-boundary.test.ts`
- Role: Marketing Admin / Super Admin
- Scenario: family, subscription, family-member, profile, campaign, email, segment, lead, SEO, or AEO reads failed while dashboards substituted empty customer data or zero-valued metrics
- Severity: P1
- Launch impact: operators could make growth, lifecycle, revenue, or email decisions from incomplete marketing data
- Root cause: the shared customer loader and dashboard queries discarded Supabase errors
- Resolution: added an error-aware customer loader for diagnostic pages and visible retry states for dashboard and Analytics reads; existing consumer fallback remains compatible
- Supabase impact: no schema change; marketing metric failures are explicit and non-destructive
- Tests run: `tests/admin-marketing-dashboard-read-boundary.test.ts` (3 focused tests), full 429-file/3,104-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contracts verify all shared customer source reads, dashboard metric reads, analytics campaign/email reads, and visible retry states
- Commit: `e727682c`
- Status: Resolved in code; live marketing permissions, data freshness, and browser evidence remain open
- Remaining dependencies: audit all remaining marketing customer/list/detail pages and run isolated read/failure drills

### PLA-0307 - Marketing admin surfaces silently downgraded read failures

- Timestamp: 2026-07-15 11:55 America/New_York
- Service: Marketing content, campaigns, assets, CRM, publishing, rewards, and surveys
- Routes: `/admin/marketing/content`, `/admin/marketing/campaigns`, `/admin/marketing/assets`, `/admin/marketing/customers`, `/admin/marketing/crm`, `/admin/marketing/video`, `/admin/marketing/loyalty`, `/admin/marketing/surveys`, and related control-plane pages
- Affected files: audited marketing admin page boundaries and six focused `tests/admin-marketing-*-read-boundary.test.ts` suites
- Role: Marketing Admin / Super Admin
- Scenario: list, detail, signed-preview, event aggregate, provider-device, payout, quote, family-label, or survey-response reads failed while the UI substituted empty or zero-valued operational state
- Severity: P1
- Launch impact: operators could publish, pay, score, or make growth decisions from incomplete data without a visible outage signal
- Root cause: many marketing server components discarded Supabase and storage errors while retaining write controls
- Resolution: pages now preserve read errors, log the boundary, and render refreshable error states before deriving metrics or exposing misleading inventory state
- Supabase impact: no schema change; marketing read failures are explicit and non-destructive
- Tests run: six focused files and 18 tests, full 435-file/3,122-test suite, typecheck, lint, dependency audit, diff check, and 250-route production build
- Validation evidence: focused contracts cover content/campaign, asset/messaging, CRM, SEO/AEO/control-plane, experiment/publishing, affiliate/loyalty/proposal/survey failure paths
- Commit: `0a4d4533`
- Status: Resolved in code; live marketing permissions, storage, provider callbacks, write failures, and browser evidence remain open
- Remaining dependencies: complete remaining marketing pages and run isolated read/write/provider/browser drills

### PLA-0308 - Auth and middleware boundaries silently misrouted failures and public callbacks

- Timestamp: 2026-07-15 12:30 America/New_York
- Service: Shared authentication, admin shell, and public/internal API routing
- Routes: `middleware.ts`, `/auth/callback`, `/admin`, `/api/contact`, `/api/blog`, `/api/mkt`, `/api/cron`, `/api/guardian`, `/api/webhooks`, and related endpoints
- Affected files: `lib/supabase/auth.ts`, `app/auth/callback/route.ts`, `app/(app)/admin/layout.tsx`, `components/admin/admin-shell.tsx`, `middleware.ts`, and focused auth/middleware contracts
- Role: signed-out visitor, authenticated member, Super Admin, scheduled job, internal callback, provider webhook
- Scenario: ignored auth/read errors or missing middleware public exceptions could redirect valid public/callback traffic to login, route an authenticated user into onboarding during a membership outage, or render misleading admin defaults
- Severity: P1
- Launch impact: public lead capture, blog engagement, scheduled jobs, provider callbacks, and admin observability could be unavailable or misleading before their route-level authorization checks executed
- Root cause: shared auth and shell queries discarded errors, and the middleware public inventory did not include all intentionally anonymous or machine-authenticated routes
- Resolution: shared auth now logs and fails closed on provider errors, context treats auth reads as unavailable, OAuth callback membership errors redirect to retry, admin shell read failures are visible, and middleware reaches route-level rate-limit/token/secret/signature checks for intended public/internal endpoints
- Supabase impact: no schema change; auth and route-read failures are explicit and non-destructive
- Tests run: `tests/auth-context-error-contract.test.ts`, `tests/auth-callback-boundary.test.ts`, `tests/admin-shell-read-boundary.test.ts`, `tests/middleware-public-api-boundary.test.ts`, `tests/cron-auth.test.ts`; full 439-file/3,141-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: source commit `2a409b13` in merged checkpoint `ed87386f`; build generated 250 routes; live Auth Admin, deployed callback, browser, and provider smoke evidence remain open
- Status: Resolved in code; live deployment and provider evidence remain open
- Remaining dependencies: execute isolated deployed public/callback and authenticated role/device drills

### PLA-0309 - Marketplace overview hid database read failures as an empty board

- Timestamp: 2026-07-15 12:40 America/New_York
- Service: Marketplace discovery overview
- Route: `/marketplace`
- Affected files: `app/(app)/marketplace/page.tsx`, `tests/marketplace-home-read-boundary.test.ts`
- Role: authenticated household member and Super Admin marketplace operator
- Scenario: listing, member, offer, match, save, store, follow, review, order, collection, or collection-item reads failed while the page rendered empty discovery and activity state
- Severity: P1
- Launch impact: users could misread an RLS, migration, or database outage as an empty marketplace and make decisions without complete inventory or transaction context
- Root cause: the page’s best-effort loader discarded query errors and treated all failures as empty arrays
- Resolution: labeled query errors are logged and surfaced in an accessible Marketplace data-health warning; unaffected data remains available
- Supabase impact: no schema change; tenant-scoped reads remain scoped by the active family and failures are non-destructive
- Tests run: `tests/marketplace-home-read-boundary.test.ts`, `tests/marketplace-reports.test.ts`, `tests/marketplace-community.test.ts` (18 focused tests); full 440-file/3,143-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: source commit `b32e7a0f`; build generated 250 routes; live RLS, role, browser, and marketplace workflow evidence remain open
- Status: Resolved in code; live deployment and workflow evidence remain open
- Remaining dependencies: execute isolated listing/order/auction/dispute and cross-family RLS drills across buyer, seller, and manager roles

### PLA-0310 - Marketplace listing detail hid database failures as not-found or incomplete detail

- Timestamp: 2026-07-15 12:46 America/New_York
- Service: Marketplace listing detail and transaction context
- Route: `/marketplace/item/[id]`
- Affected files: `app/(app)/marketplace/item/[id]/page.tsx`, `tests/marketplace-item-read-boundary.test.ts`
- Role: authenticated buyer, seller, and Super Admin marketplace operator
- Scenario: a failed primary listing read rendered `notFound()`, or dependent seller, offer, bid, history, comparable, or negotiation reads failed while the page looked authoritative
- Severity: P1
- Launch impact: users could be told a real listing was missing or act on incomplete trust, pricing, or transaction state
- Root cause: the detail page discarded query errors and treated the primary `maybeSingle()` result as absence without checking its error
- Resolution: primary listing errors now render a retryable ErrorState; all dependent read errors are logged and surfaced in a visible, accessible data-health warning
- Supabase impact: no schema change; the listing and dependent reads remain scoped to the active family and listing permissions
- Tests run: `tests/marketplace-item-read-boundary.test.ts` plus Marketplace home/reports/community suites (20 focused tests); full 441-file/3,145-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: source commit `d6685cd9`; build generated 250 routes; live RLS, role, browser, and marketplace transaction evidence remain open
- Status: Resolved in code; live deployment and workflow evidence remain open
- Remaining dependencies: execute isolated buyer/seller/manager listing, bid, offer, negotiation, and dispute drills against deployed Supabase

### PLA-0317 - Wallet pages hid wallet and ledger read failures as inactive or zero data

- Timestamp: 2026-07-15 13:24 America/New_York
- Service: Wallet Send Money, Activity, and Family Treasury read boundaries
- Route: `/wallet/send`, `/wallet/activity`, `/wallet/treasury`, `/wallet/goals`, `/wallet/allowance`, `/wallet/cards`
- Affected files: `app/(app)/wallet/send/page.tsx`, `app/(app)/wallet/activity/page.tsx`, `app/(app)/wallet/treasury/page.tsx`, `app/(app)/wallet/goals/page.tsx`, `app/(app)/wallet/allowance/page.tsx`, `app/(app)/wallet/cards/page.tsx`, `tests/wallet-read-boundary.test.ts`
- Role: household manager, parent, and member with wallet visibility
- Scenario: failed wallet or dependent ledger/card/connected-account reads rendered activation prompts, zero balances, incomplete history, fallback identity data, or incomplete card controls
- Severity: P0
- Launch impact: users could make financial decisions from incomplete data or be offered an unsafe activation path during an outage
- Root cause: Supabase result errors were discarded by all three server-rendered wallet pages
- Resolution: primary wallet failure now renders a retryable ErrorState; dependent failures are logged and shown in accessible page-specific data-health warnings across six wallet pages
- Supabase impact: no schema change; all reads remain family scoped and preserve existing wallet permissions
- Tests run: `tests/wallet-read-boundary.test.ts` (2 focused tests); full 448-file/3,159-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: source commit `d3147d0e`; build generated 250 routes; branch and `main` publication verified; live wallet/RLS, role, concurrency, and payment workflow evidence remain open
- Status: Resolved in code; live workflow evidence remains open
- Remaining dependencies: execute isolated wallet activation, balance, send, ledger, goal, rule, concurrency, and tenant-isolation drills against deployed Supabase
- Publication correction: source commit `b8e085d0` is verified on both the audit branch and `main`.

### PLA-0316 - Marketplace Collections hid collection and item failures

- Timestamp: 2026-07-15 13:16 America/New_York
- Service: Marketplace collections and curated listing detail
- Route: `/marketplace/collections`
- Affected files: `app/(app)/marketplace/collections/page.tsx`, `tests/marketplace-collections-read-boundary.test.ts`
- Role: authenticated household member and Super Admin marketplace operator
- Scenario: collection, item, or collection-listing reads failed while the page displayed an empty or incomplete collection view
- Severity: P1
- Launch impact: users could lose curated context or act on incomplete collection detail
- Root cause: Supabase read errors were discarded and failed reads became empty arrays
- Resolution: collection failure now renders a retryable ErrorState; item and listing failures are logged and shown in accessible warnings in both directory and detail views
- Supabase impact: no schema change; reads remain scoped to the active family and listing permissions
- Tests run: `tests/marketplace-collections-read-boundary.test.ts` (2 focused tests); full 447-file/3,157-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: source commit `2f844cc3`; build generated 250 routes; branch and `main` publication verified; live collection/RLS, role, browser, and family-isolation evidence remain open
- Status: Resolved in code; live workflow evidence remains open
- Remaining dependencies: execute isolated collection CRUD, item membership, listing visibility, and family-isolation drills against deployed Supabase

### PLA-0315 - Marketplace Following hid feed and saved-state failures

- Timestamp: 2026-07-15 13:16 America/New_York
- Service: Marketplace followed-creator feed and saved-listing state
- Route: `/marketplace/following`
- Affected files: `app/(app)/marketplace/following/page.tsx`, `tests/marketplace-following-read-boundary.test.ts`
- Role: authenticated household member and Super Admin marketplace operator
- Scenario: follow, save, store, or listing reads failed while the page displayed an empty or incomplete followed feed
- Severity: P1
- Launch impact: users could miss creator updates or trust a false empty feed
- Root cause: independent Supabase errors were discarded and failures became empty arrays
- Resolution: follow failure now renders a retryable ErrorState; save, store, and listing failures are logged and shown in an accessible warning
- Supabase impact: no schema change; feed and saved reads remain family/member scoped
- Tests run: `tests/marketplace-following-read-boundary.test.ts` (2 focused tests); full 447-file/3,157-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: source commit `2f844cc3`; build generated 250 routes; branch and `main` publication verified; live following/RLS, role, browser, and family-isolation evidence remain open
- Status: Resolved in code; live workflow evidence remains open
- Remaining dependencies: execute isolated follow/unfollow, feed refresh, save-state, and family-isolation drills against deployed Supabase

### PLA-0314 - Marketplace Creators hid storefront and trust-data failures

- Timestamp: 2026-07-15 13:08 America/New_York
- Service: Marketplace storefront directory and creator trust context
- Route: `/marketplace/creators`
- Affected files: `app/(app)/marketplace/creators/page.tsx`, `tests/marketplace-creators-read-boundary.test.ts`
- Role: authenticated household member and Super Admin marketplace operator
- Scenario: storefront, follow, review, or open-listing reads failed while the page displayed an empty or incomplete creator ranking
- Severity: P1
- Launch impact: users could miss sellers or act on incomplete ratings and inventory context
- Root cause: Promise.all result errors were discarded and failed reads became empty ranking inputs
- Resolution: storefront failure now renders a retryable ErrorState; dependent failures are logged and shown in an accessible data-health warning
- Supabase impact: no schema change; storefront and trust reads remain scoped to the active family and existing permissions
- Tests run: `tests/marketplace-creators-read-boundary.test.ts` (2 focused tests); full suite/build pending
- Validation evidence: source commit `dcbe9588`; full branch verification remains green; live creator/RLS, role, browser, and family-isolation evidence remain open
- Status: Resolved in code; full verification and live workflow evidence remain open
- Remaining dependencies: execute isolated storefront, follow, review, inventory, and family-isolation drills against deployed Supabase

### PLA-0313 - Marketplace Alerts hid saved-search and matching-data failures

- Timestamp: 2026-07-15 13:04 America/New_York
- Service: Marketplace saved-search alerts and match discovery
- Route: `/marketplace/alerts`
- Affected files: `app/(app)/marketplace/alerts/page.tsx`, `tests/marketplace-alerts-read-boundary.test.ts`
- Role: authenticated household member and Super Admin marketplace operator
- Scenario: saved-search, matching-listing, or saved-state reads failed while the page displayed an empty or incomplete alert view
- Severity: P1
- Launch impact: users could miss relevant new listings or trust inaccurate match counts
- Root cause: Promise.all result errors were discarded and failed reads became empty arrays
- Resolution: primary saved-search failure now renders a retryable ErrorState; matching-listing and saved-state failures are logged and shown in an accessible data-health warning
- Supabase impact: no schema change; alert and listing reads remain scoped to the active family/member permissions
- Tests run: `tests/marketplace-alerts-read-boundary.test.ts` (2 focused tests); full 444-file/3,151-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: source commit `4f06b696`; build generated 250 routes; branch and `main` publication verified; live alert/RLS, role, browser, and cross-family evidence remain open
- Status: Resolved in code; full verification and live workflow evidence remain open
- Remaining dependencies: execute isolated alert CRUD, match-count, save-state, and family-isolation drills against deployed Supabase

### PLA-0312 - Marketplace Orders hid transaction and fee-read failures as incomplete data

- Timestamp: 2026-07-15 12:58 America/New_York
- Service: Marketplace orders and exchange coordination
- Route: `/marketplace/orders`
- Affected files: `app/(app)/marketplace/orders/page.tsx`, `tests/marketplace-orders-read-boundary.test.ts`
- Role: authenticated buyer, seller, and Super Admin marketplace operator
- Scenario: primary order, service-fee, listing-title, member, review-history, or handoff reads failed while the page looked healthy or incomplete
- Severity: P1
- Launch impact: users could miss transactions, misunderstand fees, misidentify counterparties, or lose handoff context
- Root cause: Supabase result errors were discarded and an unavailable fee configuration silently fell back to zero
- Resolution: primary order failures now render a retryable ErrorState; dependent failures are logged and surfaced in a visible accessible Marketplace orders data-health warning
- Supabase impact: no schema change; order and related reads remain scoped to the active family and existing permissions
- Tests run: `tests/marketplace-orders-read-boundary.test.ts` (2 focused tests); full 443-file/3,149-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: source commit `f1e2ef12`; build generated 250 routes; live order/RLS, role, browser, and fee workflow evidence remain open
- Status: Resolved in code and published to branch and `main`; live workflow evidence remains open
- Remaining dependencies: execute isolated buyer/seller order, fee, review, handoff, return, and dispute drills against deployed Supabase

### PLA-0311 - Community Circles mislabeled transient failures as an unapplied migration

- Timestamp: 2026-07-15 12:52 America/New_York
- Service: Marketplace Community Circles and cross-family listing sharing
- Route: `/marketplace/community`
- Affected files: `app/(app)/marketplace/community/page.tsx`, `components/marketplace/community-module.tsx`, `tests/marketplace-community-read-boundary.test.ts`
- Role: authenticated household member and Super Admin marketplace operator
- Scenario: a transient circle/member/share query failure showed the migration-not-applied message, while own available-listing failures silently emptied the share picker
- Severity: P1
- Launch impact: users could misdiagnose a live outage as missing deployment work or lose the ability to share listings across families without an honest error state
- Root cause: broad catch-based migration detection and discarded per-query Supabase errors
- Resolution: only missing-relation errors trigger the migration state; other failures are logged, labeled, and rendered in an accessible Community data-health warning
- Supabase impact: no schema change; cross-family reads and own-family listing reads retain existing RLS/scoping behavior
- Tests run: `tests/marketplace-community-read-boundary.test.ts` and `tests/marketplace-community.test.ts` (7 focused tests); full 442-file/3,147-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: source commit `57e973d3`; build generated 250 routes; live cross-family RLS, role, browser, and invite/share workflow evidence remain open
- Status: Resolved in code; live deployment and workflow evidence remain open
- Remaining dependencies: run isolated circle create/join/leave/share/unshare drills across multiple families with live migration 0173/0176 policies
### PLA-0318 - Billing mutations ignored required Supabase state failures

- Timestamp: 2026-07-15 13:42 America/New_York
- Service: Authenticated Stripe billing and portal operations
- Routes: `/api/billing/checkout`, `/api/billing/change-plan`, `/api/billing/cancel`, `/api/billing/portal`
- Affected files: `app/api/billing/checkout/route.ts`, `app/api/billing/change-plan/route.ts`, `app/api/billing/cancel/route.ts`, `app/api/billing/portal/route.ts`, `tests/billing-read-boundary.test.ts`
- Role: authenticated family manager or billing administrator
- Scenario: required billing customer or subscription reads failed while the route could continue as though billing state were absent; secondary customer, tracking, and optimistic-sync write failures were not surfaced consistently
- Severity: P0
- Launch impact: billing state could diverge from Stripe or return an unsafe success response during a Supabase outage
- Root cause: Supabase result errors were discarded around precondition reads and secondary billing persistence writes
- Resolution: required reads now fail closed before Stripe mutation or portal creation; customer write failures return 503; checkout tracking and optimistic subscription-sync failures are logged explicitly
- Supabase impact: no schema change; existing billing and checkout tables remain the source of truth
- Tests run: `tests/billing-read-boundary.test.ts` (2 focused tests); full 449-file/3,161-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: focused read-boundary contracts and full local gate pass; live Stripe test-mode, webhook/idempotency, outage, refund, and remote Supabase evidence remain open
- Status: Resolved in code; live billing workflow evidence remains open
- Remaining dependencies: execute non-destructive checkout, plan-change, cancellation, portal, webhook replay, and refund drills against the configured test environment

### PLA-0319 - Contact Center collapsed routing and inbox failures into empty state

- Timestamp: 2026-07-15 13:54 America/New_York
- Service: Family Contact Center and unified communications inbox
- Routes: `/dashboard/contact-center`, `/api/contact-center/sms`, `/api/contact-center/voice`, `/api/contact-center/voice/transcription`, `/api/contact-center/email`
- Affected files: `lib/contact-center/server.ts`, `app/(app)/dashboard/contact-center/page.tsx`, `app/(app)/dashboard/contact-center/actions.ts`, the four Contact Center API routes, `tests/contact-center.test.ts`
- Role: Family+ parent, family member, and inbound communications provider
- Scenario: channel, family, routing, or inbox persistence failures were discarded and the UI/provider flow could continue with null, empty, or unpersisted state; the newly added email webhook also accepted unbounded form payloads and hid reply failures
- Severity: P1
- Launch impact: families could miss messages or receive a false healthy callback response while the inbox was unavailable
- Root cause: unchecked Supabase results in channel helpers, page loads, routing lookups, provisioning, and inbox writes; email parsing was not bounded and reply failures were hidden
- Resolution: channel and page reads now show retryable failure state; SMS, voice, voicemail, and email callbacks return 503 on routing/context read failure; email form parsing is bounded; provisioning and inbox writes are checked; escalation failures are logged; focused tests cover the boundaries
- Supabase impact: no schema change; family-scoped reads remain in the migration and service-role writes remain server-only
- Tests run: `tests/contact-center.test.ts` (15 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation passes; final merged-tree gate passed with 450 files/3,176 tests, 0 production dependency vulnerabilities, and 250 generated routes
- Status: Resolved in code; live provider/RLS evidence remains open
- Remaining dependencies: run Twilio/email retry, provider outage, role, RLS, and browser drills
### PLA-0320 - Remaining wallet routes hid financial read failures

- Timestamp: 2026-07-15 14:08 America/New_York
- Service: Wallet Hub and secondary family-wallet workflows
- Routes: `/wallet`, `/wallet/invest`, `/wallet/babysitters`, `/wallet/gift`, `/wallet/settings`, `/wallet/children/[childId]`
- Affected files: `components/wallet/wallet-hub.tsx`, the five remaining server-rendered wallet pages, `tests/wallet-read-boundary.test.ts`
- Role: household manager, parent, or family member with wallet visibility
- Scenario: failed financial reads became empty arrays, fallback names, or zero-valued derived state while the screen looked healthy
- Severity: P0
- Launch impact: users could act on incomplete balances, holdings, pending orders, gift payments, babysitter history, or child-wallet details
- Root cause: Supabase errors were discarded by the remaining wallet pages and `useRealtimeQuery` consumers did not render error state
- Resolution: primary reads now render retryable ErrorState; secondary failures render accessible health warnings; the Wallet Hub preserves partial/cached data only with an explicit warning
- Supabase impact: no schema change; family filters and existing RLS scopes remain unchanged
- Tests run: `tests/wallet-read-boundary.test.ts` (3 focused tests); full 450-file/3,177-test suite; typecheck; lint; dependency audit; production build; diff check
- Validation evidence: final local gate passed with 0 production dependency vulnerabilities and 250 generated routes
- Status: Resolved in code; live wallet/RLS, role, concurrency, and browser evidence remain open
- Remaining dependencies: execute manager/member wallet, invest, gift, babysitter, child-wallet, reconciliation, and tenant-isolation drills against deployed Supabase
### PLA-0321 - Stripe subscription webhook ignored prior billing state failures

- Timestamp: 2026-07-15 14:11 America/New_York
- Service: Stripe subscription webhook synchronization and growth alerts
- Route: `/api/webhooks/stripe`
- Affected files: `app/api/webhooks/stripe/route.ts`, `tests/webhook-persistence-boundaries.test.ts`
- Role: paying family and Super Admin operator
- Scenario: billing-customer and prior-subscription reads ran together, but only the billing-customer error was checked before subscription persistence and conversion/churn comparison
- Severity: P0
- Launch impact: Stripe events could write subscription state with an untrusted transition baseline or fail to trigger accurate growth alerts
- Root cause: `priorSubscriptionError` was discarded; payment automation failures were silently swallowed
- Resolution: both required state reads now fail closed through the reprocessable webhook error path; payment automation failures are logged
- Supabase impact: no schema change; existing event claim/finalization and family-scoped subscription persistence remain in place
- Tests run: `tests/webhook-persistence-boundaries.test.ts`, `tests/stripe-growth-alerts-contract.test.ts`, and `tests/stripe-webhook-replay-contract.test.ts` (11 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation passes; full gate and live Stripe evidence remain open
- Status: Resolved in code; live replay/idempotency and provider evidence remain open
- Remaining dependencies: execute non-destructive subscription lifecycle, replay, retry, and growth-alert drills in Stripe test mode
### PLA-0322 - Allowance cron skipped credits when subscription gating read failed

- Timestamp: 2026-07-15 14:14 America/New_York
- Service: Scheduled wallet allowance automation
- Route: `/api/cron/wallet-allowance`
- Affected files: `app/api/cron/wallet-allowance/route.ts`, `tests/cron-wallet-allowance-persistence.test.ts`
- Role: family manager, parent, child recipient, and scheduled cron worker
- Scenario: a failed subscriptions read produced an empty plan map, so paid-family eligibility could be treated as Free and credits skipped
- Severity: P0
- Launch impact: scheduled allowances could disappear without a retryable failure signal
- Root cause: the subscription plan-gating error was discarded
- Resolution: subscription read errors now fail the cron through its 500 error path; schedule claim and credit rollback remain checked
- Supabase impact: no schema change; allowance and subscription family scopes remain unchanged
- Tests run: `tests/cron-wallet-allowance-persistence.test.ts`, `tests/cron-auth.test.ts` (9 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation passes; full gate and live cron/RLS evidence remain open
- Status: Resolved in code; live scheduled execution remains open
- Remaining dependencies: execute isolated outage, duplicate-run, and ledger/RLS drills
### PLA-0323 - Digest crons hid family and delivery failures as zero sends

- Timestamp: 2026-07-15 14:18 America/New_York
- Service: Chore reminder and weekly digest scheduled email workflows
- Routes: `/api/cron/chore-reminders`, `/api/cron/weekly-digest`
- Affected files: `app/api/cron/chore-reminders/route.ts`, `app/api/cron/weekly-digest/route.ts`, `tests/digest-cron-read-boundary.test.ts`
- Role: family member, family admin, and scheduled cron worker
- Scenario: family/Auth Admin/feature reads failed but the cron assembled empty data or recipients; failed email delivery did not change the response status
- Severity: P1
- Launch impact: reminders and digests could be missed while operations saw an apparently successful zero-send run
- Root cause: Supabase result errors were discarded and email send failures were not counted
- Resolution: required reads now fail with 500, per-family read failures are counted, and partial email delivery returns 502 with sent/failed counts
- Supabase impact: no schema change; existing family-scoped queries remain unchanged
- Tests run: `tests/digest-cron-read-boundary.test.ts`, `tests/cron-auth.test.ts` (6 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation passes; full gate and live scheduler/Resend evidence remain open
- Status: Resolved in code; live delivery evidence remains open
- Remaining dependencies: execute scheduler, provider outage/retry, recipient, and duplicate-run drills
### PLA-0329 - Wallet hub deletion relied on dynamic ID-only targeting

- Timestamp: 2026-07-15 15:00 America/New_York
- Service: Wallet hub destructive actions
- Route: `deleteWalletRowAction`
- Affected files: `app/(app)/wallet/hub-actions.ts`, `tests/wallet-money-action-boundaries.test.ts`
- Role: family manager or authenticated household member invoking wallet deletion
- Scenario: a dynamic table name and ID-only delete relied on RLS instead of explicitly constraining the active family
- Severity: P0
- Launch impact: policy drift could permit cross-family deletion of wallet data
- Root cause: the action used `from(input.table)` and omitted `family_id` from the delete predicate
- Resolution: explicit supported-table branches now include `family_id = ctx.active.familyId`; RLS remains defense in depth
- Supabase impact: no schema change; strengthens existing family-scoped wallet tables and RLS policies
- Tests run: `tests/wallet-money-action-boundaries.test.ts`, `tests/tenant-isolation-rls.test.ts`, `tests/role-surface.test.ts`, `tests/role-density.test.ts` (22 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation and full local gate pass; live cross-family/RLS/concurrency evidence remains open
- Status: Resolved in code; live wallet authorization evidence remains open
- Remaining dependencies: execute authenticated two-family wallet deletion and role/concurrency drills

### PLA-0328 - Onboarding provisioning acknowledged incomplete state writes

- Timestamp: 2026-07-15 15:00 America/New_York
- Service: Profile onboarding and compatibility first-family provisioning
- Route: `completeProfileOnboardingAction`, `ensureActiveFamily`, and protected-page onboarding fallback
- Affected files: `app/onboarding/actions.ts`, `lib/server/ensure-family.ts`, `tests/onboarding-failure-safety.test.ts`
- Role: new account owner, existing multi-family user, family manager, and first-login provisioning worker
- Scenario: membership/preference reads or subscription/active-family writes failed while onboarding returned success, or a color update touched every family membership
- Severity: P0
- Launch impact: onboarding could complete without valid tenant/subscription state or mutate another family’s UI data
- Root cause: secondary Supabase result errors were ignored and the member color update lacked a family scope
- Resolution: required reads and writes now fail closed, compatibility provisioning reports false on subscription/active-family failures, and color updates target the resolved family only
- Supabase impact: no schema change; protects existing family_members/user_preferences/subscriptions/families boundaries
- Tests run: `tests/onboarding-failure-safety.test.ts`, `tests/onboarding-idempotency.test.ts`, `tests/ensure-family-concurrency.test.ts`, `tests/auth-context-integrity.test.ts` (11 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation and full local gate pass; live onboarding, tier, invite, and cross-tenant RLS evidence remains open
- Status: Resolved in code; live onboarding/deployment evidence remains open
- Remaining dependencies: apply and verify migrations 0210/0212, then execute first-login, invite, tier, and two-tenant drills

### PLA-0327 - Incomplete family context could be misclassified as onboarding

- Timestamp: 2026-07-15 14:50 America/New_York
- Service: Authenticated user context, tenant membership resolution, and first-family provisioning
- Route: `lib/supabase/auth.ts`, protected app pages, and onboarding fallback
- Affected files: `lib/supabase/auth.ts`, `tests/auth-context-integrity.test.ts`
- Role: authenticated user with memberships, family manager, and first-login provisioning worker
- Scenario: an active membership could not be joined to its family row, but context resolution returned the onboarding state
- Severity: P0
- Launch impact: a partial tenant-context read could create a second family or misroute the user instead of failing safely
- Root cause: missing family joins were silently filtered before the `needsFamily` branch
- Resolution: incomplete family joins and membership mappings now return a retryable context-unavailable failure
- Supabase impact: no schema change; protects existing family_members/families/user_preferences reads and provisioning calls
- Tests run: `tests/auth-context-integrity.test.ts`, `tests/admin-auth-boundary.test.ts`, `tests/tenant-isolation-rls.test.ts`, `tests/ensure-family-concurrency.test.ts` (8 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation and full local gate pass; live Auth Admin/RLS/role/browser evidence remains open
- Status: Resolved in code; live tenant-isolation evidence remains open
- Remaining dependencies: apply 0211/0212 and execute authenticated two-tenant and first-login drills

### PLA-0326 - Scheduled integrations acknowledged secondary persistence failures

- Timestamp: 2026-07-15 14:42 America/New_York
- Service: Guardian Learning, Network Aggregation, auctions, provider sync, and calendar feed sync
- Route: `/api/cron/guardian-learning`, `/api/cron/network-aggregate`, `/api/cron/close-auctions`, `/api/cron/provider-sync`, `/api/cron/calendar-feeds`
- Affected files: `app/api/cron/guardian-learning/route.ts`, `app/api/cron/network-aggregate/route.ts`, `lib/network/aggregate-server.ts`, `app/api/cron/close-auctions/route.ts`, `app/api/cron/provider-sync/route.ts`, `lib/server/calendar-feeds.ts`, `tests/cron-recovery-boundaries.test.ts`
- Role: family member, network-consenting household, auction participant, connected-provider user, calendar subscriber, and scheduled cron worker
- Scenario: secondary reads or writes failed after primary batch reads while the job returned success or published incomplete state
- Severity: P1
- Launch impact: learning, aggregate privacy, auction notifications, sync observability, or calendar state could be incomplete without a retry signal
- Root cause: Supabase result errors were discarded in cleanup, source queries, contribution pruning, notifications, audit logs, event upserts, and feed status writes
- Resolution: required reads and writes are checked; cron errors are sanitized and return 502 on incomplete scheduled work; feed sync fails when event or status persistence fails
- Supabase impact: no schema change; existing consent, aggregate, marketplace, sync, and calendar scopes remain unchanged
- Tests run: `tests/cron-recovery-boundaries.test.ts`, `tests/cron-batch-failure-status.test.ts`, `tests/cron-provider-sync.test.ts`, `tests/cron-auth.test.ts`, `tests/marketplace-auction-security.test.ts` (17 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation and full local gate pass; live scheduler/provider/privacy/RLS evidence remains open
- Status: Resolved in code; live scheduled integration evidence remains open
- Remaining dependencies: execute scheduler, provider outage/retry, duplicate-run, consent/privacy, and live Supabase drills

### PLA-0325 - Return and model refresh crons acknowledged persistence failures

- Timestamp: 2026-07-15 14:35 America/New_York
- Service: Marketplace return reminders and household model refresh
- Route: `/api/cron/return-reminders`, `/api/cron/model-refresh`
- Affected files: `app/api/cron/return-reminders/route.ts`, `app/api/cron/model-refresh/route.ts`, `tests/cron-return-reminders-boundary.test.ts`
- Role: family members waiting on returns, household members relying on model projections, and scheduled cron workers
- Scenario: secondary listing, notification, order-stamp, dirty-state, or dirty-flag failures were ignored after primary reads succeeded
- Severity: P1
- Launch impact: reminders could repeat or disappear, and model refresh could report success while stale work remained queued
- Root cause: Supabase result errors from secondary reads and writes were discarded
- Resolution: required reads and writes are checked; failed reminder items and dirty-state persistence now produce retryable non-success responses
- Supabase impact: no schema change; existing marketplace and model-dirty scopes remain unchanged
- Tests run: `tests/cron-return-reminders-boundary.test.ts`, `tests/cron-batch-failure-status.test.ts`, `tests/cron-auth.test.ts` (10 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation and full local gate pass; live scheduler/provider/RLS evidence remains open
- Status: Resolved in code; live scheduled delivery evidence remains open
- Remaining dependencies: execute scheduler, duplicate-run, provider outage/retry, and live Supabase drills

### PLA-0324 - Journey Recovery acknowledged failed abandonment sweeps

- Timestamp: 2026-07-15 14:30 America/New_York
- Service: Abandoned onboarding and demo-lead recovery cron
- Route: `/api/cron/journey-recovery`
- Affected files: `app/api/cron/journey-recovery/route.ts`, `tests/journey-recovery-cron-boundary.test.ts`
- Role: abandoned user, demo lead, marketing operator, and scheduled cron worker
- Scenario: onboarding, CRM, profile, or automation failures were logged but the endpoint still returned success with partial counts
- Severity: P1
- Launch impact: follow-up workflows could be silently skipped without an operational retry signal
- Root cause: sweep/profile/automation failures were not counted in the response status
- Resolution: required reads now fail the sweep, per-record failures increment `failed`, and the endpoint returns 502 when any work fails
- Supabase impact: no schema change; existing onboarding/profile/CRM scopes remain unchanged
- Tests run: `tests/journey-recovery-cron-boundary.test.ts`, `tests/cron-auth.test.ts` (6 focused tests); typecheck; lint; diff check
- Validation evidence: focused validation and the full local gate pass; live scheduler/provider evidence remains open
- Status: Resolved in code; live automation evidence remains open
- Remaining dependencies: execute scheduler, provider outage/retry, duplicate-run, and recipient drills
