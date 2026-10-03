# The nine BLOCKED rows: eligibility review, 2026-10-03

`finalaudit.md` carries nine rows at ⚠️ BLOCKED, credited at zero. Its rule for
crediting one (Status Legend) is:

> Completion credit for BLOCKED requires implementation investigation, all
> reasonable repository-side verification, an exact external dependency and
> required action, and evidence that no reasonable repository-side fix remains.
> Preserve BLOCKED as its status.

This document is that review for each of the nine, done against main
`d4612dc9` on 2026-10-03. Where a repository-side fix did remain, it is in the
same pull request as this document, with tests. Where only an operator or a
provider can act, the action is written out exactly. **Nothing here changes a
production setting, a credential, a schedule or a migration, and nothing here
edits `finalaudit.md`**: the ledger's owner decides what credit to award from
this evidence.

## Sources, with the moment each was read

| Source | When (UTC) | What it says |
|---|---|---|
| `GET https://www.bubaly.com/api/build-info` | 2026-10-03 11:01 | `{"revision":"d4612dc9…"}` — production serves current main |
| `GET https://www.bubaly.com/api/health` | 2026-10-03 11:01:23 | `status: degraded`, HTTP 200; `env`, `database` (189 ms), `auth`, `serviceRole` (725 ms) all `ok`; `features.missing`: `CRON_SECRET`, `CHILD_LOGIN_SECRET`, `MARKETING_UNSUB_SECRET`, `GUARDIAN_INTERNAL_SECRET`, `FCM_PRIVATE_KEY`, `APNS_PRIVATE_KEY`. Not listed, so set: `RESEND_API_KEY`, `INTERNAL_SECRET`, `CONTACT_CENTER_INBOUND_SECRET`, `VAPID_PRIVATE_KEY` |
| `Supabase production migrations` run 84 ([37005151905](https://github.com/NewWorldVenture/Bubaly/actions/runs/37005151905)), push of main `d25e39ea` | 2026-10-02 12:10–12:12 | `supabase link` **succeeded**; `supabase migration list --linked` **succeeded**; `audit-production-migration-state.mjs --enforce-history` **passed**: 192 ledger rows `0001`…`0176`, 444 public tables, 1,002 policies, `requiresBaselineReview: false`, `moneyWrites.exploitable: false`, all ten money tables `closed by restrictive guard`; **"Apply ordered migrations" skipped** (push event); the job then failed at "Verify household module schema" with HTTP 401 on every check |
| The one apply attempt, run [35465574540](https://github.com/NewWorldVenture/Bubaly/actions/runs/35465574540) | 2026-09-19 19:51–19:53 | `Applying migration 0177_remove_synthetic_auth_users.sql…`, then `NOTICE: skip dependent cleanup on families(created_by): … violates foreign key constraint "family_model_dirty_family_id_fkey"`, then after about two minutes `ERROR: canceling statement due to statement timeout (SQLSTATE 57014)` at statement 1, the `DO` block |
| `Cron dispatch` run 176 ([37104408735](https://github.com/NewWorldVenture/Bubaly/actions/runs/37104408735)) | 2026-10-03 06:51 | `CRON_SECRET:` (blank) → `CRON_SECRET is required for dispatch. Add the matching application secret under Settings → Secrets → Actions.` exit 1, before any dispatch. Runs 174 and 175 also failed |
| `Supabase reviewed forward release` run 3 ([34781290560](https://github.com/NewWorldVenture/Bubaly/actions/runs/34781290560)) | 2026-09-13 | the preview step failed; nothing applied |
| Public DNS (`dns.google`) for `bubaly.com` | 2026-10-03 11:05 | `MX 10 mx1.improvmx.com`, `MX 20 mx2.improvmx.com`; `TXT v=spf1 include:spf.improvmx.com ~all`, a `brevo-code:` verification and a `google-site-verification` |
| The repository at `d4612dc9` | — | code and tests cited per row |

Local checks on this branch: the 16 test files around the changed code pass
(237 tests), among them `tests/cron-auth.test.ts`,
`tests/health-feature-secrets.test.ts`, `tests/marketing-unsubscribe.test.ts`
(10), `tests/marketing-unsubscribe-route.test.ts`,
`tests/contact-center-inbound-email-auth.test.ts` (15, new),
`tests/contact-center-callback-boundary.test.ts`,
`tests/production-migration-state.test.ts`,
`tests/migration-ledger-preflight.test.ts` and
`tests/production-forward-release.test.ts`. ESLint is clean on the changed
files. Four mutation controls each fail the new tests: verifying against only
the first unsubscribe secret (1 test), ignoring Basic credentials (4), accepting
colon-less credentials (1), and warning about `?key=` despite Basic credentials
(1).

## Summary

| Row | What blocks it today | Repository-side fix | Exact external action | Eligible for BLOCKED credit |
|---|---|---|---|---|
| ENV-A40897767E88 `CRON_SECRET` | unset in production (health); the GitHub dispatcher fails every tick | none possible: the value must be shared by the caller and the route | set it in Vercel Production **and** as the Actions secret, redeploy | yes |
| ENV-FCB95D3AD8BB `CHILD_LOGIN_SECRET` | unset in production (health) | none: a default or derived value would mint child credentials from something guessable | set it in Vercel Production, redeploy | yes |
| ENV-57E10566D252 `GUARDIAN_INTERNAL_SECRET` | unset, and its fallback `CRON_SECRET` is unset too | none; the row's premise is corrected below | set `CRON_SECRET` (escalation then works through the fallback); set a dedicated value to separate the credentials | yes |
| ENV-F3AB1A14762D `MARKETING_UNSUB_SECRET` | unset; links are signed with the `INTERNAL_SECRET` fallback today | **done here**: verification accepts the internal secret as well as the dedicated one, so setting the dedicated one keeps mailed links valid | after this change is deployed, set it in Vercel Production, redeploy | yes, once this change is live |
| MAIN-F5 production migrations | `0177`'s statement timeout (PROD-DB-0177); credentials and ledger are no longer the blocker | a bounded repair of `0177` is reserved for the owner's reviewed change (MIGRATION-229E5BF02AC9), not made here | the recorded remedy: run `0177`'s body with no statement timeout, repair its ledger row, dispatch the workflow with `apply=true`; rotate `SUPABASE_SERVICE_ROLE_KEY` | yes, on the operator steps; the repo-side candidate is owner-reserved |
| MAIN-F-001 ledger "records only 0001–0003" | historical: the ledger records `0001`–`0176` | docs corrected (LB-016 §4.3, `PENDING_PROD_MIGRATIONS.md`) | same as MAIN-F5 | yes |
| MAIN-F-C08 forward release pinned at 0240–0254 | the manifest's baseline and range match neither production nor the repository, and cannot | none without a release-policy decision | owner: retire the forward-release mechanism in favour of the ordered apply, or re-pin a reviewed bundle after the catch-up | yes, as an owner decision |
| MAIN-F6 family email not routed | MX points at a forwarding service, not at an inbound-parse provider | none: DNS and the provider are outside the repository | point MX at an inbound-parse provider aimed at the webhook; then the end-to-end check | yes (step 1 of 3 is done) |
| MAIN-F-E06 secret in the query string | an owner decision (SEC-011) on removing `?key=` | **done here**: Basic credentials are accepted, so a provider that cannot set a header has an alternative to `?key=` | owner: approve removing `?key=` (a one-line change plus the runbook) | yes |

If the ledger's owner awards all nine, coverage moves from 2.37% to the 2.44% the
checkpoint already computes for that case. Nothing below changes
`PRODUCTION READY: NO`.

---

## ENV-A40897767E88 — `CRON_SECRET`

**Investigation.** `lib/server/cron-auth.ts` → `hasCronAuthorization` compares
the bearer with `bearerMatches`, which returns false before building the
`Bearer ` prefix when the secret is unset, so every scheduled route answers 401
rather than ever matching `Bearer undefined`. `tests/cron-auth.test.ts`
enumerates every `app/api/cron/*/route.ts` from disk and requires both the call
and the 401; `tests/health-feature-secrets.test.ts` requires every cron in
`vercel.json` (27 today) to enforce it. The sub-daily schedules run from
`.github/workflows/cron-dispatch.yml` every five minutes, which reads the
Actions secret of the same name and refuses to dispatch without it: run 176 on
2026-10-03 06:51 UTC printed `CRON_SECRET:` blank and exited 1 before any
request, as did 174 and 175. `/api/guardian/escalate` also falls back to this
value (next row). `app/(app)/admin/settings/page.tsx` shows "Vercel Cron" as not
ready while it is unset.

**Production state.** `/api/health` lists it missing (2026-10-03 11:01 UTC).

**Why no repository-side fix remains.** The route and the two callers (Vercel's
cron scheduler and the Actions dispatcher) must present the same value. The
repository cannot mint it (it would then be public), cannot derive it from
another secret without making that secret the cron credential, and must not
weaken the fail-closed check.

**Exact external action (owner).**
1. Generate a value: `openssl rand -hex 32`.
2. Vercel → Project → Settings → Environment Variables → Production:
   `CRON_SECRET` = that value. Redeploy (Vercel does not apply a new variable to
   a running deployment).
3. GitHub → repository Settings → Secrets and variables → Actions:
   secret `CRON_SECRET` = the same value. Optional variable `CRON_BASE_URL`
   (defaults to `https://www.bubaly.com`).
4. Verify: `/api/health` no longer lists `CRON_SECRET`; the next `Cron dispatch`
   run passes "Validate configuration and dispatch due routes"; any cron route
   answers 401 without the bearer and 2xx with it.

## ENV-FCB95D3AD8BB — `CHILD_LOGIN_SECRET`

**Investigation.** `app/(auth)/actions.ts` `childSignInAction` reads
`process.env.CHILD_LOGIN_SECRET` and returns the translated "kid sign-in isn't
set up" before any read when it is unset; `app/(app)/family/child-login-actions.ts`
refuses to create or change a child login the same way, and
`app/(app)/dashboard/family-access/page.tsx` renders the "not configured" state
from the same test. There is no fallback and no stored value; CI sets a fixture
(`ci.yml`, `CHILD_LOGIN_SECRET: ci-only-child-pin-session-fixture`) so the
child-login suites run. The secret feeds `deriveChildPassword`, which turns a
username and PIN into the synthetic auth user's password.

**Production state.** `/api/health` lists it missing (2026-10-03 11:01 UTC).

**Why no repository-side fix remains.** Any default or derived value would make
every child password derivable from the username and a four-digit PIN plus
something an attacker could learn. Failing closed is the correct behaviour and
is pinned by `tests/child-login-action-security.test.ts` and its siblings.

**Exact external action (owner).** Vercel Production: `CHILD_LOGIN_SECRET` =
`openssl rand -hex 32`; redeploy. Verify: `/api/health` no longer lists it;
`/dashboard/family-access` no longer shows the not-configured notice; a parent
can create a child login and the child can sign in with it. Changing the value
later invalidates every existing child password (they are derived from it), so
set it once.

## ENV-57E10566D252 — `GUARDIAN_INTERNAL_SECRET`

**Investigation.** The only reader is `app/api/guardian/escalate/route.ts`:
`const secret = process.env.GUARDIAN_INTERNAL_SECRET || process.env.CRON_SECRET`,
then `bearerMatches`. So the row's "the code fails closed without it" holds only
while `CRON_SECRET` is also unset, which it is: today the emergency escalation
fan-out (push + SMS + outbound call to every manager) answers 401 to every
caller. `lib/health/status.ts` lists the name on its own, by presence, so the
health line stays until a dedicated value exists even once `CRON_SECRET` is set.
No code in the repository calls this endpoint with the bearer (the only
in-repository reference is its Twilio-signed `twiml` sub-route), so the caller
is external and must be configured with the same value.

**Production state.** `/api/health` lists it missing (2026-10-03 11:01 UTC).

**Why no repository-side fix remains.** The fallback to `CRON_SECRET` is the
deliberate deploy-wide default, written at the call site. Removing the health
line would hide the hygiene point (one credential for scheduled jobs and for an
endpoint that can text every parent).

**Exact external action (owner).** Setting `CRON_SECRET` (above) makes the
endpoint work. To separate the two credentials, also set
`GUARDIAN_INTERNAL_SECRET` = `openssl rand -hex 32` in Vercel Production,
redeploy, and configure whatever calls `/api/guardian/escalate` to present it
as `Authorization: Bearer`. Verify: `/api/health` no longer lists it; a POST
without the bearer answers 401.

## ENV-F3AB1A14762D — `MARKETING_UNSUB_SECRET`

**Investigation.** `lib/marketing/unsubscribe.ts` signs the unsubscribe token
with the first of `MARKETING_UNSUB_SECRET`, `INTERNAL_SECRET`,
`SUPABASE_SERVICE_ROLE_KEY` that is set, and throws in production only when
none is. Production has `INTERNAL_SECRET` set (health), so unsubscribe links
work today and are signed with the internal-service secret. The row's "fails
closed without it" is therefore not what the code does; the finding is hygiene:
a public link should be signed with a secret of its own, not with the one that
authorises internal callbacks.

**Repository-side fix, made here.** Setting the dedicated secret used to be
unsafe: `verifyUnsubToken` checked only the first configured secret, so every
unsubscribe link already in an inbox, signed with `INTERNAL_SECRET`, would have
stopped working the moment `MARKETING_UNSUB_SECRET` was set. A recipient who
cannot unsubscribe from a marketing email is a compliance failure. Verification
now accepts a token signed with the dedicated secret or with `INTERNAL_SECRET`
when both are set (each compared in constant time), while signing still uses
the first, so new links move to the dedicated secret immediately and old ones
keep working for as long as `INTERNAL_SECRET` stays configured. Two deliberate
edges: a blank or whitespace-only value counts as unset, as `/api/health`
already treats it; and `SUPABASE_SERVICE_ROLE_KEY` signs, and verifies, only
while neither of the other two is set, so a database credential does not stay
a valid unsubscribe key once a real signing secret exists (which is how the
code behaved before, too). `tests/marketing-unsubscribe.test.ts` adds the
before/after case, a not-configured-secret case, a blank-secret case, the
service-role-only case and the production fail-closed case for verification;
the route test is unchanged.

**Production state.** `/api/health` lists it missing (2026-10-03 11:01 UTC).

**Exact external action (owner), in this order.** (1) Deploy this change. (2)
Vercel Production: `MARKETING_UNSUB_SECRET` = `openssl rand -hex 32`; redeploy.
(3) Verify: `/api/health` no longer lists it; an unsubscribe link mailed before
the change still answers "Unsubscribed"; a new link's `t=` differs. Keep
`INTERNAL_SECRET` as it is; it is what the old links were signed with.

## MAIN-F5 — Production migrations cannot be applied

**Investigation.** The row's two steps are "restore the Supabase credentials so
`supabase link` succeeds" and "repair the ledger so `0004` is recorded". Both
are done, by the evidence of run 84: `supabase link` finished,
`supabase migration list --linked` succeeded, and the `--enforce-history` gate
passed with `requiresBaselineReview: false` on a ledger of 192 rows,
`0001`–`0176`. The money boundary read `exploitable: false` with every table
closed by a restrictive guard. "Apply ordered migrations" runs only on
`workflow_dispatch` with `apply=true` (`supabase-production-migrations.yml`,
pinned by `tests/production-migration-state.test.ts`), so a push to main
verifies and never applies; runs 81–84 all skipped it.

What blocks the apply is `0177_remove_synthetic_auth_users.sql`
(PROD-DB-0177). The one dispatch with `apply=true`, run 35465574540 on
2026-09-19, applied nothing: `0177`'s single `DO` block was cancelled by the
statement timeout after about two minutes, having first skipped its
`families(created_by)` cleanup on `family_model_dirty_family_id_fkey` (the
trigger that `0249` later repairs). Everything from `0177` on, 257 files up to
`0474`, is unapplied. The repository replays `0177` on a fresh database in
every CI run (the Database job), where it is a no-op.

Run 84's own failure is later and separate: "Verify household module schema"
got HTTP 401 from PostgREST on every check, which is the repository secret
`SUPABASE_SERVICE_ROLE_KEY` no longer matching the project. It does not block
the apply step, which comes before it, but it will fail the verification steps
after any apply until rotated.

**Repository-side verification.** `tests/production-migration-state.test.ts`,
`tests/migration-ledger-preflight.test.ts` and
`docs/audit/rehearse-ledger-repair.sh` (CI) pass. `docs/PENDING_PROD_MIGRATIONS.md`
now opens with a dated correction (it said connectivity was lost and the
ledger stopped at `0003`), and LB-016 §4.3 is annotated the same way, which
settles DEPLOY-003: there is no replay from `0004` to disagree about.

**Why the remaining repository-side candidate is not taken here.** A bounded
repair of `0177` is possible in principle (lift `statement_timeout` for its
transaction, bound `lock_timeout`, and account for the `0249` trigger ordering
that Jimmy's reproduction showed leaves family-referenced synthetic users in
place). The owner has reserved exactly that as a reviewed change, the
investigation is active in another lane (MIGRATION-229E5BF02AC9, "Hosted 57014
cause remains unproven"), and its effect in the hosted path cannot be proven
from the repository. Changing a migration under an active investigation,
unreviewed, would be the wrong kind of help.

**Exact external action (owner).** The remedy recorded in the ledger's
PROD-DB-0177 entry, in order: (1) against production, in the SQL editor or
`psql`, `set statement_timeout = 0;` and run the body of `0177` once (or first
delete the `onb…@seed-onb.bubaly.test` / `person…@seed.bubaly.test` users
through the Auth admin API, which makes `0177` a no-op); expect the
`Retired synthetic Auth users: N removed, M still referenced` notice, and note
that users referenced by `families` rows stay "still referenced" until `0249`'s
trigger repair is in place; (2) `supabase migration repair --status applied 0177`;
(3) rotate the `SUPABASE_SERVICE_ROLE_KEY` repository secret; (4) dispatch
`Supabase production migrations` with `apply=true`, which applies `0178`
onward in order, in a maintenance window (LB-016 §4.4's open-boundary window
between `0006`'s policies and `0267`/`0275` applies to any ordered apply).

## MAIN-F-001 — Production migration ledger records only `0001`–`0003`

**Investigation.** Historical. Run 84 read 192 ledger rows through `0176` and
`hasUnrecordedBaseline` returned false. The LB-016 §4 procedure (replay from
`0004` with the ledger guard intact) was written for a ledger at `0003` and no
longer describes any step to take; `docs/audit/rehearse-ledger-repair.sh`
stays in CI as regression evidence that an ordered replay onto a populated
schema no-ops cleanly.

**Repository-side fix.** The two documents that disagreed (DEPLOY-003) now both
carry the dated correction. No code.

**Exact external action.** The same as MAIN-F5: the ledger will advance past
`0176` when the owner dispatches the apply after the `0177` remedy.

## MAIN-F-C08 — The forward-release mechanism is pinned 38 migrations in the past

**Investigation.** `supabase/production-forward-release.json` pins baseline
`0001`–`0003` and migrations `0240`–`0254`, with a production catalog snapshot
from 2026-09-05. `scripts/apply-production-forward-release.mjs` refuses it on
two independent guards, both correctly: `assertNoNewerMigrations` (the
repository has 179 files past `0254`) and `assertPreflight` ("Unexpected or
partially applied migration ledger": production's ledger is `0001`–`0176`, not
`0001`–`0003`). Run 3 on 2026-09-13 failed at the preview step. A re-pin that
matched reality would be baseline `0001`–`0176` and a range of 257 files applied
in one transaction under the script's own `statement_timeout = '90s'`, when
`0177` alone exceeds 120 s. The mechanism was a one-time atomic bundle for a
15-migration release; it cannot carry the catch-up, and the ordered
`supabase db push` in the production workflow is what will.

**Repository-side verification.** `tests/production-forward-release.test.ts`
and `tests/production-forward-release-workflow.test.ts` pass; the guards fire
on exactly the conditions above.

**Why no repository-side fix remains.** Re-pinning needs a credentialed
production read (which run 84's `production-schema-audit` artifact now
provides, until 2026-10-05), a new preview, review evidence and the owner's
authorization, as the row says; and the honest re-pin is not viable. Retiring
the workflow and manifest is a release-policy change, which an agent should not
make unilaterally.

**Exact external action (owner decision).** Either retire
`supabase-forward-release.yml`, the manifest and its two tests in favour of the
ordered apply (after MAIN-F5's remedy), or, after the catch-up, re-pin a small
reviewed bundle with a fresh snapshot. Record the choice; the row closes with
it.

## MAIN-F6 — Family email is built but not routed

**Investigation.** The runbook's three steps: (1) set
`CONTACT_CENTER_INBOUND_SECRET`; (2) point `bubaly.com` MX at an inbound-parse
provider aimed at `/api/contact-center/email`; (3) verify end to end. Step 1 is
**done**: `/api/health` does not list the secret among the missing ones, and
the 2026-09-26 PROD-ENV reading already had it set, so the row's step 1 was
stale when it was written. Step 2 is not: public DNS answers `MX 10 mx1.improvmx.com / 20 mx2.improvmx.com`
and SPF `include:spf.improvmx.com`, a mail-forwarding service, which delivers
to a mailbox and never POSTs to a webhook. A `brevo-code:` TXT record shows a
Brevo domain verification exists; Brevo offers inbound parsing, so it may be
the intended provider, but nothing in DNS routes mail to it. Step 3 cannot run
before step 2.

**Repository-side verification.** The route fails closed: 401 with a wrong or
absent secret before any household read
(`tests/contact-center-callback-boundary.test.ts`,
`tests/contact-center-inbound-email-auth.test.ts`), and `/api/contact-center`
is on the middleware's public list so the route's own guard runs
(`tests/middleware-public-api-boundary.test.ts`). The 2026-09-13 production
probe (401) stands; it was not repeated from this session.

**Why no repository-side fix remains.** DNS, the provider and the provider's
webhook configuration are outside the repository.

**Exact external action (owner).** Choose an inbound-parse provider; configure
its route to `https://inbound:<secret>@www.bubaly.com/api/contact-center/email`
(or the bare URL with `x-inbound-secret` if it can set headers); set the
`bubaly.com` MX records to that provider's hosts, after checking what ImprovMX
currently forwards and where that mail should go afterwards; keep Resend's
outbound SPF/DKIM records as they are (the current SPF record names only
ImprovMX, which is worth a look while there); then send a real message to a
provisioned family address and confirm it appears in that family's inbox. The
runbook `docs/runbooks/family-contact-center-routing.md` carries these steps.

## MAIN-F-E06 — The inbound-email secret is accepted in the query string

**Investigation.** `authorized()` in `app/api/contact-center/email/route.ts`
preferred the `x-inbound-secret` header and fell back to `?key=`, warning once
per request on the fallback. The row records the owner's decision (SEC-011)
that `?key=` stays because some inbound-parse providers cannot set custom
headers, so removing it would choose which providers can integrate. That is
the whole of the blocker: not a missing fix, but a trade-off.

**Repository-side fix, made here.** The trade-off had a third option the route
did not offer. A provider that cannot set a header can often carry
`user:password@` in the webhook URL (Postmark documents this for its
webhooks; any other provider should be confirmed with the runbook's §3 check
before MX moves), which it sends as an `Authorization: Basic` header, outside
the request line that access logs record. The route now accepts the secret as the
password of Basic credentials (any username; RFC 7617; constant-time compare
through `secretEquals`; no colon or an empty password is no credential). The
header is still preferred, `?key=` still works and still warns, now naming
both alternatives, and the first credential presented decides.
`tests/contact-center-inbound-email-auth.test.ts` (15 cases) covers the
accepted forms, seven refusals, the unset-secret-in-production case, the
warning, precedence, and that a request carrying only Basic credentials passes
the middleware to the route's own guard. The runbook now lists the three forms in order of
preference and points the provider URL at the Basic form.

**Why this is the end of the repository's part.** With Basic credentials, a
provider that cannot set a header has a route-line-free option, so `?key=` is
no longer the only way in for any class of provider. Dropping it is a one-line
change plus the runbook, and it is the owner's call under SEC-011, which this
review does not pre-empt.

**Exact external action (owner).** Approve removing the `?key=` fallback (then
it is removed in a follow-up, with the runbook), or sign off keeping it as an
accepted risk now that it is no longer the only option for any provider.

---

## What this review did not do

- It did not edit `finalaudit.md`; the ledger's owner folds this in.
- It did not set, rotate or read any secret, apply or alter any migration,
  change any schedule, DNS record or provider setting, or send any message.
- It did not POST to production. The inbound-email fail-closed probe recorded
  on 2026-09-13 stands; the health and build-info reads above are GETs of
  public endpoints.
- It did not change `0177`. The bounded repair is the owner's reviewed change.
