# Social scheduling continuation discovery

Inspected production checkpoint: `3effbf41d433c332fe3abb79f88ffe45733941cf`. This is a read-only next-cycle investigation, separate from the root's release gates. Only this note and `tests/social-scheduling-discovery.test.ts` were added. No production source, SQL, deployment configuration, dependencies or provider accounts were changed. No new permanent finding IDs or audit statuses were assigned.

Historical note: this describes the earlier checkpoint, before the authorized SOCIAL-003 implementation. Its four passing **broken-behavior characterizations** in `tests/social-scheduling-discovery.test.ts` were subsequently retired and replaced by `tests/social-scheduled-publish.test.ts`, containing58 actual scheduling execution regressions. The old characterization filename is intentionally absent from the final source. Current implementation, validation and remaining limits are in `social-scheduling-cycle.md`; this discovery's old source hashes and observed failures remain historical evidence.

## Result

The current repository saves and displays a schedule but has no executable continuation that reads due social schedules and submits them to a provider. This is a repository-side missing implementation, not merely an unconfigured external scheduler. A working GitHub/Vercel cron deployment would still not dispatch these rows. Existing SOCIAL-001/SOCIAL-002 notes already leave scheduling dispatch open; this investigation supplies exact code and execution evidence.

## Actual chain and permanent inventory

| Stage | Authoritative source | Existing permanent ID |
| --- | --- | --- |
| New studio loads account choices only; no workspace timezone is supplied | `app/(app)/dashboard/social/content-studio/new/page.tsx:14` | UI-ROUTE-0244 |
| Form sends raw `datetime-local` string; schedule success displays “Scheduled” | `components/social/studio-form.tsx:87`, `:100`, `:214`, `:329` | COMPONENT-71B08AF10F6E |
| Schedule intent checks `schedule_posts`, parses the string on the server and persists the post, variants, targets, schedule and calendar | `app/(app)/dashboard/social/actions.ts:120`, `:125`, `:139`, `:156`, `:192`, `:195` | ACTION-3C9C7E7C3208 |
| Parent/variant/target rows | Migration `0034_social_command_center.sql:195`, `:220`, `:239` | DB-TBL-365 / DB-TBL-364 / DB-TBL-363 |
| Due schedule storage | Migration `0034_social_command_center.sql:308` | DB-TBL-372 |
| Calendar storage/read display | Migration `0034_social_command_center.sql:486`; `lib/social/queries.ts:107`; `app/(app)/dashboard/social/calendar/page.tsx:16` | DB-TBL-355; LIBRARY-508565E09C71; UI-ROUTE-0243 |
| Scheduled list reads parent status only | `app/(app)/dashboard/social/scheduled/page.tsx:10`; `lib/social/queries.ts:63` | UI-ROUTE-0254; LIBRARY-508565E09C71 |
| Due-time continuation | No consumer of `social_schedules` exists in application/library/scripts/cron source | No existing scheduler route or job ID to map |
| Actual generic automation cron handles marketing workflows | `app/api/cron/automations/route.ts:12`; `lib/marketing/automation-runner.ts:51` | API-8CC89F0675A6 / JOB-71988A171BC7; LIBRARY-1163B642EDF5 |
| Deployed cadence declarations contain no social worker | `scripts/cron-dispatch.mjs:24`; `.github/workflows/cron-dispatch.yml:23`; `vercel.json` | DEPLOY-1ED5966CA454; DEPLOY-8122E8487BD8; SUPPORT-A3265310F552 |
| Only manual create-publish/retry calls enter publish pipeline | `app/(app)/dashboard/social/actions.ts:217`, `:237`, `:247`; `lib/social/publish.ts:163` | ACTION-3C9C7E7C3208; ACTION-FD08580CBD41; LIBRARY-F1EE974340EE |
| Pipeline creates a running job at current time, then provider receipts | `lib/social/publish.ts:229`, `:261`, `:273` | DB-TBL-368 / DB-TBL-369; LIBRARY-F1EE974340EE |
| X provider requires an authenticated request-bound actor | `lib/social/providers/x.ts:12`, `:24`; `lib/social/account-tokens.ts:27`, `:145` | LIBRARY-FF3F39A469CA; LIBRARY-90A14267D9AB |

`social_schedules` has a UUID primary key, post/family references, `scheduled_for`, timezone default UTC, recurrence default none, free-text status default scheduled, creator/updater fields and JSON metadata. It has a nonunique family/time index; there is no unique post/schedule key. `social_publish_jobs` has UUID identity, queued/running/succeeded/failed/dead_letter/canceled status, attempts/max_attempts/next_attempt_at/idempotency_key and metadata, but neither the SQL nor application currently makes `idempotency_key` unique. The only job insert is inside immediate publishing and sets running/attempts=1/current time. No queued-job drain uses those retry columns.

Searches covered all application/library/script/workflow source and all migrations for schedule, job and publish references. Migration 0034 adds audit/updated-at triggers and RLS, not a `pg_cron`/network publish trigger. There is no checked-in `supabase/functions` directory. The similarly named admin `marketing_social_posts` table and marketing/provider-sync cron paths are separate systems and do not consume household `social_schedules`.

## Controlled execution findings

`tests/social-scheduling-discovery.test.ts` executes the real create/retry actions, real publish pipeline, real `/api/cron/automations` handler, real marketing automation runner and real cron schedule matcher. The existing `InMemorySupabase` applies persisted rows/defaults/filters; authentication, permission responses and final provider confirmation are controlled fixtures. There is no live provider or database traffic.

Four passing characterization cases demonstrate current defects; **they are not a scheduled-workflow PASS**:

1. At noon, scheduling for 13:00 returns `ok:true/action:schedule` and stores a scheduled parent, pending target, schedule and calendar row. At 13:01 the actual registered automation endpoint returns 200/zero marketing workflows and reads only `marketing_automation_workflows`. The social post stays scheduled, no publish job is created and no provider is called. Both executable dispatcher and Vercel tables lack a social route. The broad source trace, rather than this one cron invocation alone, establishes the missing consumer.
2. Calling the existing retry action at noon publishes that future 13:00 post immediately through the actual pipeline and a confirming provider fixture. The parent becomes published, but the schedule and calendar remain scheduled. The detail page exposes the same retry control for scheduled posts (`posts/[id]/page.tsx:29`, `:73`); there is no due-time check in immediate publishing. An intentional publish-now action can be supported, but it must be clear to the user and retire/reconcile schedule state.
3. The studio's offset-free `2026-09-13T09:00` is parsed as 09:00Z in an explicitly UTC server environment. Stored workspace timezone `America/New_York` is never read; the schedule retains its default UTC timezone. If the user means New York 09:00, the intended instant is 13:00Z. The defect depends on the user's intended timezone differing from the server; this run does not claim to establish the actual production runtime timezone. Calendar server rendering also uses the process-local timezone.
4. A timestamp already one day in the past gets the same successful scheduled result and no dispatch. Neither the form nor action defines rejection/immediate-send behavior for it.

The suite passed **4 cases in 397 ms** with `node node_modules/vitest/vitest.mjs run tests/social-scheduling-discovery.test.ts --maxWorkers=1`; scoped ESLint passed. An initial command included an unsupported `--minWorkers` option and was corrected before execution. The timezone fixture restores its environment after each case. No full suite, typecheck, build or browser suite was run in this lane.

## Smallest robust implementation boundary before enabling dispatch

1. Define the schedule time explicitly in the UI/server contract: an absolute ISO instant plus validated IANA timezone, with the chosen zone visible. Do not infer a different server clock from a bare local string. Decide past-time behavior. Recurrence is currently only an unused database column; a bounded first cycle should support one occurrence and make that scope explicit.
2. Introduce one bounded, secret-authenticated due-worker route and register its actual cadence in the existing dispatcher and daily-safe Vercel configuration. Read ordered due rows with keyset pagination and a fixed budget, validating post/family/time/status/creator and handling duplicate schedule rows. Reuse the existing exclusive post/target claims and uncertain-outcome behavior. Do not stale-reclaim a publishing target or turn an ambiguous accepted request into an automatic resend. Use durable confirmed failure/backoff limits and observed receipts to reconcile schedule/calendar outcomes.
3. A service client passed to `runPublishNow` is insufficient: X token loading calls `requireUserContext` and cookie-bound `requireSocialPermission`. Add a narrowly scoped, server-only background actor resolver that rechecks the persisted initiator's active family membership and current social permission before token use; preserve the existing direct-request guard. Deletion/disconnection/role changes, missing required reads and expired credentials must stop provider dispatch. The current token loader does not refresh expired tokens, so automatic refresh or a visible reconnect-required outcome is a distinct requirement.
4. Do not trust mutable public `created_by`/schedule rows as proof of server-authorized scheduled intent. Migration 0034 permits household row writes through RLS, and AUTHZ-003 remains an explicit live restricted-role release blocker. An existing-schema option is a bounded authenticated/encrypted scheduling intent in schedule metadata, binding actor, family, post, schedule identity/time and intended targets. Verify it before service execution; raw-client edits cannot forge authority. This needs focused tampering, permission-revocation and creator-mismatch tests. The final storage choice belongs to the implementation review; no new SQL is proposed here.
5. Before automatic publishing, review the existing approval control: settings persist `require_approval` and posts have approval state, but searches find no scheduling/publish read of either setting or approval status. `social_settings` is DB-TBL-373; the setting is rendered at `settings/page.tsx:80` and saved at `actions.ts:312`. Do not invent a replacement policy or quietly ignore the existing one when adding background execution.

The new-post studio offers schedule at initial creation. Already-saved drafts lead to detail/retry; there is no existing edit/reschedule/cancel action for a stored draft/schedule. That product continuation and automatic recurrence should remain explicit separate scope rather than being implied by a new cron route.

Focused implementation tests should cover due versus future, non-UTC input/DST ambiguity, duplicate rows/concurrent ticks, manual publish versus due tick, creator removal/permission changes, unreadable required settings/approval/account data, token expiry/disconnect, forged intent, confirmed failure/backoff, ambiguous provider acceptance, receipt-write failure and calendar reconciliation. A real deployed cron/provider journey remains an external verification obligation after authorized configuration; these local fixtures do not satisfy it.

## Source snapshot hashes

SHA-256 at inspection (production source unchanged in this lane):

```text
components/social/studio-form.tsx ab0fb7347a6577e59a889e4c7911ded45d2fe47a4db9f545c5ced85225ea7b49
app/(app)/dashboard/social/actions.ts 59b8253498f5cc60f24e3703d0671cf86bbefc043e87b3a0da62e1cacb5fe749
lib/social/publish.ts 7d2b28601e2b545ea1e480ce19b55cedfeca960c4177988fbcd3bd656e5971b5
lib/social/account-tokens.ts 60bfe6fc1baf4b7230312c817cea248d70684f55912bef11335ad1dfd8a2c810
lib/social/providers/x.ts f3d3b37d2ea27f00e7ffe8cb7bcd5a3679bcbd31ab349e5e4151d557451b19ea
lib/social/queries.ts 5a2a5c7f90b8340ab746a5139fed970e53a5455d2d6a6123468249d9eb7057d0
app/api/cron/automations/route.ts d9155e299d217eb9f38b59221586f631ed40892ca98df5706761f71b9e29227c
lib/marketing/automation-runner.ts c53ea811924e1efae242eca265b04507a019a1de789a64d6ec2e32e2f802d6e0
scripts/cron-dispatch.mjs 30bea2e93ea55bb5269856793f15e9382a2e0aa3c6065fc7ead1ee54ddad12ff
.github/workflows/cron-dispatch.yml a05bc479c68b5c17655c91e6a7b83e44591fd3d04213f2921463e38836bdfe70
vercel.json 94e0ca36ac2e885995ca3743251964489e078d2ed4e342b78b62a4c90aabb7a5
supabase/migrations/0034_social_command_center.sql 09f2663e4563a6ddbe05eb9b5edbc446805495a580bc22bb489bf5c0396cfcf3
```
