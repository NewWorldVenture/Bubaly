# Claude-3 — Backend / API / Database / Auth / Security

## STATUS (Session 4 — 2026-09-15, the server-action surface)

CURRENT: Done. Round-4 dispatch: the 132 `'use server'` files, the one public
  POST surface this audit had barely looked at (~14 mentions across all five
  files, against 141 API routes audited thoroughly in Pass E).
COMPLETED: 7 new findings (1 HIGH, 2 MEDIUM, 4 LOW) + 14 verified-clean items
  + a 5-item BLOCKED list. Enumerated the surface properly for the first time:
  **439 exported server actions** across 113 top-level action modules, with a
  TRANSITIVE auth check (a fixpoint over 685 auth-bearing function names) so
  actions guarded by a local `guard()`/`managerCtx()` helper are not miscounted.
  **9 of 439 reach no auth path** — not the "8 files" a file-level grep reported
  in the prior session's Verified-healthy item 12, and a different set; the naive
  grep flagged 94, of which 85 authorize through a local helper. All 9 read in
  full and accounted for.
  Headline: **31 of 31 API routes that call the LLM carry `enforceAIRateLimit`;
  0 of 3 server actions that call the LLM do.** Also found the marketplace
  hand-off actions deriving a buyer/seller role by ternary with no check that
  the caller is a party (the same feature's review action has exactly that
  check), and a social-RBAC deadlock where the TS and SQL permission matrices
  disagree on `manage_access` and the only role that holds it in TS is never
  assigned to anyone.
  Refuted nothing of another worker's; CORRECTED this file's own prior
  server-action claim (the count and the method, not the conclusion — the three
  public flows it named are confirmed clean, with one new note: `gift_links`
  has an `expires_at` column the gift action never reads).
NEXT: nothing queued. For Claude-1, in fix order: the three AI rate limits
  (3 lines each, mechanical, and a guard test is trivially writable); then the
  hand-off party check; then the social matrix decision (a product call).
FILES-TOUCHED: audit/claude-3.md ONLY. No application source modified —
  audit-only per the deviation recorded in audit/status.md.
BLOCKERS: no local Supabase (no docker daemon, no CLI) -> **not one of the 439
  actions was invoked**. Everything below is static + committed-SQL reading.
  See "What I could NOT reach" at the end of Session 4 — five named limits,
  including that Next's action-id replay premise itself was not demonstrated.
LAST-UPDATE: 2026-09-15

---

## STATUS (this run — 2026-09-14, continuation session)

CURRENT: Done. A prior Claude-3 session (content preserved below, under
"Findings (prior session, preserved)") already did a full 141-route
AUTHENTICATION mapping (Pass E, F-E01–F-E09, indexed in finalaudit.md) and
Claude-1 has since done substantial additional backend/authz work in this same
run (Pass G/H/I/J/K in finalaudit.md: the 58-sensitive-tables RLS sweep now at
`0297`, service-role route inventory, cron/Twilio/rate-limiter verification,
the auth-user pagination ceiling, wallet reconciliation vacuity, Stripe webhook
ack semantics). This session's marginal contribution targeted what neither
covered in depth: **authorization** (not just authentication) on a
**per-resource** basis — does a route/query that knows who the caller is also
verify the specific row belongs to them — plus a fresh check of how far the
ILIKE-escaping fix (child sign-in) actually reached.
COMPLETED: 4 new findings (1 HIGH, 1 MEDIUM, 2 recorded as
VERIFIED/LOW-hygiene rather than open vulnerabilities, tested against the
negative case rather than assumed); an 8-item "Verified healthy" section
covering the `ServiceScope` abstraction (45 call sites, zero unsafe `extra`
overrides in the wild), money/missions/inbox/billing/sync service-role
authorization, and public-write scoping.
NEXT: nothing queued. Possible follow-up for another worker: extend the
ILIKE-escape fix (MEDIUM finding below) to the 5 listed call sites; fix the
HIGH email-routing finding (`.eq()` instead of unescaped `.ilike()`).
FILES-TOUCHED: audit/claude-3.md only. No source files modified, consistent
with the audit-only brief.
BLOCKERS: none.
LAST-UPDATE: 2026-09-14

---

Findings only. Format:

```
[CLAUDE-3][SEVERITY][AREA] Title
File:     path/to/file.ts:line
Problem:  what is wrong
Evidence: what proves it (command output, code, a live response)
Impact:   who is hurt and how
Fix:      recommended change
Status:   OPEN | VERIFIED | FIXED | BLOCKED
```

SEVERITY: CRITICAL | HIGH | MEDIUM | LOW

---

## Method

Not a re-derivation of `finalaudit.md`. Two things the prior passes did not do:

1. **The 308 migrations were actually replayed** into a local Postgres 16
   (`/var/tmp/pgaudit`, port 5599) behind a Supabase-shaped prelude (`anon`,
   `authenticated`, `service_role`, `auth.uid()`, `storage.*`). 482 public
   tables were created; only three migrations failed, all for reasons local to
   the harness (`vector` extension absent → `0237`, and its two dependants).
   Every RLS/grant/policy/function statement below is a query against that live
   schema, not a grep of SQL text. This matters: the repo enables RLS through
   `DO $$ ... EXECUTE format('alter table public.%I enable row level security')`
   loops, so a text scan reports 216 false "missing RLS" tables and the live
   catalogue reports **zero**.
2. **Every one of the 141 `app/api/**/route.ts` handlers was mapped to the
   authorization call it makes**, and the 61 routes carved out of the session
   boundary by `lib/auth/route-access.ts` PUBLIC were each read.

The API and RLS surface came back clean (see "Verified healthy"). The findings
are concentrated where authorization is expressed in **two places that
disagree**: a server-side page guard and an RLS policy that does not encode the
same rule — and the browser talks to PostgREST directly, so the policy is the
only one that binds.

---

## Findings — this session (2026-09-14 continuation)

### [CLAUDE-3][HIGH][AUTHZ] Inbound email routing matches families by an unescaped ILIKE wildcard — one family's message can be filed into another's Contact Center inbox

- **File/path:** `lib/contact-center/server.ts:62-73` (`resolveFamilyByEmailLocalResult`),
  called from `app/api/contact-center/email/route.ts:83`; the attacker-controlled
  input is parsed by `lib/contact-center/address.ts:120-125` (`parseRecipientLocal`).
- **Problem:** `resolveFamilyByEmailLocalResult` resolves which family owns an
  inbound `@bubaly.com` address with `.ilike('email_local', local)` where `local`
  is used **as the ILIKE pattern itself**, not escaped, and not wrapped in a
  fixed `%...%` — an exact case-insensitive match was clearly intended (the
  function's own comment: "Resolve the family that owns a bubaly.com
  local-part"). `local` comes straight from the inbound email's `To` header via
  `parseRecipientLocal`, whose extraction regex explicitly **permits `_`**
  (`[a-z0-9._-]*`) in the local-part it returns — `_` is the ILIKE
  single-character wildcard. `%` is excluded by that same regex, so the
  match-everything case is not reachable this way, but the single-character
  wildcard is, and email local-parts are unauthenticated, provider-parsed
  attacker input (this route's whole job is to accept mail from strangers).
  This is the same defect class as the child sign-in ILIKE hole this repo
  already shipped and fixed once (noted in Pass H's "Verified healthy" — "The
  `ilike` wildcard hole is fixed and documented in place") — the fix did not
  propagate here.
- **Evidence:** Reproduced the actual ILIKE semantics (Postgres `_`/`%`, no
  escaping) against representative stored values shaped exactly like this
  table's real rows (`lib/contact-center/provision.ts` `candidateLocals`
  produces `smith`, `smith2`, `smith-family`, `smith-home`, `smith-<hash>`):

      $ node -e '
      function ilikeToRegex(pattern) {
        const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        return new RegExp("^" + esc.replace(/%/g, ".*").replace(/_/g, ".") + "$", "i");
      }
      const stored = ["smith","smith2","smith-family","jones","oconnor","patel3"];
      for (const input of ["smit_","jone_","smith_family","_mith"]) {
        console.log(JSON.stringify(input), "->", stored.filter(s => ilikeToRegex(input).test(s)));
      }'
      "smit_" -> [ 'smith' ]
      "jone_" -> [ 'jones' ]
      "smith_family" -> [ 'smith-family' ]     <- '_' matched the real '-'
      "_mith" -> [ 'smith' ]

  `parseRecipientLocal`'s regex (`lib/contact-center/address.ts:121`,
  `[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?`) confirmed to accept every one of these
  inputs verbatim ahead of the `@bubaly.com` it matches against — nothing
  upstream strips or rejects the underscore.
- **Impact:** An external sender (no account, no session — this is the
  unauthenticated inbound-mail webhook, gated only by
  `CONTACT_CENTER_INBOUND_SECRET`, which authenticates the *provider*, not the
  *sender of the email the provider forwards*) who sends to an address that is
  mostly-right but wrong by exactly one character, substituted with `_`, gets
  routed to whichever real family's `email_local` happens to match — filing
  their message into that family's private inbox
  (`recordInboundMessage`), running the AI concierge over attacker-controlled
  text, potentially firing the `🚨 Urgent` SMS escalation to the family's real
  phone (`shouldNotifyFamily`), creating planner/paperwork rows
  (`routeInboundToPlanner`, `fileInboundPaperwork`), and sending an auto-reply
  **from the family's own identity** back to the attacker that confirms the
  match and discloses the family's display name
  (`familyLabel` in the reply). Because a `.maybeSingle()` 2-or-more-row
  collision surfaces as a distinguishable `503` (`routed.error`) versus a clean
  `200 {ok:true, skipped:'unknown address'}` for zero rows versus a normal
  filed response for exactly one, the three-way response difference is a
  working oracle for enumerating other families' `email_local` values
  character-by-character with `_` substitution — no guessing required beyond a
  plausible base name, which the feature already treats as non-secret (it's
  handed to schools/doctors), but the exact-match guarantee is what stops a
  near-miss from landing on a stranger.
- **Recommended fix:** Escape `_` and `%` in `local` before using it as an
  ILIKE pattern (`local.replace(/[%_]/g, (m) => `\\${m}`)`), matching the
  pattern already used correctly elsewhere in this codebase (e.g.
  `lib/services/calendar/index.ts:388`, `lib/services/groceries/index.ts:521`).
  Better still: this call wants an *exact* case-insensitive match, not a
  pattern match at all — `.eq('email_local', local.toLowerCase())` is both
  simpler and removes the wildcard surface entirely (the unique index is
  already on `lower(email_local)`, so case-insensitive equality is exactly
  what the schema guarantees uniqueness for).
- **Status:** OPEN

### [CLAUDE-3][MEDIUM][DATA INTEGRITY] The ILIKE-escaping fix from the child sign-in bug was not applied to several free-text lookups that also drive writes

- **File/path:** `lib/assistant/tools.ts:247,289,498,532` (reminder + RSVP
  tools: `complete_reminder`, `snooze_reminder`, `get_event_rsvps`,
  `rsvp_to_event`), `lib/services/calendar/index.ts:668` (`findEventByTitle`),
  `lib/social/queries.ts:59` (`getFeed` search).
- **Problem:** Each builds an ILIKE pattern as `` `%${title}%` `` (or
  `` `%${opts.search}%` ``) directly from user/AI-supplied free text, with no
  escaping of `%`/`_`. The sibling function
  `lib/services/calendar/index.ts:388` (`listEvents`) escapes exactly this in
  the same file, with a comment explaining why — "so a title containing '%'
  does not silently widen the search" — so this is a known, previously-applied
  fix that did not reach every call site that needed it, the same shape as
  F-004/F-011 elsewhere in this audit (a fix that did not generalize).
- **Evidence:**

      $ grep -n "ilike('title'" lib/services/calendar/index.ts
      388:      query = query.ilike('title', `%${term}%`);   // term is escaped 2 lines up
      668:    .ilike('title', `%${needle}%`)                  // needle = title.trim() — NOT escaped

  All affected call sites are already scoped with `.eq('family_id', ...)`
  (verified by reading each — `ctx.familyId` in `assistant/tools.ts`,
  `familyId` param in `calendar/index.ts:668`, `familyId` param in
  `social/queries.ts`), so this is **not** a cross-family read; it never
  reaches a row outside the caller's own family, unlike the finding above.
- **Impact:** Within one family, a title/search term containing `%` or `_`
  matches far more broadly than typed. Three of the five sites are **writes
  driven by an ILIKE lookup** (`complete_reminder`, `snooze_reminder`,
  `rsvp_to_event` in `assistant/tools.ts`): the AI assistant resolves "which
  reminder/event did they mean" via this exact pattern and then mutates the
  first match. A title that happens to contain `%` (copy-pasted from a coupon,
  a grade, a percentage in an event name like "50% off — teacher conf") turns
  "complete reminder about the 50% off sale" into a broadened match that can
  silently complete or reschedule the **wrong** reminder, or RSVP to the wrong
  event, with no error — a correctness/data-integrity bug, not an
  authorization bypass, since it stays inside the caller's own family.
- **Recommended fix:** Apply the same one-line escape already used at
  `calendar/index.ts:388` and throughout `lib/services/*` (`term.replace(/[%_]/g,
  (m) => \`\\${m}\`)`) at all five sites above, before interpolating into the
  ILIKE pattern.
- **Status:** OPEN

### [CLAUDE-3][LOW][AUTHZ] Two server actions trust a client-supplied `familyId` with no session cross-check — backstopped by RLS, tested rather than assumed

- **File/path:** `app/(app)/dashboard/moment-actions.ts` —
  `addMomentGroceryAction` (`input.familyId`, line ~61-92) and
  `createMomentReminderAction` (`input.familyId`, line ~107-124).
- **Problem:** Both actions take `familyId` as a plain argument from the
  client-side call (a server action's arguments are chosen by the calling
  browser JS, not re-derived from the session) and use it directly in
  `supabase.from('grocery_items'|'grocery_lists'|'reminders').insert({family_id:
  input.familyId, ...})` via `createServer()` — with no
  `requireUserContext()`-derived `ctx.active.familyId` comparison anywhere in
  either function. This is the one inconsistency found against an otherwise
  extremely uniform convention: every other sampled action/route in this audit
  (`lib/wallet/server.ts` callers, `app/(app)/money/actions.ts`,
  `lib/services/inbox/index.ts`, and all 40+ `scopeFromUserContext(ctx, ...)`
  call sites — see Verified healthy) either derives `familyId` from `ctx`
  directly or re-validates a passed one against it.
- **Evidence:** Confirmed this is **not** exploitable against a family the
  caller does not belong to, rather than assumed — checked the actual RLS
  policy rather than trusting the convention:

      $ grep -n "reminders\|grocery_lists\|grocery_items" supabase/migrations/0004_rls.sql
      23:  'meals','meal_plans','grocery_lists','grocery_items',
      26:  'documents','notes','goals','reminders',
      ...
      create policy %1$s_insert on public.%1$I for insert
        with check (public.is_family_member(family_id))

  All three tables are in `0004`'s generic family-scoped loop, so every insert
  the RLS layer sees is checked against `is_family_member(family_id)` using
  `auth.uid()` from the caller's own session — a `family_id` for a family the
  caller does not belong to is rejected with `new row violates row-level
  security policy`, regardless of what the action code does or doesn't check.
  This matches the pattern Pass E already verified sound (no `using(true)` on
  any family-scoped table) and the design position the codebase states
  explicitly (`lib/constants/roles.ts`: *"the database RLS is the real
  enforcement boundary"*).
- **Impact:** **None against a stranger's family** — tested, not assumed. The
  only live consequence: a caller who is a genuine member of **more than one**
  family (the app supports this — co-parents, helpers) could write a grocery
  item or reminder into a family that is not their currently *active* one if
  they (or a compromised/buggy client) sent a different, still-own `familyId`.
  That is a membership they already hold, so it is not a boundary crossing —
  at most a confusing misfile, not a security bypass. Recorded because it is a
  single point of failure (RLS alone, no defense in depth) in a codebase that
  otherwise consistently double-checks, and because RLS regressing on exactly
  these two functions would turn a LOW into something worse with no second
  layer to catch it — unlike every other sampled write path.
- **Recommended fix:** For consistency and defense-in-depth (not urgency),
  derive `familyId` from `ctx.active.familyId` in both functions instead of
  accepting it as a parameter, the same way `removeMomentGroceryAction` in the
  same file already relies on RLS alone for a delete-by-id but at least takes
  no writable identifier as input.
- **Status:** VERIFIED (sound today; hygiene recommendation only)

---

## Verified healthy — this session

Recorded so a later pass does not re-derive them. Each is a positive finding
sampled and, where practical, checked against a negative case rather than
inferred from convention.

1. **The `ServiceScope`/`scopeFromUserContext` abstraction cannot be handed a
   spoofed `familyId` in practice.** `lib/services/scope.ts:29` builds
   `{ familyId: ctx.active.familyId, ... , ...extra }` — `extra` is spread
   *last*, so a caller technically *could* override `familyId` through it.
   Checked whether any of them do:

       $ grep -rn "scopeFromUserContext(" app lib --include=*.ts --include=*.tsx | grep -v '\.test\.'
       <45 call sites>

   Every call site passes either `(ctx, db)` or `(ctx, db, { now })` — the one
   `extra` in live use is a clock override for a scheduling feature, never
   `familyId`. So while the function's signature *permits* the unsafe override,
   nothing in the tree exercises it. Worth a type-level guard
   (`Omit<Partial<ServiceScope>, 'familyId' | 'db'>` for `extra`) so a future
   caller cannot introduce the bug the signature currently allows, but there is
   no live instance today.
2. **Money-moving server actions double-check every client-supplied id.**
   `app/(app)/money/actions.ts` — `issueCardAction`, `setCardFrozenAction`,
   `updateCardControlsAction`, `createCardRevealAction`,
   `prepareCardRevealAction` — every one combines the client-supplied
   `cardId`/`childWalletId` with `.eq('family_id', ctx.active.familyId)` in the
   *same* service-role query before acting on it, i.e. authorization is
   re-proven per call even though `createServiceClient()` bypasses RLS
   entirely for these.
3. **Chore/mission actions** (`app/(app)/missions/actions.ts`) scope every
   `chore_assignments`/`chore_submissions`/`chore_disputes` read and write with
   `.eq('id', X).eq('family_id', familyId)` from `ctx`, including the
   service-role escalation path (line 180+).
4. **Inbox service functions** (`lib/services/inbox/index.ts`
   `markInboxMessageHandled`/`setInboxMessageStatus`) re-derive
   `scope.familyId` and additionally gate on role (`mayFile`) before any write.
5. **Billing** (`app/api/billing/{cancel,change-plan,checkout}/route.ts`):
   `familyId` is always `ctx.active.familyId`; `change-plan`'s
   `expectedFamilyId`/`expectedUserId` "review" path is a *confirmation* that a
   freshly-refetched session still matches what the client last saw (guards a
   stale-tab plan change), not a trust boundary — it is checked **against** a
   fresh `getUserContext()`, never substituted for it.
6. **Sync routes** (`app/api/sync/[provider]/{callback,disconnect,status}`,
   `app/api/sync/google/*`): every service-role query is
   `.eq('family_id', ctx.active.familyId).eq('user_id', ctx.user.id)`
   together, so even a shared/family-visible `sync_accounts` row cannot be
   disconnected by a different member's request carrying the same provider name.
7. **Public unauthenticated writes** (`app/api/blog/{like,save}`,
   `app/api/ai/gift`, `app/api/push/test`): each is IP- or user-scoped and
   rate-limited (`enforceRequestRateLimit`), and `blog/save` correctly 401s
   with no session rather than falling back to a visitor id.
8. **`app/api/ai/{flyer,pantry-chef}`, `app/api/notifications/generate`**: all
   three derive `familyId` from `ctx.active.familyId` via `createServer()`
   (RLS-backed), never from the request body.

---

## Findings (prior session, preserved)

```
[CLAUDE-3][CRITICAL][DATABASE/AUTHZ] Every child can read, edit and delete the family password vault
File:     supabase/migrations/0119_family_credentials.sql:42-60 (family_credentials_* policies)
          app/(app)/dashboard/passwords/page.tsx:8-11
          components/modules/passwords-module.tsx:116-144
          lib/auth/mfa.ts:102-105
Problem:  public.family_credentials — the Wi-Fi / logins / PINs / card vault — is
          governed by four policies that all use is_family_member(family_id):

            family_credentials_select | SELECT | roles=public | qual=is_family_member(family_id)
            family_credentials_insert | INSERT | roles=public | check=~
            family_credentials_update | UPDATE | roles=public | qual=is_family_member(family_id)
            family_credentials_delete | DELETE | roles=public | qual=is_family_member(family_id)

          is_family_member() does not look at role:

            select exists (select 1 from public.family_members
              where family_id = p_family_id and user_id = auth.uid() and is_active);

          whereas can_manage_family() does (`role in ('parent','adult')`). Child
          members are real auth users with family_members.user_id set —
          app/(app)/family/child-login-actions.ts:49-60 creates the auth user and
          then `update({ user_id: childUserId, is_active: true })`. So a signed-in
          child passes is_family_member and the vault is fully open to them.

          The two guards that look like they stop this do not:
          - The page has no role check at all, only requireUserContext +
            requireAal2 (passwords/page.tsx:9-10).
          - requireAal2 is a no-op for children: needsStepUp() is
            `const manager = role === 'parent' || role === 'adult'; return manager && ...`
            (lib/auth/mfa.ts:103-104) — a child never needs step-up.
          - And neither guard is load-bearing anyway: passwords-module.tsx is
            'use client' and reaches family_credentials through createClient()
            (the browser Supabase client), so RLS is the only boundary.

          The column is plaintext: `secret:text`, no encryption on the write path
          (passwords-module.tsx:118 `secret: form.secret`).
Evidence: psql against the replayed schema:
            $ select policyname,cmd,qual from pg_policies
                where schemaname='public' and tablename='family_credentials';
            family_credentials_select | SELECT | is_family_member(family_id)
            ... (all four as quoted above)
            $ select column_name||':'||data_type from information_schema.columns
                where table_name='family_credentials';
            ... secret:text ...
          Contrast, same query on `documents`, which DOES encode the rule:
            documents_select | SELECT | (is_family_member(family_id) AND
              ((NOT is_sensitive_document(is_secure, category)) OR can_manage_family(family_id)))
Impact:   Any child with a username+PIN login can read every stored family
          secret in plaintext — Wi-Fi passwords, account logins, door PINs, card
          details — by opening /dashboard/passwords, or by issuing one PostgREST
          request with the public anon key. They can also silently DELETE the
          whole vault (the module's "delete" is a soft delete, but the policy
          permits a hard DELETE too). This is the single worst authorization gap
          I found.
Fix:      Mirror the `documents` pattern. Replace all four policies with
          can_manage_family(family_id) — there is no product reason a child
          writes to the credential vault:
            drop policy family_credentials_select on public.family_credentials;
            create policy family_credentials_select on public.family_credentials
              for select using (can_manage_family(family_id));
          (same for insert/update/delete). Then add the role check to
          app/(app)/dashboard/passwords/page.tsx so a child gets an honest page
          rather than an empty one, and open a separate item for encrypting
          `secret` at rest (the vault stores it in the clear today, so a
          service-role read or a DB dump is a full compromise).
Status:   VERIFIED (policies + helper functions read from the replayed schema;
          child membership path read in source). Not exploited against a live
          deployment — no credentials.
```

```
[CLAUDE-3][HIGH][AUTH] Step-up MFA is a page redirect only; no RLS policy knows about `aal`
File:     lib/auth/require-aal2.ts:76-79
          app/(app)/dashboard/bills/page.tsx:7, expenses/page.tsx:10, autopay/page.tsx:6,
          family-cfo/page.tsx:39, files/vault/page.tsx:14, files/shared/page.tsx:14,
          files/cloud/page.tsx:14, passwords/page.tsx:10, paperwork/page.tsx:19 (19 pages total)
          components/finance/bills-view.tsx:54,58,63,156
Problem:  requireAal2() protects 19 server-rendered pages by calling
          `redirect(stepUpPath)`. The data those pages show is not fetched by
          those pages. It is fetched by client components straight from
          PostgREST with the browser's own session:

            components/finance/bills-view.tsx:54
              const { error } = await createClient().from('bills').update({ status: next }).eq('id', b.id);
            components/finance/bills-view.tsx:63
              const { error } = await createClient().from('bills').delete().eq('id', id);
            components/modules/passwords-module.tsx:116
              const sb = createClient();

          An aal1 session (password only, no second factor) is a fully valid
          Supabase JWT. The redirect is the only thing that stops it, and the
          redirect only happens if the browser asks the Next.js server for the
          HTML page — which an attacker holding a stolen session cookie has no
          reason to do.

          The guard's own docstring anticipates the API half ("Route handlers
          use this to answer `403 step_up_required` where a page would
          redirect", require-aal2.ts:61-63) and `aal2Verdict` exists for it —
          but it is wired into exactly three routes (paperwork/capture,
          paperwork/link, privacy/export). Nothing in the `money` area uses it,
          and no route or policy enforces it on the direct-to-PostgREST path at
          all.
Evidence: $ grep -rn "aal2Verdict" app lib components
            app/api/paperwork/link/route.ts:21
            app/api/paperwork/capture/route.ts:19
            app/api/privacy/export/route.ts:46
            (+ its own definition and tests — nothing else)
          Against the replayed schema:
            $ select count(*) from pg_policies where schemaname='public'
                and (coalesce(qual,'')||coalesce(with_check,'')) ilike '%aal%';
            0
          And the policies on the tables the gated pages show:
            bills_select | SELECT | is_family_member(family_id)
            bills_update | UPDATE | can_manage_family(family_id)
          — role-aware, assurance-blind.
Impact:   Step-up MFA is presentational. Someone with a stolen or exported
          session cookie for a parent account — the precise threat a second
          factor is bought to answer — reads and writes bills, expenses,
          autopay, the document vault and the credential vault without ever
          being asked for a code. The families most likely to enrol a factor are
          the ones who believe it is protecting exactly this data.
Fix:      Two layers, both needed:
          (a) Enforce in the database, which is where the browser actually
              lands. Add a helper reading the JWT claim —
                create function public.session_is_aal2() returns boolean
                  language sql stable as $$
                    select coalesce(auth.jwt()->>'aal','aal1') = 'aal2' $$;
              — and AND it into the policies on the money/document tables for
              members whose account has a verified factor.
          (b) Have every route handler and server action behind a gated page
              call aal2Verdict() and answer 403 step_up_required, the way
              privacy/export already does (app/api/privacy/export/route.ts:46-48),
              so non-browser callers get the same answer.
          Until (a) exists, requireAal2 should not be described as protecting
          money or documents.
Status:   VERIFIED (grep + live catalogue query; the client-side write path read
          in source).
```

```
[CLAUDE-3][HIGH][STORAGE] The `family-media` bucket is public, so family photos and message attachments are served to anyone with the URL
File:     supabase/migrations/0216_family_media_bucket.sql:22-30
          components/modules/photos-module.tsx:116-123
          components/modules/inventory-module.tsx:37,355; components/modules/closet-module.tsx:43,415
Problem:  The bucket is created with `public = true`:
            insert into storage.buckets (id, name, public, file_size_limit)
            values ('family-media', 'family-media', true, 26214400)
          A public Supabase bucket is served at
          /storage/v1/object/public/family-media/<path> with no session and no
          RLS evaluation. The four family-scoped policies the same migration
          creates ("Family members can read their media", etc.) only govern the
          authenticated /object/ path, so they do not restrict delivery. The
          migration says so itself (lines 10-14, 26-30) and calls hardening a
          tracked follow-up (LB-009) — but the exposure is live now.

          Four features write here: Photos, Create-Memory, message attachments
          and reminder attachments (migration header, lines 4-5), and the stored
          rows keep the public URL (photos-module.tsx:123 `getPublicUrl`).
Evidence: $ select id||' public='||public from storage.buckets;   -- replayed schema
            documents public=false
            chore-proof public=false
            marketing-assets public=false
            avatars public=true
            marketplace-photos public=true
            feedback-attachments public=true
            family-media public=true
          The private `documents` bucket is the control: same family-folder path
          convention, `public=false`.
Impact:   Every family photo, video, private message attachment and reminder
          attachment is readable by anyone who ever obtains the URL, forever —
          past the point where the uploader deletes the row, leaves the family,
          or has their membership revoked, because revocation happens in
          family_members and the public path never consults it. URLs leak the
          ordinary ways: Referer headers, a link pasted anywhere, a CDN or proxy
          log, a scraped page. Paths are UUID-based so they are not enumerable —
          that is the only thing limiting this, and it is not an access control.
Fix:      Flip the bucket to `public=false` and serve through
          `createSignedUrl()` with a short TTL; the existing SELECT policy then
          becomes load-bearing rather than decorative. It needs the data
          migration of stored URLs that the migration comment names (rewrite
          family_photos / family_messages URL columns to store the storage path
          and resolve at render time), which is why this is a real piece of work
          and not a one-line flag flip — but it should be scheduled, not left as
          a comment.
Status:   VERIFIED (bucket flags read from the replayed schema; the decision is
          documented in-migration, the exposure is not disputed).
```

```
[CLAUDE-3][MEDIUM][DATABASE/AUTHZ] OAuth tokens in `social_account_tokens` are family-member readable; the equivalent `sync_tokens` is service-only
File:     supabase/migrations/0034_social_command_center.sql (social_account_tokens policies)
          supabase/migrations/0018_sync_platform.sql:663 (sync_tokens — the correct pattern)
Problem:  Two tables hold third-party OAuth credentials in identically named
          columns (access_token_enc, refresh_token_enc, scope, expires_at). They
          are protected completely differently:

            sync_tokens            | tokens service only          | ALL    | qual=false  | check=false
            social_account_tokens  | social_account_tokens_select | SELECT | qual=is_family_member(family_id)
            social_account_tokens  | social_account_tokens_insert | INSERT | check=is_family_member(family_id)
            social_account_tokens  | social_account_tokens_update | UPDATE | qual=is_family_member(family_id)
            social_account_tokens  | social_account_tokens_delete | DELETE | qual=is_family_member(family_id)

          `qual=false` is the right answer for a token table: no client role
          reads it, only the service role (which bypasses RLS). The social table
          allows any active family member — including a child — to SELECT the
          stored tokens and to UPDATE them with values of their choosing.
Evidence: $ select policyname,cmd,qual,with_check from pg_policies
              where schemaname='public' and tablename in ('sync_tokens','social_account_tokens');
          (output as quoted above, from the replayed schema)
Impact:   Latent rather than live: no application code reads or writes
          social_account_tokens today — the only references are
          lib/ai/context/policy.ts:39 (which denylists it from AI context,
          reason 'OAuth tokens') and lib/database.types.ts. So the table is
          empty in practice. The moment the Social Command Center is connected
          to a real provider, a child in the household can exfiltrate the
          parent's social access and refresh tokens with one anon-key request,
          or overwrite them to point at an account they control.
Fix:      Bring it to the sync_tokens standard before the feature ships:
            drop policy social_account_tokens_select on public.social_account_tokens;
            ... (all four)
            create policy "social tokens service only" on public.social_account_tokens
              for all using (false) with check (false);
          If a family-facing read is ever needed, expose connection *status*
          from social_accounts, never the token columns.
Status:   VERIFIED (policies read from the replayed schema; "unused today"
          confirmed by grep across app/, lib/, components/).
```

```
[CLAUDE-3][MEDIUM][STORAGE] `feedback-attachments` is a public bucket holding user-uploaded screenshots
File:     supabase/migrations/0197_feedback_ideas.sql:163,173
Problem:  The bucket is `public=true` and additionally carries an explicit
          `for select using (bucket_id = 'feedback-attachments')` policy (line 173)
          with no owner condition — so it is world-readable by both the public path and
          the authenticated path. Writes are correctly scoped
          (line 178: `auth.uid()::text = (storage.foldername(name))[1]`); reads are
          not scoped at all.
Evidence: $ select id||' public='||public from storage.buckets;
            feedback-attachments public=true
          $ select policyname,cmd,qual from pg_policies where schemaname='storage';
            objects | Feedback attachments are publicly readable | SELECT | (bucket_id = 'feedback-attachments'::text)
Impact:   Feedback attachments are, by their nature, screenshots of the app
          taken at the moment something went wrong — which is to say screenshots
          of a real family's calendar, children's names, balances or documents.
          Anyone with the URL, and anyone who can list the bucket, reads them.
          Lower than family-media only because the volume is small and the
          upload is deliberate.
Fix:      Make the bucket private and drop the blanket SELECT policy; replace it
          with `auth.uid()::text = storage.foldername(name)[1] OR is_super_admin()`
          so the reporter and the admin triaging the report can see it and
          nobody else. Admin console reads already go through the service role,
          so they are unaffected.
Status:   VERIFIED (bucket flag + policy read from the replayed schema).
```

```
[CLAUDE-3][MEDIUM][SECRETS] The Contact Center inbound-email secret is accepted in the query string
File:     app/api/contact-center/email/route.ts:33-38
Problem:  function authorized(req: NextRequest): boolean {
            const secret = process.env.CONTACT_CENTER_INBOUND_SECRET;
            if (!secret) return process.env.NODE_ENV !== 'production';
            const provided = new URL(req.url).searchParams.get('key') ?? req.headers.get('x-inbound-secret');
            return !!provided && provided === secret;
          }
          The fail-closed half is right (an unset secret disables the route in
          production, exactly as lib/auth/route-access.ts:104-106 claims). The
          problem is `?key=<secret>`: a long-lived shared secret travelling in a
          URL is written verbatim into platform access logs, any proxy or WAF in
          front of the deployment, and error-tracking breadcrumbs, and is the
          one part of a request most likely to be pasted into a ticket.
Evidence: The code above; the header alternative already exists on the next line,
          so the query-string branch is a convenience, not a requirement.
Impact:   Whoever can read the deployment's HTTP logs can replay inbound email
          into any family's Contact Center — injecting messages that appear to
          come from outside. Rotation is the only remedy once it has leaked, and
          nothing will signal that it has.
Fix:      Drop the searchParams branch; require `x-inbound-secret`. If the email
          provider cannot send a custom header, put an unguessable random
          segment in the *path* and treat that as the capability (the pattern
          /api/sync/feeds/[token] already uses), so at least it is per-route and
          rotatable without touching every other caller.
Status:   OPEN — confirmed in source. Whether the configured provider can send a
          header is an operator question; that answer decides which fix applies.
```

```
[CLAUDE-3][MEDIUM][AUTH] Twilio signature verification is switched off outside production, and depends on NEXT_PUBLIC_APP_URL being exactly right
File:     app/api/guardian/inbound/sms/route.ts:27-33 (and voice:34, whatsapp:35,
          screen:39, status/voicemail:32, escalate/twiml:17-22,
          app/api/contact-center/{voice,sms,voice/transcription}/route.ts)
Problem:  All nine Twilio-facing webhooks share one shape:
            if (process.env.NODE_ENV === 'production') {
              const sig = req.headers.get('x-twilio-signature') ?? '';
              const url = `${BASE_URL}/api/guardian/inbound/sms`;
              if (!validateTwilioSignature(sig, url, params)) return new NextResponse('Unauthorized', { status: 401 });
            }
          Two consequences.
          (a) Outside production the check is skipped entirely — there is no
              signature check at all in any preview, staging or self-hosted
              deployment that does not set NODE_ENV=production. These routes are
              on the PUBLIC list, so they are reachable with no session, and
              they write to guardian tables and fan out SMS/voice.
          (b) `BASE_URL` is `process.env.NEXT_PUBLIC_APP_URL ?? ''`. Twilio signs
              the exact URL it called. If NEXT_PUBLIC_APP_URL is unset, has a
              trailing slash, or differs from the public hostname Twilio was
              configured with, every signature mismatches and every callback
              401s — Guardian and the Contact Center go silently dead with a
              "provider problem" shape, which is exactly the failure mode
              lib/auth/route-access.ts:95-106 was written about.
          The HMAC itself is correct (sha1 over url + sorted params,
          timingSafeEqual, returns false when TWILIO_AUTH_TOKEN is unset —
          lib/guardian/twilio.ts:130-146).
Evidence: The nine call sites, identical; lib/guardian/twilio.ts:134
          `if (!TWILIO_AUTH_TOKEN) return false;`
Impact:   (a) is a security gap in every non-production deployment: unauthenticated
          POSTs can forge inbound calls/messages and trigger scam-detection,
          notifications and outbound SMS. (b) is an availability trap that
          fails closed, so it is safe but invisible.
Fix:      (a) Invert the condition: verify whenever TWILIO_AUTH_TOKEN is set,
              and skip only when it is absent (which is the honest definition of
              "Twilio is not configured here"). That keeps local development
              working without leaving preview deployments open.
          (b) Derive the signed URL from the request the platform actually
              received (x-forwarded-proto + x-forwarded-host, falling back to
              NEXT_PUBLIC_APP_URL) and log a distinguishable reason on mismatch,
              so a misconfigured hostname says so instead of looking like a bad
              signature.
Status:   OPEN — confirmed in source at all nine call sites. Which deployments
          run with NODE_ENV != 'production' is an operator question.
```

```
[CLAUDE-3][LOW][AUTH] Shared-secret comparisons are not constant time
File:     lib/server/cron-auth.ts:5-11
          app/api/guardian/escalate/route.ts:24-28
          app/api/contact-center/email/route.ts:37
Problem:  export function hasCronAuthorization(req: Request, secret = process.env.CRON_SECRET): boolean {
            return !!secret && req.headers.get('authorization') === `Bearer ${secret}`;
          }
          `===` on strings short-circuits at the first differing byte. The same
          applies to the guardian escalate check (`authHeader !== \`Bearer ${secret}\``)
          and the contact-center `provided === secret`. The Twilio path already
          does this correctly with crypto.timingSafeEqual
          (lib/guardian/twilio.ts:143).
Problem2: Noted, not alarmed about: extracting a secret through remote timing
          over HTTP against a serverless platform is not a practical attack.
          This is a consistency finding — the codebase already owns the right
          primitive and uses it three files away.
Evidence: The three call sites above; lib/guardian/twilio.ts:143 as the
          in-repo counter-example.
Impact:   Theoretical. Recorded so it is a deliberate decision rather than an
          oversight, since these three secrets gate every cron job, the
          emergency escalation fan-out, and inbound email respectively.
Fix:      One helper, used by all three:
            import { timingSafeEqual } from 'crypto';
            export function secretMatches(provided: string | null, expected: string | undefined): boolean {
              if (!provided || !expected) return false;
              const a = Buffer.from(provided), b = Buffer.from(expected);
              return a.length === b.length && timingSafeEqual(a, b);
            }
          The fail-closed-on-missing-secret behaviour must be preserved exactly;
          it is the more important property and it is already correct.
Status:   OPEN
```

```
[CLAUDE-3][LOW][API] An authorization failure in the marketing AI route answers 500, not 403
File:     app/api/admin/marketing/ai/route.ts:87-91
Problem:  } catch (err) {
            console.error('Marketing AI error:', err);
            const msg = err instanceof Error && err.message.includes('Forbidden') ? 'Forbidden' : 'Could not generate. Check that the OpenAI API key is set.';
            return NextResponse.json({ error: msg }, { status: 500 });
          }
          requireMarketingAdmin() throws to refuse. The catch recognises the
          refusal well enough to change the message but still answers 500 —
          and requireMarketingAdmin's messages are the 'sign in' / 'permission'
          strings the sibling route matches on
          (app/api/admin/marketing/email/send/route.ts:48), not 'Forbidden', so
          in practice a non-admin caller is told "Check that the OpenAI API key
          is set" with a 500.
Evidence: The two routes side by side; send/route.ts:48-52 gets it right
          (403 for forbidden, 502 for provider, 400 otherwise).
Impact:   No access is granted — the request is refused either way. The cost is
          operational: a permissions problem is indistinguishable from an outage
          in logs and alerting, and it points the operator at the wrong
          subsystem.
Fix:      Match the sibling: detect the refusal on the same
          'sign in' | 'permission' | 'Forbidden' predicate and answer 403,
          leaving 500 for genuine faults. Better, give requireMarketingAdmin a
          typed error so neither route has to match on message text.
Status:   OPEN
```

---

## Verified healthy — do not re-spend effort here

Recorded because each of these was a live hypothesis on my brief and each is now
closed by a query against the replayed schema or an exhaustive read, not a
sample. If a later pass wants to re-open one, the command is given.

1. **RLS coverage is total.** All 482 tables in `public` have
   `relrowsecurity = true`.
   `select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and relkind='r' and not relrowsecurity;`
   → **empty**. A text scan of the migrations suggests 216 tables are missing
   RLS; that is an artefact of the `DO $$ ... EXECUTE format(...)` loops the repo
   uses (0004, 0006, 0009, 0022, 0034, 0037, 0070, 0088, 00901, …) and is wrong.

2. **No `using (true)` on any family-scoped table.** Across every permissive
   policy granted to `anon` / `authenticated` / `public`, exactly four have a
   literally-true expression, and all four are global reference data:
   `badges`, `feature_flags`, `meal_ideas`, `service_descriptions` — all
   SELECT-only.

3. **`anon` holds no write privilege on any table at all** (not just the five
   money tables of F-003): the `role_table_grants` query for
   INSERT/UPDATE/DELETE/TRUNCATE to `anon` returns zero rows across all 482.

4. **Every `app/api` route authorizes itself.** All 141 handlers were mapped to
   their guard. The 61 routes carved out of the session boundary by
   `route-access.ts` PUBLIC each carry their own: 23 cron routes +
   /api/concierge-calls/place on `hasCronAuthorization` (fail-closed —
   `!!secret && ...`), 9 Twilio routes on signature (but see the MEDIUM above),
   3 webhook routes on provider signatures, /api/email/welcome on
   `hasInternalSecret`, the token-capability routes (/api/sync/feeds/[token],
   /api/assistant, /api/ai/gift, /api/blog/unsubscribe,
   /api/marketing/unsubscribe) on the token itself plus a rate limit, and every
   public telemetry/form endpoint on `enforceRequestRateLimit` +
   `readBoundedRequestJson`. The two `app/api/admin/*` routes that showed no
   guard in a first grep both call `requireMarketingAdmin`; the third,
   `admin/benchmarks/export`, re-checks `isSuperAdmin()` in the handler
   precisely because a route handler is not covered by the /admin layout
   (benchmarks/export/route.ts:19-20).

5. **No unbounded request-body parsing anywhere.**
   `grep -rn "await req.json()" app lib` → **0 hits**. Every handler that reads a
   body goes through `readBoundedRequestJson` / `readBoundedRequestText` /
   `readBoundedRequestFormData` with an explicit byte cap.

6. **No secrets in client-reachable config.** The complete set of
   `NEXT_PUBLIC_*` in use is APP_URL, BUILD_ID, SITE_URL,
   STRIPE_PUBLISHABLE_KEY, SUPABASE_ANON_KEY, SUPABASE_URL, VAPID_PUBLIC_KEY,
   VERCEL_GIT_COMMIT_SHA — all eight are publishable by design. No `.env` file
   is committed (only `.env.example`).

7. **No secrets or PII in logs.** The `console.*` sweep for token/secret/
   password/pin/key/jwt/session/email surfaced six hits, all benign: two log an
   internal session id, one logs a lead email inside a cron failure path
   (app/api/cron/journey-recovery/route.ts:94 — arguably worth trimming), and
   the rest are subject lines in the "email skipped, no API key" dev notice.

8. **No SQL injection surface.** Every `EXECUTE format(...)` in the migrations
   uses `%I` / `%1$I` identifier quoting over a literal `array[...]` of table
   names — never a value from a request. No string-interpolated SQL in
   application code.

9. **No SSRF.** The only raw `fetch()` with a computed URL on the server
   (app/api/weekend/discover/route.ts:20) is called with two hard-coded provider
   hosts and a `isValidZip`-validated query. Every user-supplied URL —
   library feeds, calendar feeds, documents, media — goes through the guarded
   `lib/server/{external,public-calendar,public-document,public-media}-fetch.ts`
   helpers, which carry the blocked-subnet list, DNS pinning and a redirect
   budget.

10. **`SECURITY DEFINER` functions are sound.** All 64 were dumped and their
    EXECUTE grants resolved. Every one callable by `anon` is either a trigger
    function (not invocable through PostgREST) or a predicate helper; every
    state-changing RPC re-derives the caller's identity internally
    (`is_family_member`, `marketplace_member_id`, `auth.uid()`) and raises
    rather than trusting an argument — e.g. `grocery_from_meal_plan` opens with
    `if not public.is_family_member(p_family_id) then raise exception`, and
    `marketplace_accept_offer` with `if v_caller is null or v_listing.member_id
    is distinct from v_caller then raise exception`.

11. **Tables with RLS on and zero policies are deliberate, not broken.** 57 such
    tables exist (marketing_*, mkt_*, stripe_webhook_events, super_admins,
    rate_limits, survey_responses, …). Each was spot-checked for an application
    read path: all are reached only through `createServiceClient()`. "No policy"
    is the service-only idiom here, same as `sync_tokens`' explicit
    `using (false)`.

12. **Server actions are guarded.** Of 132 files containing `'use server'`, 8
    make no auth call; 5 of those are not action files at all (the string
    appears in a comment), and the 3 real ones are the deliberately
    unauthenticated public flows — gift pledge, public review submission, public
    survey response — each of which uses the service client behind an
    unguessable token plus `enforceRequestRateLimit` (app/gift/actions.ts:30-45
    additionally caps pending pledges per link at 25).

---

## What I could not reach

- **Production.** Every schema statement above is from the local replay of the
  committed migrations. `finalaudit.md` F-001 says the production ledger records
  only `0001–0003`, which — if still true — means the production database does
  not have most of the policies I verified, including the ones I am calling
  correct. Nothing here should be read as a statement about production until
  F-001 is unblocked. This cuts both ways: the CRITICAL above may be *worse* in
  production, not better.
- **Migrations 0237, 0239, 0292** did not replay (the `vector` extension is not
  installed locally), so the `marketing_generation_jobs` /
  `marketing_page_embeddings` tables from the marketing platform spine are
  absent from my schema and were not checked for RLS or policies. Everything
  else replayed.
- **No live requests were made.** No credentials, and the brief is audit-only. A
  one-line curl with a child's anon-key JWT against
  `/rest/v1/family_credentials?select=*` would settle the CRITICAL finding
  empirically in production; I did not have a session to do it with.

---

# Findings from the parallel audit session (merged 2026-09-13T23:51Z)

Two audit sessions ran against this repository at the same time. Both
wrote to this path, so git saw an add/add conflict. **Neither side is
discarded** — the rule is that no worker's findings are deleted, and that
applies across sessions as much as within one. The other session's file
follows verbatim; it uses a different finding format, which is left as it
was written rather than reformatted.

# Claude-3 — Backend / API / Database / Auth / Security

Owned by Claude-3. No other worker writes findings here.

Created by Claude-1 as an empty template so the file exists for you; nothing
below the line is authored by anyone but you.

## Finding format

    [CLAUDE-3][SEVERITY][AREA] Short title
    - **File/path:**
    - **Problem:**
    - **Evidence:**            <- a command, output, probe or measurement
    - **Impact:**
    - **Recommended fix:**
    - **Status:** OPEN | VERIFIED | FIXED | BLOCKED

Severities: CRITICAL, HIGH, MEDIUM, LOW.
Evidence means something reproducible. "Looks wrong" is not a finding.

Before modifying any source file, check `audit/status.md` FILES-TOUCHED for
every other worker. If someone else holds it, audit it and record a
recommendation instead of editing.

---

## Findings

_(none yet)_

---
---

# Session 3 (2026-09-14) — the pgvector replay and the marketing platform spine

**Appended, not merged.** Everything above this delimiter is left exactly as the
two earlier sessions wrote it. This section closes one named gap and, in doing
so, **contradicts one of my own earlier "verified healthy" items** — that
contradiction is recorded here rather than by editing the claim above.

CURRENT: done — `0237` / `0239` / `0292` replayed, marketing platform spine
  audited against the live catalogue, a sample of Pass E re-verified
COMPLETED:
  - pgvector is installed, so for the first time **all 310 migrations applied
    with zero failures** (`docs/audit/verify-pg.sh up`). Every prior pass ran
    against a schema missing the nine spine tables.
  - Audited the nine tables `0237` creates for RLS / FORCE RLS / policies /
    grants / SECURITY DEFINER / search_path, against `pg_policies`,
    `information_schema.role_table_grants` and `pg_proc` — plus behavioural
    probes as `anon` and as an ordinary `authenticated` user.
  - Exercised the spine's trigger and job-queue machinery, which had never
    executed anywhere before (enqueue, `0239`'s backfill suppression, stale-lock
    recovery, dead-letter at `max_attempts`).
  - Ran the repo's own gates against the complete schema: **18/18 boundary
    probes pass** (including `privileged-rpc-grants-check.sql`, which could
    never run before because `0292` never applied), and
    `scripts/check-conflict-targets.mjs` passes at 181 targets / 491 tables.
  - Re-verified six Pass E claims. Four confirmed, **one refuted**
    (verified-healthy #3), **one no longer holds** (F-E04, fixed by `0297`).
  - 4 findings: 2 MEDIUM, 2 LOW. 13 new verified-healthy items.
NEXT: nothing queued.
FILES-TOUCHED: `audit/claude-3.md` only. **No application source, no migration,
  no other audit file was modified.** Scratch work under
  `/tmp/claude-0/.../scratchpad/` and the throwaway database at
  `/tmp/pgaudit_db` (port 54399), both outside the repo.
BLOCKERS:
  - **Production, still.** Every statement below is the committed migrations
    replayed locally. `finalaudit.md` F-001/F5/F-C08 say there is no working
    path to apply a migration to production, so production may carry none of
    this schema. Not verifiable without operator credentials.
LAST-UPDATE: 2026-09-14

---

## The replay, so the evidence below is reproducible

```
$ bash docs/audit/verify-pg.sh up
== shims ==
== migrations ==
== migrations applied: 310, failed: 0 ==
== bootstrap complete: anchor_family=00000000-0000-4000-8000-0000000000f1 ==
== harness up: db=bubaly host=/tmp/pgaudit_db port=54399 ==

$ psql -qAt -c "select extname, extversion, n.nspname from pg_extension e
                join pg_namespace n on n.oid=e.extnamespace where extname='vector';"
vector|0.6.0|extensions

$ psql -qAt -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
                where n.nspname='public' and c.relkind='r';"
491
```

**310 applied, 0 failed** — against Pass E's "308 applied, 3 failed". 491 public
tables against 482. The nine tables that were missing are exactly the spine:
`marketing_pages`, `marketing_page_versions`, `marketing_content_templates`,
`marketing_brand_rules`, `marketing_generation_jobs`,
`marketing_page_relationships`, `marketing_embeddings`,
`marketing_provider_observations`, `marketing_provider_syncs`.

I used the repository's own harness rather than a hand-rolled prelude. That is
deliberate, and it is the reason finding C3-S3-02 below exists: Pass E built its
own Supabase-shaped prelude, and a prelude that does not reproduce Supabase's
default privileges produces a boundary result that is **safer than production** —
the same defect `finalaudit.md` F-004 records against the old CI shim.

---

## Findings

```
[CLAUDE-3][MEDIUM][DATABASE] anon and authenticated hold TRUNCATE on all nine
                             marketing-spine tables, and RLS does not constrain
                             TRUNCATE
File:     supabase/migrations/0237_marketing_platform_spine.sql:236-248 (the grant block)

Problem:  0237 reasons about the grant layer explicitly — its own comment reads
          "RLS is authorization, not table privilege. Keep the public surface
          narrow" — and it does revoke from `authenticated` on one table:

            grant select on public.marketing_page_versions to authenticated;
            revoke insert, update, delete on public.marketing_page_versions
              from authenticated;

          It never revokes anything from `anon`, and it never revokes TRUNCATE
          from anyone. Supabase's default privileges (`alter default privileges
          in schema public grant all on tables to anon, authenticated,
          service_role`) mean every table the migration creates carries
          `arwdDxt` for `anon` from the moment it exists.

          For INSERT / UPDATE / DELETE that does not matter: RLS refuses them,
          and I verified that it does. **TRUNCATE is different — PostgreSQL does
          not apply row-level security to TRUNCATE at all.** The grant is the
          only thing in the way, and it is open.

Evidence: 1. The grants, from the live catalogue (not the SQL text):

   $ psql -c "select table_name, grantee, string_agg(privilege_type,', ' order by privilege_type)
              from information_schema.role_table_grants
              where table_schema='public' and grantee in ('anon','authenticated')
                and table_name in (<the nine spine tables>)
              group by 1,2 order by 1,2;"

              table_name           |    grantee    |                          privs
   -------------------------------+---------------+---------------------------------------------------------------
    marketing_brand_rules         | anon          | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
    marketing_brand_rules         | authenticated | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
    marketing_content_templates   | anon          | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
    marketing_embeddings          | anon          | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
    marketing_generation_jobs     | anon          | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
    marketing_page_relationships  | anon          | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
    marketing_page_versions       | anon          | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
    marketing_page_versions       | authenticated | REFERENCES, SELECT, TRIGGER, TRUNCATE          <-- the revoke landed
    marketing_pages               | anon          | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
    marketing_provider_observations | anon        | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
    marketing_provider_syncs      | anon          | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
   (27 rows over the nine tables)

   Note `marketing_page_versions`/`authenticated`: the author WAS thinking about
   the grant layer on that one line, and still left `anon` untouched and TRUNCATE
   in place on all nine.

2. RLS holds for the DML — each statement in its own transaction, rolled back:

   anon           INSERT marketing_pages             DENIED  -> ERROR: new row violates row-level security policy for table "marketing_pages"
   anon           UPDATE marketing_pages (published) 0 rows changed (USING filtered everything)
   anon           DELETE marketing_pages             0 rows deleted
   anon           INSERT marketing_generation_jobs   DENIED  -> ERROR: new row violates row-level security policy
   anon           INSERT marketing_brand_rules       DENIED  -> ERROR: new row violates row-level security policy
   authenticated  (same five, same results — the anchor user is not a super admin)

3. TRUNCATE is not filtered, and it succeeds:

   begin;
     select count(*) as pages_before from public.marketing_pages;   -- 2
     set local role anon;
     truncate table public.marketing_pages cascade;
     NOTICE:  truncate cascades to table "marketing_page_versions"
     NOTICE:  truncate cascades to table "marketing_page_relationships"
     TRUNCATE TABLE
     reset role;
     select count(*) as pages_after_anon_truncate from public.marketing_pages;   -- 0
   rollback;

   The same succeeds as `anon` on all nine, and on `marketing_audit_logs`
   (the spine's own audit trail, RLS on with zero policies).

Reachability (stated plainly, because it bounds the severity):
   This is NOT reachable through PostgREST today. PostgREST maps HTTP verbs to
   SELECT/INSERT/UPDATE/DELETE and `rpc/`; it has no TRUNCATE verb. I checked the
   two RPC paths that could launder one:

     -- functions whose body truncates, and who may execute them
     select p.proname, p.prosecdef, has_function_privilege('anon',p.oid,'EXECUTE')
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.prosrc ~* 'truncate';
     (0 rows)

     -- SECURITY INVOKER dynamic-SQL functions anon may call
     select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.prosrc ~* 'execute format'
       and has_function_privilege('anon',p.oid,'EXECUTE')
       and not p.prosecdef and p.prorettype <> 'trigger'::regtype;
     0

   So this is a missing layer, not a live exploit — exactly the disposition
   `0290` took for the money tables, and for the same reason.

Impact:  The entire public marketing content spine, its version history, its
         AI job queue, its embeddings and its admin audit trail can be emptied
         by a single statement that RLS is architecturally unable to see. Any
         future SQL-execution primitive — an injection, a leaked `authenticator`
         connection, a psql session opened with the anon role — destroys the
         marketing site's content and the record of who changed it, with no row
         to restore from because `marketing_page_versions` cascades with it.
         `marketing_audit_logs` is the table that would otherwise say what
         happened, and it goes too.

Fix:     One migration in `0290`'s exact shape, at the end of the chain (0292's
         lesson: a lockdown must be re-asserted where the chain ends, because a
         later `create table if not exists` or a re-created object can hand the
         default privileges back). For each of the nine tables plus
         `marketing_audit_logs`:

           revoke insert, update, delete, truncate on public.<t> from anon;
           revoke truncate                          on public.<t> from authenticated;

         Keep `select` on `marketing_pages` and `marketing_page_relationships`
         for anon — those two have deliberate public-read policies and the
         public site reads them with the anon key (lib/marketing/seo.ts,
         lib/marketing/aeo.ts, lib/marketing/public-pages.tsx). Nothing
         legitimate loses a write: every admin path goes through
         `createServiceClient()` behind `requireMarketingAdmin()`, and
         `service_role` is `bypassrls` and keeps its grants.

         Close it with a verification DO block like 0290's and 0292's, asserting
         `has_table_privilege('anon','public.<t>','TRUNCATE')` is false for all
         ten, so the next migration that re-creates one of these is caught.

         CI will not object: `tests/migrations-are-additive.test.ts:28-38`
         already masks the TRUNCATE *privilege* inside a `revoke … on … from`
         list precisely so 0290's shape passes the bare `\btruncate\b` scan.

Status:  OPEN (VERIFIED locally — reproduced end to end against the replay)
```

```
[CLAUDE-3][MEDIUM][DATABASE] CONTRADICTS my own Pass E verified-healthy #3:
                             anon holds write grants on 483 of 491 tables, not zero
File:     audit/claude-3.md:463-467 (the claim), and the platform generally

Problem:  Pass E recorded, in the list explicitly written so later workers would
          NOT re-check it:

            "3. anon holds no write privilege on any table at all (not just the
             five money tables of F-003): the role_table_grants query for
             INSERT/UPDATE/DELETE/TRUNCATE to anon returns zero rows across all
             482."

          That is false. Re-running the same query against the complete replay
          returns 1,931 rows. The claim was an artefact of the prelude Pass E
          built by hand (`/var/tmp/pgaudit`, port 5599), which did not reproduce
          Supabase's default privileges — the identical defect `finalaudit.md`
          F-004 records against the old CI shim, made a second time in the
          harness written to check the first one.

          `finalaudit.md` F-003 names the mechanism correctly ("Supabase's
          default privileges grant arwdDxt on every new public table to anon,
          and no migration revoked it") but `0290` closes it for **five money
          tables**. Nobody measured what was left. This is that measurement.

Evidence: Pass E's own query, verbatim, against the 310-migration replay:

   $ psql -qAt -c "select count(*) from information_schema.role_table_grants
                   where table_schema='public' and grantee='anon'
                     and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE');"
   1931

   $ psql -qAt -c "select privilege_type, count(distinct table_name)
                   from information_schema.role_table_grants
                   where table_schema='public' and grantee='anon'
                     and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
                   group by 1 order by 1;"
   DELETE|483
   INSERT|482
   TRUNCATE|483
   UPDATE|483

   The eight tables where a migration DID revoke — the complete list:

   $ psql -c "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
              where n.nspname='public' and c.relkind='r'
                and not exists (select 1 from information_schema.role_table_grants g
                  where g.table_schema='public' and g.table_name=c.relname
                    and g.grantee='anon' and g.privilege_type in ('INSERT','UPDATE','DELETE'))
              order by 1;"
     child_wallets
     family_wallets
     finance_transaction_operation_receipts
     move_date_recalculations
     vacation_confirmation_imports
     wallet_buckets
     wallet_rules
     wallet_transactions
   (8 rows)

Impact:  Two distinct harms.
         (a) **The record is wrong in the direction that stops work.** A
             verified-healthy entry is a licence for the next worker not to
             look. This one licenses not looking at 483 tables.
         (b) The substantive exposure is the same one as the finding above,
             platform-wide: RLS covers the DML, TRUNCATE is outside RLS on 483
             tables, and the only reason nothing burns is that no TRUNCATE path
             is reachable through PostgREST. That is one stray permissive policy
             `TO public` (the shape `0275` had to sweep off the money tables)
             away from mattering for the DML too.

Fix:     1. Claude-1: strike or annotate verified-healthy #3 when merging — it
            must not read as checked-and-clean. I have not edited the claim
            above, per the append-only rule.
         2. Treat the residue as a sweep, not a one-off: a migration that
            revokes `insert, update, delete, truncate` from `anon` on every
            `public` table that has no permissive policy naming `anon`, with a
            verification block that fails if any remain. The nine spine tables
            and `marketing_audit_logs` are the urgent subset (finding above);
            the rest is the same shape at lower pressure.
         3. The durable fix is the one `0292` models: assert the end-state, not
            the state at the migration's own moment. A
            `docs/audit/anon-write-grants-check.sql` probe would make this a CI
            gate instead of a thing someone has to remember.

Status:  OPEN (VERIFIED — Pass E's own query, re-run, returns 1931)
```

```
[CLAUDE-3][LOW][DATABASE] The marketing platform spine has no boundary probe,
                          so CI cannot see it regress
File:     docs/audit/*-check.sql (the eighteen that exist), .github/workflows/ci.yml:203

Problem:  The Database CI job globs `docs/audit/*-check.sql` and every boundary
          this repository cares about has one — the money tables, the document
          vault, the password vault, cross-family isolation, the privileged
          RPCs, the AI surface, the household trail. The nine spine tables have
          none. `0237` leaves its verification as a SQL comment at the bottom of
          the file ("Production verification (run after `supabase db push`)"),
          which nothing runs.

          That is how this gap stayed open for 55 migrations: the spine's
          authorization has never been asserted by anything that can go red.

Evidence: $ bash docs/audit/run-probes.sh
          PASS  ai-surface-role-privacy-check.sql
          PASS  approval-dedupe-check.sql
          PASS  dead-letter-reconcile-check.sql
          PASS  document-vault-boundary-check.sql
          PASS  family-credentials-boundary-check.sql
          PASS  family-delete-cascade-check.sql
          PASS  family-facts-provenance-check.sql
          PASS  family-scoped-index-check.sql
          PASS  family-self-read-check.sql
          PASS  household-trail-check.sql
          PASS  money-write-boundary-check.sql
          PASS  privileged-rpc-grants-check.sql
          PASS  reward-redemption-decision-check.sql
          PASS  rls-isolation-check.sql
          PASS  sensitive-role-boundary-check.sql
          PASS  wallet-concurrency-check.sql
          PASS  wallet-overspend-check.sql
          PASS  wallet-write-rls-check.sql
          == probes: 18/18 passed ==

          $ ls docs/audit/ | grep -i marketing
          (no output)

          Note `privileged-rpc-grants-check.sql` in that list: it asserts
          `claim_marketing_generation_jobs` is service-role only, and **this is
          the first time it has ever run**, because it needs 0292, which needs
          0237, which needed pgvector. It passes. But it is the only line of
          spine coverage in the whole probe suite, and it covers one function.

Impact:  Every assertion in the two findings above is a thing a human ran once.
         The next migration that re-creates one of these tables, or a policy
         edited to `TO public`, or a grant handed back by Supabase's default
         privileges, lands green.

Fix:     Add `docs/audit/marketing-spine-boundary-check.sql` asserting, with
         RAISE EXCEPTION so ON_ERROR_STOP makes it red:
           - all nine tables have `relrowsecurity`;
           - as `anon`: a draft page is invisible, a published one is visible,
             INSERT/UPDATE/DELETE are refused on all nine;
           - as a non-super-admin `authenticated` user: zero rows on all nine
             except the published page;
           - as a super admin: full read/write (the positive control, without
             which the probe passes for the wrong reason);
           - `has_table_privilege('anon', <t>, 'TRUNCATE')` is false for all
             nine (this is what would have caught the finding above);
           - `has_function_privilege('anon'|'authenticated',
             'public.claim_marketing_generation_jobs(integer)','EXECUTE')` is
             false.
         Per this repo's own standard (finalaudit F-004, and Claude-1's note on
         the board about guards that cannot fail): prove it non-vacuous by
         breaking each assertion once and confirming it goes red.

Status:  OPEN
```

```
[CLAUDE-3][LOW][DATABASE] The regeneration-loop guard tests the column's value,
                          not whether the statement set it
File:     supabase/migrations/0237_marketing_platform_spine.sql:277-283, 316-320
          supabase/migrations/0239_marketing_backfill_queue_cleanup.sql:15-38

Problem:  0237 says what the guard is for: "Worker writes leave updated_by null
          so they do not recursively enqueue themselves." Both triggers
          implement it as `new.updated_by is not null` — the value ON THE ROW
          after the update, not "did this statement assign updated_by".

          `updated_by` is a persisted column. Once an admin has edited a page it
          stays non-null forever. So any writer that updates a tracked column
          and simply OMITS `updated_by` bumps the version and enqueues another
          `regenerate_page` job — whose worker rewrites the page, which is
          another update.

          **No shipped caller does this today**, which is why this is LOW and
          not a live defect. It holds only because every writer sets the column
          explicitly, and the one that matters does so on purpose:
          `lib/marketing/platform.ts:268` writes `updated_by: null` in the
          worker's write-back. The safety of the whole queue rests on that one
          line, and nothing states the requirement or tests it.

Evidence: Faithful worker path — clean:

   -- admin insert + admin edit
   version_after_admin_edit = 2 ; jobs_after_admin_edit = 2
   -- worker write-back, exactly as platform.ts:261-269 does it
   update public.marketing_pages set body='ai body', updated_by=null where id=…;
   version_after_worker_writeback   = 2      <-- no bump
   jobs_after_worker_writeback      = 2      <-- no new job

   A writer that merely omits the column, on the same already-edited row:

   update public.marketing_pages set body='b2' where id=…;   -- no updated_by
   update public.marketing_pages set body='b3' where id=…;   -- no updated_by
   version_after_two_omitting_writes  = 4    <-- +2
   jobs_after_two_omitting_writes     = 4    <-- +2 regenerate_page jobs

   Each of those jobs is an AI generation call (`generateWithAI`,
   lib/marketing/platform.ts:256). finalaudit F19 records that AI endpoints run
   unmetered.

Impact:  Latent. A future writer to `marketing_pages` that does not know about
         the `updated_by` convention starts a self-feeding AI rewrite loop on
         the public marketing site, billed per iteration. The trigger comment
         asserts a protection the trigger does not actually provide.

Fix:     Make the guard say what it means. Either compare against the old row —
         `new.updated_by is not null and new.updated_by is distinct from
         old.updated_by` — or, better, key the enqueue on an explicit marker the
         worker controls rather than on an audit column that happens to be null.
         Whichever is chosen, a comment on `platform.ts:268` saying that
         `updated_by: null` is load-bearing, and a test that fails if it is
         dropped, is the part that keeps it true.

Status:  OPEN
```

---

## Verified healthy — the marketing spine (13 items, do not re-spend effort here)

Each is a query or a behavioural probe against the complete 310-migration
replay, not a reading of the SQL. Commands are given so any can be re-opened.

1. **All nine spine tables have RLS enabled**, and so do all 491 public tables —
   Pass E's verified-healthy #1 still holds at the larger count.
   `select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and relkind='r' and not relrowsecurity;` → **empty**.

2. **The read boundary holds.** As `anon` and as an ordinary `authenticated`
   user (the anchor account, `is_super_admin() => false`), row counts across the
   nine tables are: `marketing_pages` 1 (the published probe row only — the
   draft is invisible), and **0 on the other eight**. Verified for both roles
   with `set local role … ; set local request.jwt.claims = …`.

3. **Every write is refused.** INSERT on `marketing_pages`,
   `marketing_generation_jobs` and `marketing_brand_rules` raises
   *"new row violates row-level security policy"* for `anon` and for a
   non-super-admin `authenticated` user; UPDATE and DELETE affect 0 rows.
   (TRUNCATE is the exception — that is finding C3-S3-01 above.)

4. **The policies are what the migration claims.** All eleven read from
   `pg_policies`: nine `for all to authenticated using/with check
   (is_super_admin())`, one SELECT-only admin read on
   `marketing_page_versions`, and two deliberate public reads —
   `marketing_pages_public_read` (`status='published' and deleted_at is null`)
   and `marketing_page_relationships_public_read`, which requires BOTH endpoint
   pages to be published and undeleted.

5. **No `using (true)` and no policy `TO public` anywhere on the spine.**
   `select tablename||'.'||policyname from pg_policies where schemaname='public'
    and tablename like 'marketing_%' and roles::text like '%public%';` → empty.
   Pass E's verified-healthy #2 is unchanged: the same four literally-true
   policies, all SELECT-only global reference data (`badges`, `feature_flags`,
   `meal_ideas`, `service_descriptions`).

6. **`claim_marketing_generation_jobs` is service-role only, at the end of the
   chain.** `0292` is the migration that re-asserts it and it had never run.
   It ran, its own verification DO block passed, and the ACL confirms it:
   `postgres=X/postgres | service_role=X/postgres`. Behaviourally,
   `set role anon; select * from public.claim_marketing_generation_jobs(5);`
   → `ERROR: permission denied for function claim_marketing_generation_jobs`,
   and the same as `authenticated`. `docs/audit/privileged-rpc-grants-check.sql`
   (A-13) passes for the first time.

7. **Every SECURITY DEFINER function pins its search_path** — now 65 of them,
   the extra one being `claim_marketing_generation_jobs`.
   `select count(*) filter (where prosecdef) as secdef,
           count(*) filter (where prosecdef and proconfig is null) as unpinned
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public';` → **65|0**. The spine's two definer functions
   (`claim_marketing_generation_jobs`, `enqueue_marketing_page_generation`) both
   carry `{search_path=public}` and reference every table fully qualified, so
   there is no unqualified-relation shadowing surface. This extends Pass E's
   verified-healthy #10 to the tables it could not see.

8. **`enqueue_marketing_page_generation` is not callable.** It is SECURITY
   DEFINER with a default (PUBLIC-executable) ACL, but `returns trigger`, so
   PostgreSQL refuses a direct call and PostgREST does not expose it. Same
   disposition as Pass E's trigger functions.

9. **Nothing anon-callable can truncate.** `select p.proname from pg_proc p …
   where n.nspname='public' and p.prosrc ~* 'truncate';` → **0 rows**; and the
   count of SECURITY INVOKER `execute format(...)` functions executable by
   `anon` that are not trigger functions → **0**. This is what bounds finding
   C3-S3-01 to defence-in-depth.

10. **The trigger and queue machinery works.** Exercised for the first time
    anywhere, in a rolled-back transaction:
    - admin INSERT (`updated_by` set) → exactly one `regenerate_page` job,
      `idempotency_key = marketing-page:<id>:v:1`, priority 50, `created_by` set;
    - backfill INSERT (`updated_by` null **and** `content ? 'source'`) → **no**
      job — `0239`'s suppression works, and it correctly does *not* suppress an
      insert without the `source` marker;
    - admin UPDATE → version 1→2 and a second job at `:v:2`;
    - `claim_marketing_generation_jobs(10)` as `service_role` claims 4/4, sets
      `running`, `attempts=1`, `locked_at`;
    - a job backdated 20 minutes is recovered and re-claimed;
    - the same job at `attempts=5, max_attempts=5` moves to `dead_letter` with
      `"Recovered after a stale worker lock."` and is claimed 0 times.

11. **Every marketing-platform server action authorizes independently.** All six
    in `app/(app)/admin/marketing/platform/actions.ts` (`createPlatformPage`,
    `updatePlatformPage`, `archivePlatformPage`, `saveMarketingTemplate`,
    `saveMarketingBrandRule`, `retryMarketingJob`) open with
    `await requireMarketingAdmin()`, which is `getUser()` then `isSuperAdmin()`
    and only then hands back the service client
    (`lib/marketing/admin.ts:20-24`). This matters more than usual here because
    `page.tsx:21` reads with `createServiceClient()` — RLS is bypassed on that
    path, so the `/admin` layout and these six guards are the whole boundary, and
    a Next.js layout does not cover a server action.

12. **The public render path is not a stored-XSS vector.** `grep -rn
    "dangerouslySetInnerHTML" lib/marketing/ 'app/(marketing)'` → **no hits**.
    `lib/marketing/public-pages.tsx` splits `body` on blank lines and renders
    the parts as React text, so AI-generated page content
    (`generateWithAI` → `marketing_pages.body`) cannot inject markup. The public
    reads go through the anon key / user-scoped server client
    (`seo.ts:14`, `aeo.ts:31`, `public-pages.tsx:29`), so the published-only
    policy is genuinely the boundary on that path rather than being bypassed.

13. **`ON CONFLICT` targets are inferable with the spine present.**
    `node scripts/check-conflict-targets.mjs` → *"181 checked against 491 tables
    in the live catalog. Every target names a unique index Postgres can infer."*
    This gate has only ever run against 482 tables; the spine's upserts
    (`marketing_page_versions` on `(page_id,version)`, `marketing_embeddings` on
    `(source_type,source_id,chunk_index,content_hash)`,
    `marketing_provider_observations` on
    `(provider,engine,observed_for,page_path,query)`,
    `marketing_provider_syncs` on `provider`, `marketing_pages` on `path`) are
    covered for the first time. No 42P10 planning failure waiting in production.

**Two things I checked and am deliberately NOT raising as findings**, so the
reasoning is on the record rather than implied:

- **No spine table is FORCE RLS** (`relforcerowsecurity`) — but neither is any
  of the 491, table owner is `postgres`, and PostgREST never connects as the
  owner (`authenticator` → `set role anon|authenticated`). `service_role` is
  `bypassrls` by design. Nothing reachable turns on it.
- **The spine tables carry no `family_id`.** "Readable across families" does not
  apply to them: they are platform-global marketing content, and the only
  boundary is super-admin versus everyone. That boundary holds (items 2 and 3).
  Worth saying explicitly, because the brief asks about cross-family reads and
  the honest answer is that the axis does not exist here, not that it is clean.

---

## Re-verification of Pass E against the complete replay

Asked for as capacity allowed. Six claims re-run; **four confirmed, one refuted,
one no longer holds.**

| Pass E claim | Re-run result | Verdict |
|---|---|---|
| VH#1 — RLS coverage is total | tables with RLS off: **empty**, now over 491 | **CONFIRMED** |
| VH#2 — exactly 4 literally-true policies, all reference data | same 4: `badges`, `feature_flags`, `meal_ideas`, `service_descriptions`, all SELECT | **CONFIRMED** |
| VH#3 — anon holds no write privilege on any table | **1931** grant rows over 483 tables | **REFUTED** — see C3-S3-02 |
| VH#11 — 57 tables with RLS on and zero policies are deliberate | **57**, unchanged (the spine adds policies to all nine of its own) | **CONFIRMED** |
| F-E01 — child reads the family password vault | `family-credentials-boundary-check.sql` → *"0296 OK: the child is refused read, insert, update and delete; parent and adult keep the vault"* | **CONFIRMED fixed** by 0296, now proven against the complete 310-migration chain rather than a partial one |
| F-E02 — step-up MFA is presentational | `select count(*) from pg_policies where schemaname='public' and (qual ilike '%aal%' or with_check ilike '%aal%')` → **0** | **STILL OPEN** |
| F-E03 — `family-media` bucket is public | `select id, public from storage.buckets` → `family-media t` | **STILL OPEN** (also public: `avatars`, `feedback-attachments`, `marketplace-photos`) |
| F-E04 — `social_account_tokens` is family-member readable | all four policies now read `can_manage_family(family_id)`, and `sensitive-role-boundary-check.sql` passes with *"0297 OK: a child is refused … the OAuth tokens"* | **NO LONGER HOLDS** — `0297_sensitive_tables_respect_role.sql` fixed it after Pass E was written. Claude-1 should mark F-E04 fixed. |

```
$ psql -c "select tablename, policyname, cmd, roles, left(coalesce(qual,with_check),40)
           from pg_policies where schemaname='public'
             and tablename in ('social_account_tokens','sync_tokens') order by 1,2;"
       tablename       |          policyname          |  cmd   |  roles   |             expr
-----------------------+------------------------------+--------+----------+------------------------------
 social_account_tokens | social_account_tokens_delete | DELETE | {public} | can_manage_family(family_id)
 social_account_tokens | social_account_tokens_insert | INSERT | {public} | can_manage_family(family_id)
 social_account_tokens | social_account_tokens_select | SELECT | {public} | can_manage_family(family_id)
 social_account_tokens | social_account_tokens_update | UPDATE | {public} | can_manage_family(family_id)
 sync_tokens           | tokens service only          | ALL    | {public} | false
```

---

## What this session still could not reach

- **Production.** Unchanged and unchangeable from here: no credentials, and
  applying migrations is human-owned (`docs/PENDING_PROD_MIGRATIONS.md`). If
  F-001 holds, production carries none of the spine at all — in which case the
  live risk is not finding C3-S3-01 but that `/lp/*`, `/guides/*` and the SEO
  overlay have no table to read, which `lib/marketing/legacy-bridge.ts:63-66`
  and `public-pages.tsx:34-37` both handle explicitly as a compatibility state.
  That handling is evidence the team expects production to be behind.
- **PostgREST.** There is no local Supabase (no docker daemon, no CLI), so the
  HTTP layer was not exercised. My statement that TRUNCATE is unreachable
  through PostgREST rests on the absence of a TRUNCATE verb and on the two
  catalogue queries in C3-S3-01, not on a refused request.
  `scripts/verify-marketing-public-access.mjs` is exactly the probe that would
  settle it and it needs a running project.
- **The other 474 tables** in finding C3-S3-02 were measured, not individually
  reasoned about. I assert the count and the mechanism; I do not assert that
  every one of them is as harmless as the DML result suggests.

---

# Session 4 (2026-09-15) — the server-action surface

Dispatched to close the gap the board names: Pass E audited 141 API routes
thoroughly; the **132 files containing `'use server'`** were mentioned ~14 times
across all five audit files. A server action is a publicly-callable POST
endpoint with a stable action id. The page that renders the button is not a
control. Every action needs its own authorization, exactly like a route handler.

## Method — what was actually enumerated

Not a grep for `getUser`. The prior session's claim (this file, "Verified
healthy" item 12: *"Of 132 files containing `'use server'`, 8 make no auth
call"*) counts FILES and matches literal auth-function names. That misses two
things: files whose actions authorize through a **local helper** (`guard()`,
`assertSuperAdmin()`, `managerCtx()`, `ctx()`, `requireAdmin()`), and actions
that authenticate correctly but then **authorize on a client-supplied value**.

So this session built the unit of analysis properly — the exported action, not
the file:

1. `scan.mjs` → every `export async function` in a module whose first three
   lines carry `'use server'`, plus inline `'use server'` function bodies:
   **439 exported server actions across 113 top-level action modules**
   (19 more files carry the string in a comment or an inline body only).
2. `scan2.mjs` → a **transitive** auth-bearing name set. Seed on
   `getUser(` / `requireUserContext` / `isSuperAdmin` / `supabase.auth.getUser`,
   then iterate to a fixpoint over every function in `app/` + `lib/` that calls
   an already-auth-bearing name. 685 names.
3. `scan3.mjs` → re-ran (1) against (2).

Result: **9 of 439 actions reach no auth path, transitively** — not the 8 files
the prior pass reported, and a different set. All nine were read in full; all
nine are accounted for below. The naive file-level grep had flagged **94**
actions, i.e. 85 false positives, all authorizing through a local helper.

Further passes: `scan5.mjs` (service-role use inside actions, 62 found),
`scan6.mjs` (mutations of 30 sensitive tables vs. role gates, 60 found),
`scan7.mjs` (actions that spend money — LLM, email, SMS, Stripe — vs. rate
limits, 9 found), `scan8.mjs` (awaited writes whose `error` is never read).

**Limits of this session, stated up front.** There is still no local Supabase
(no docker daemon, no CLI), so **no action below was invoked**. Nothing here is
a demonstrated exploit; each finding is read from source plus, where it decides
the outcome, the committed RLS policy or RPC body. Where a claim rests on RLS I
say which migration and quote it. "We could not sign in" is not "it is clean" —
the BLOCKED list at the end says exactly which claims stay unproven.

---

### [CLAUDE-3][HIGH][RATE-LIMIT/COST] Three server actions are the only unmetered doors to the LLM in the product; one of them lets the caller choose most of the prompt

- **File/path:**
  - `app/(app)/marketplace/assistant-actions.ts:33` `askMarketAssistantAction` — **the HIGH**
  - `app/(app)/dashboard/paperwork/actions.ts:167` `draftPaperworkReplyAction` — MEDIUM on its own
  - `app/(app)/dashboard/contacts/[id]/actions.ts:67` `draftReconnectMessageAction` — MEDIUM on its own
- **Problem:** All three call `resolveProvider()` → `provider.complete()` with
  **no `enforceAIRateLimit`, no `assertAIAccess`, and no plan/feature gate**.
  `askMarketAssistantAction` additionally forwards a caller-supplied `history`
  array straight into the prompt: the turn COUNT is capped
  (`history.slice(-MAX_TURNS)`, 8) but each entry's **`content` is never
  measured, truncated or validated** — only `question` is (`q = question.trim()
  .slice(0, 500)`, line 37). There is no zod schema on the parameter; a server
  action's arguments are chosen by the caller, and TypeScript types are erased
  at runtime. Next's default Server Actions `bodySizeLimit` (1 MB; no override
  found — `grep -n "serverActions\|bodySizeLimit" next.config.*` returns
  nothing) caps ONE request, so "unbounded" means unbounded relative to the
  product's own 500-character cap, not literally infinite. With no rate limit,
  the per-request cap is the only cap that exists.
- **Evidence:**
  1. The convention is uniform and this is the only place it breaks:

         $ for f in $(grep -rl 'resolveProvider\|provider\.complete' app/api --include=route.ts); do
             grep -q "enforceAIRateLimit\|rateLimit" "$f" || echo "  $f"; done
         (no output)
         AI routes calling the model:               31
         ...of which rate-limited:                  31   (37 routes import it in all)

     **31 of 31 API routes that reach the model carry a per-user limit. 0 of 3
     server actions that reach the model do.** `app/api/ai/requests/route.ts`
     and `app/(app)/dashboard/inbox/actions.ts:85-87` — the same intake, one as
     a route and one as an action — BOTH carry
     `enforceAIRateLimit(supabase, \`ai-requests:${ctx.user.id}\`, {limit:20,
     windowMs:60_000})` + `assertAIAccess(ctx, ...)`. So the pattern is
     established for actions too; these three simply skip it.
  2. `withAiRequest` does not gate. `lib/ai/observability.ts` header:
     *"BOOKKEEPING NEVER FAILS THE FAMILY'S WORK. If the row cannot be opened
     the body still runs"*. It is observability only.
  3. Nothing upstream covers it. `middleware.ts` has no rate limiter of any
     kind (`grep -n "rateLimit" middleware.ts` → only the `matcher` line 168).
  4. No truncation downstream either: `grep -n "slice(0,\|MAX_.*CHARS\|truncate"
     lib/ai/provider.ts` returns only two error-message truncations (lines 189,
     203). `messageContent()` (line 226) passes `message.content` through
     verbatim.
  5. One mitigation IS present and worth recording so the fix is not
     over-scoped: `lib/ai/provider.ts:286,318,337,410` all
     `.filter((m) => m.role === 'user' || m.role === 'assistant')`, so a caller
     passing `role: 'system'` **cannot** inject a system message. A forged
     `assistant` turn is still accepted, but its blast radius is the caller's
     own reply.
- **Impact:** Any authenticated member of any family — **including a `child` or
  `teen` role, none of these three check role** — can POST the action id in a
  loop. Two of the three are bounded per call (6 000 chars of paperwork text,
  400 max_tokens). `askMarketAssistantAction` is not: 8 history entries of
  arbitrary size each become one upstream request. That is unmetered spend on
  the operator's API key, and the 60 s `OPENAI_TIMEOUT_MS` per call makes it a
  cheap way to hold connections too. No cross-family data is exposed — the
  snapshot is `.eq('family_id', ctx.active.familyId)` — so this is cost and
  availability, not confidentiality.
- **Fix:** In each of the three, immediately after `requireUserContext()`:
  `const limited = await enforceAIRateLimit(supabase, \`ai-<surface>:${ctx.user.id}\`, { limit: N });`
  (the sibling routes use 10-20/min), and `assertAIAccess(ctx, { db: supabase })`
  where the surface is plan-gated. Separately, in `askMarketAssistantAction`,
  bound the history the same way the question is bounded — e.g.
  `history.slice(-MAX_TURNS).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '').slice(0, 2000) }))`
  — so the cap is on bytes, not just turns. A guard test should assert that
  every `'use server'` export reaching `resolveProvider` also reaches
  `enforceAIRateLimit`; that is mechanically checkable and would have caught
  all three.
- **Status:** OPEN (static; the rate-limit absence is certain from source, the
  cost magnitude is not measured — no provider key was exercised)

---

### [CLAUDE-3][MEDIUM][AUTHZ] The marketplace hand-off actions compute a party role by ternary and never check the caller IS a party — the same feature's review action has exactly the check that is missing

- **File/path:** `app/(app)/marketplace/handoff/actions.ts` —
  `loadOrderRole` (:33), `proposeHandoffAction` (:44), `confirmHandoffAction`
  (:70), `cancelHandoffAction` (:112), `completeHandoffAction` (:125).
- **Problem:** `loadOrderRole` scopes the order to
  `.eq('family_id', ctx.active.familyId)` and stops there. Both writers then do:

      const role = order.seller_member === ctx.active.member.id ? 'seller' : 'buyer';

  A caller who is **neither** buyer nor seller falls into the `else` and is
  silently treated as **the buyer**. Nothing anywhere in the file compares the
  caller to `order.buyer_member`.
- **Evidence:**
  1. The intended contract is written down 90 lines away, in the same feature,
     by the same convention — `app/(app)/marketplace/actions.ts:171-173`:

         const isBuyer  = order.buyer_member  === memberId;
         const isSeller = order.seller_member === memberId;
         if (!isBuyer && !isSeller) return { ok: false, error: t('actions.onlyTheTwoPartiesCan') };

     `submitMarketplaceReviewAction` refuses a non-party. The four hand-off
     actions do not, and the file header claims only *"Family-scoped via
     requireUserContext + RLS"* — which is true, and is the whole problem: the
     product's boundary here is the PAIR, not the family.
  2. The database does not backstop it. `supabase/migrations/0199_marketplace_handoff_completion.sql:34`
     — the RPC's one authorization test is

         if not public.is_family_member(v_order.family_id) then
           return jsonb_build_object('ok', false, 'reason', 'forbidden');

     Family membership only. Note the action's own string table
     (`handoff/actions.ts:26`) renders that reason as *"You are not part of
     this marketplace exchange."* — the UI already promises a party check the
     code on neither side performs.
  3. `marketplace_handoffs` RLS is the generic family-scoped loop, so RLS
     cannot distinguish the two parties either.
- **Impact** (intra-family; the marketplace is household-internal — listings
  carry `family_id` + `member_id`, so the actor is a sibling or co-parent, not
  a stranger):
  - `proposeHandoffAction` upserts `onConflict: 'order_id'` and explicitly
    resets `status:'proposed', confirm_code:null, confirmed_at:null,
    calendar_event_id:null` (lines 59-60). A third party can therefore **wipe an
    already-confirmed pickup** and rewrite its time and location.
  - `confirmHandoffAction` guards only `if (role === handoff.proposer_role)`.
    When the seller proposed, a third party is `'buyer'`, the guard passes, and
    the action **returns the hand-off code to them** (`return { ok: true, data:
    { code } }`, line 108). The real buyer never receives it.
  - `cancelHandoffAction`'s doc comment says *"either party"*; it checks
    nothing at all.
  - `completeHandoffAction` + the RPC then let any family member close the
    order with that code.
  - **Bounded by:** no money moves. There is no escrow and no trigger on
    `marketplace_orders` (`grep -rn "marketplace_orders" supabase/migrations/*.sql
    | grep -i "trigger\|escrow"` → nothing; `grep -rln escrow` over migrations,
    `lib/`, `app/` → nothing). Completion is a status change. So this is
    integrity and disclosure-of-a-code within a household, not theft.
- **Fix:** Have `loadOrderRole` return the party role as
  `'seller' | 'buyer' | null` and refuse `null` in all four actions, reusing the
  exact wording already in the catalogue
  (`t('actions.onlyTheTwoPartiesCan')`). Mirror it in
  `marketplace_complete_handoff` by comparing `auth.uid()`'s member id against
  `buyer_member`/`seller_member`, so the RPC's `forbidden` reason becomes true
  of what it says.
- **Status:** OPEN (static; the ternary and the absent comparison are certain
  from source, the end-to-end sequence was not executed — no session)

---

### [CLAUDE-3][MEDIUM][AUTHZ] The social RBAC cannot be configured by anyone: the TS matrix and the SQL matrix disagree on who holds `manage_access`, and the only role that holds it in TS is never assigned

- **File/path:** `lib/social/roles.ts:45-68`, `lib/social/access.ts:26-63`,
  `app/(app)/dashboard/social/actions.ts:307` (`grantAccessAction`),
  `supabase/migrations/0034_social_command_center.sql:606-649, 765-771`.
- **Problem — two defects that compound:**
  1. **Divergence.** TS: `admin: ALL.filter((p) => p !== 'manage_access')`.
     SQL: `when 'admin' then true`. The file's own header says *"The database
     RLS (0024) is the real enforcement boundary; this mirrors it."* It does not
     mirror it.
  2. **Deadlock.** `grantAccessAction` requires `manage_access`. In TS only
     `owner` holds it. `defaultSocialRoleForMember` (roles.ts:106) returns
     `admin | marketing_manager | content_creator | read_only` — **never
     `owner`**. The only writer of `social_access_permissions` anywhere in the
     tree is `grantAccessAction` itself. So the only way to become `owner` is
     through an action only an `owner` may call.
- **Evidence:**

      $ grep -rn "social_access_permissions" --include=*.ts --include=*.tsx app lib
      app/(app)/dashboard/social/actions.ts:324   (the only write — an upsert)
      app/(app)/dashboard/social/settings/page.tsx:27  (a read)

  No other writer, no seeder, no migration insert, no delete path. A household
  parent maps to `admin`; `requireSocialPermission(fid,'manage_access')` throws
  for `admin`; `social_access_permissions` therefore stays empty for every
  family, and every family silently runs on the member-role defaults forever.
  Meanwhile SQL would have allowed it twice over —
  `social_access_permissions_insert ... with check (public.is_family_admin(family_id)
  or public.social_has_permission(family_id,'manage_access'))` (0034:765-767),
  and `social_has_permission` returns true for `admin` unconditionally.
- **Impact:** The divergence itself fails **closed** — I checked every row of
  both matrices and TS never grants a permission SQL denies (`owner`, `marketing_manager`,
  `social_manager`, `content_creator`, `approver`, `analyst`, `read_only` are
  byte-identical; only `admin` differs, and TS is the stricter side). So this is
  **not** a privilege-escalation hole. It is a whole authorization subsystem
  that can never be turned on, documented as the enforcement boundary — which
  matters because **the granular permission is the ONLY gate on most of the
  feature**: 0034's policy loop gives every `social_*` table plain
  `is_family_member` CRUD, and only two policies are tightened to the role
  (`social_publish_jobs_insert`, `social_access_permissions_insert/update`).
  For connecting accounts, creating posts, uploading media and changing
  settings, the TS `requireSocialPermission` call IS the entire boundary. A
  family that wanted to restrict a teen cannot; a family that wanted to promote
  a trusted adult cannot.
- **Secondary, same file:** `getSocialAccess` (access.ts:49) returns access when
  `explicit` exists even with **no active `family_members` row**
  (`if (!member && !explicit) return null;`), and an explicit row wins the role
  resolution (line 51). SQL is stricter: `social_has_permission` is
  `is_family_member(p_family_id) and (...)`, and `social_role_for` requires
  `fm.is_active`. There is also **no revocation path** — no code anywhere
  deletes a `social_access_permissions` row or sets `status` to anything but
  `'active'`. Today RLS backstops this (every social write goes through
  `createServer()`, the user-scoped client — verified: `grep -n
  "createServiceClient" lib/social/*.ts` → no hits), so a deactivated member is
  still blocked at the database. It is a defence-in-depth gap, not a live hole
  — but it is the half of the pair that would become one if any social path
  ever moved to the service role.
- **Fix:** Decide which matrix is authoritative and make the other follow. The
  likely intent is SQL's: give `admin` `manage_access` in `ROLE_PERMISSIONS`,
  which un-deadlocks `grantAccessAction` for parents in one line. Add
  `if (!member) return null;` to `getSocialAccess` so TS and
  `social_has_permission` agree on deactivated members. Add a revoke path. A
  test that asserts the TS matrix equals the SQL `case` arms (both are static
  text) would pin all three.
- **Status:** OPEN (matrices compared line-by-line from source; not executed)

---

### [CLAUDE-3][LOW][SURFACE] Three pure helpers are exported from `'use server'` modules, so each is a public POST endpoint — and this repo has already moved three others out for exactly that reason

- **File/path:**
  - `app/(app)/dashboard/paperwork/actions.ts:32` `paperworkInsertRow`
  - `app/(app)/dashboard/inbox/actions.ts:55` `inboxRequestText`
  - `app/(app)/marketplace/assistant-actions.ts:100` `previewMarketIntentAction`
- **Problem:** Every export of a `'use server'` module becomes a callable action
  id. These three touch no database and hold no session; they are helpers that
  happen to live in an action file. Two of the three are three of the nine
  no-auth actions `scan3.mjs` found — they are "unauthenticated" because they
  are not actions at all.
- **Evidence:** The codebase already knows this and says so three times, in
  three files that did the opposite:

      lib/groceries/add-summary.ts:9   "A plain module rather than an export of the action
                                        file: everything a `'use server'` file exports becomes
                                        a callable endpoint, and a pure string function has no
                                        business being a network round trip."
      lib/marketing/recurring-ads.ts:263 "Every export of a 'use server' module is a callable
                                        endpoint, so a pure string parser has no business being one"
      lib/library/ingest.ts:5          "This lived inside the library's `'use server'` actions
                                        module, which made it unreachable from anywhere else"

  `paperworkInsertRow` argues the other way in its own docblock — *"It exists as
  its own exported function — async, which is all a `'use server'` module may
  export"* — i.e. it was exported to be unit-testable, accepting an endpoint as
  the price. The three files above show the repo's own answer: move it to a
  plain module and test it there.
- **Impact:** Small and worth saying plainly. None of the three reads or writes
  anything; the caller supplies all input and gets a computed value back.
  `paperworkInsertRow` runs `triagePaperwork()` over caller-supplied text with
  no length cap before `raw_text` is sliced to 20 000, so it is a modest CPU
  sink; `previewMarketIntentAction` likewise runs `routeMarketIntent()` on an
  unbounded string. The real cost is surface-area hygiene: three endpoints that
  need not exist, two of which will keep showing up as "unauthenticated action"
  in every future audit.
- **Fix:** Move `paperworkInsertRow` and `previewMarketIntentAction` to plain
  modules (`lib/paperwork/row.ts`, alongside `lib/marketplace/assistant.ts`) and
  import them; the existing tests import the function, not the endpoint, so they
  keep passing. `inboxRequestText` is already trivial enough to inline.
- **Status:** OPEN

---

### [CLAUDE-3][LOW][ERROR-HANDLING] Two money-surface actions discard the write error and revalidate as if it worked

- **File/path:** `app/(app)/dashboard/money-timeline/actions.ts:19`
  (`setMoneyInsightStatusAction`) and `:46` (`syncMoneyInsightsAction`).
- **Problem:** Both `await supabase.from('money_timeline_insights').upsert({...})`
  without destructuring `error`, then call `revalidatePath(PATH)` and return.
  Both are typed `Promise<void>`, so there is no channel to report a failure on
  even if one were read. A PostgREST write returns `{ error }` rather than
  throwing, so a rejected upsert is indistinguishable from a successful one.
- **Evidence:** `scan8.mjs` found 11 awaited writes inside server actions whose
  result is never bound. Nine are compensating/rollback or best-effort writes
  whose primary error IS reported (`child-login-actions.ts:68,77,78`;
  `(auth)/actions.ts:147`; `library/actions.ts:63,101`;
  `trip-intel/actions.ts:254`; `admin/marketing/content/actions.ts:123,124`).
  These two are the only ones where the discarded write is **the action's whole
  purpose**. Contrast the convention in the same tree —
  `app/(app)/dashboard/auto/actions.ts:31-42` writes the reason out in full:
  *"A PostgREST write returns `{ error }` without throwing, so an unchecked
  write would let a form report success while the record was silently lost."*
- **Impact:** A family dismisses a money insight; the row does not change; the
  page revalidates and the insight returns on the next render with no error
  shown. Cosmetic in isolation, but it is the repo's named second-most-common
  defect class, on the money surface, in the two functions that define it.
- **Fix:** Bind `const { error } = await ...`, return
  `{ ok: false, error: describeActionError(error, ...) }` (change the signature
  off `void`, as `trust/actions.ts` and `auto/actions.ts` already do), and log.
- **Status:** OPEN

---

### [CLAUDE-3][LOW][AUTHZ] `lib/family/actions.ts`'s column whitelist admits a client-supplied `member_id` with no same-family check

- **File/path:** `lib/family/actions.ts:22-33` (`WRITABLE`), used by
  `createFamilyRecord` (:125) and `updateFamilyRecord` (:160).
- **Problem:** `member_id` is a whitelisted writable column on seven tables
  (`family_routines`, `family_digital_twin_profiles`,
  `family_ai_recommendations`, `family_stress_signals`,
  `family_knowledge_nodes`, `family_emergency_contacts`, `family_memories`,
  `family_milestones`). `family_id` and `created_by` are correctly forced from
  `ctx`, but `member_id` is taken from `values` and never checked against the
  caller's family.
- **Evidence:** The column's only constraint is a single-column FK —
  `supabase/migrations/0022_family_os.sql:87`:

      member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,

  There is no composite FK on `(family_id, member_id)` and no CHECK, so any
  existing `family_members.id` is accepted, including one from another family.
  RLS (0022's loop) constrains `family_id` only.
- **Impact:** **No impact demonstrated, and I want that stated rather than
  implied.** The planted row carries the caller's own `family_id`, so it is
  readable only inside the caller's family, and the read paths I checked
  (`lib/family/signals.ts:43,188`) filter by `family_id`. It is recorded because
  it is precisely the shape this session was sent to find — an identifier the
  caller controls being written into an authority column — and because this file
  is otherwise the model the rest of the codebase should copy (table whitelist,
  column whitelist, `MANAGER_ONLY` set, entitlement gate, forced `family_id`,
  audit log). One missing check in the best-designed file is worth a line.
- **Fix:** In `pick()`/`graphWrite()`, when `member_id` is present, resolve it
  against `family_members` with `.eq('family_id', ctx.active.familyId)` and
  refuse if absent — or add the composite FK, which fixes it for every writer at
  once.
- **Status:** OPEN (no exploit path found; recorded as hygiene with the
  uncertainty named)

---

### [CLAUDE-3][LOW][AUTHZ] Any family member, including a child, can reassign another member's open chore

- **File/path:** `app/(app)/dashboard/workload/actions.ts:15`
  `moveAssignmentAction`.
- **Problem:** The action verifies the TARGET member is in the caller's family
  (:20-22) and scopes the update by `family_id` (:27) — but performs no role
  check. `isManager` is not imported in the file.
- **Evidence:** Compare the convention two directories away:
  `app/(app)/dashboard/trust/actions.ts:36-40` defines `managerCtx()` and every
  policy action opens with it; `lib/family/actions.ts:60` keeps a `MANAGER_ONLY`
  set for exactly this decision. Rebalancing who does a chore is a parental
  decision by the same logic.
- **Impact:** Intra-family only, and reversible. A child can push their own open
  chore onto a sibling; the `logAudit` call at :32 does record it, with
  `{ rebalance: true, toMemberId }`, so it is visible after the fact. Recorded
  as LOW, not raised higher, because the audit row exists and nothing crosses a
  family boundary.
- **Fix:** `if (!isManager(ctx.active.role)) return { ok: false, error: ... }`,
  or — if a child moving their OWN chore is intended — allow it only when
  `assignment.member_id === ctx.active.member.id`.
- **Status:** OPEN

---

## Verified clean — checked against the negative case, not assumed

Recorded so a later pass does not re-derive them. The first four are the exact
actions the dispatch named as suspicious.

1. **`app/gift/actions.ts:18` `submitGiftPledgeAction` — legitimately public,
   correctly built.** Service client behind an unguessable token; `.eq('token',
   token)` (not `ilike` — no LIKE-wildcard hole); `is_active` checked; amount
   clamped by `clampGiftAmountCents`; every string bounded
   (`slice(0,200)/80/500`); IP rate limit 10/window; pending pledges per link
   capped at 25; the row lands `status:'pending'` and **no money moves until a
   parent approves**. The notify failure is best-effort AFTER the gift is
   recorded, which is the right order. One gap worth a line, not a finding:
   `gift_links` has an `expires_at timestamptz` column
   (`0088_family_wallet.sql:143`) and this action checks `is_active` but
   **never reads `expires_at`** — an expired-but-active link still accepts
   pledges. Whether `expires_at` is meant to be enforced is a product question I
   cannot settle from source.
2. **`app/reviews/new/actions.ts:14` `submitReviewAction` — legitimately
   public.** Rating validated 1-5 and rounded; all strings bounded; IP rate
   limit 5; auto-approve threshold read from `reputation_settings` server-side,
   never from input. No auth needed and none missing.
3. **`app/s/[slug]/actions.ts:14` `submitResponseAction` — legitimately
   public.** Survey resolved by slug, `deleted_at is null`, `status === 'active'`
   enforced, score validated against the survey's OWN `scale_min`/`scale_max`
   (not a client-sent range), IP rate limit 10.
4. **`app/(auth)/signup/actions.ts:12` `rememberReferralCodeAction` —
   legitimately public.** Validates with `isPlausibleReferralCode`, normalizes,
   writes an `httpOnly`, `sameSite:'lax'`, `secure`-in-prod cookie. Nothing to
   authorize. Likewise `lib/i18n/actions.ts:21` `setLocale`, which validates
   against the locale catalogue before writing — *"a crafted request can never
   plant an arbitrary cookie value"*, and that is true as written.
5. **`app/(auth)/actions.ts:76` `childSignInAction`.** The ILIKE fix has landed
   and is load-bearing: `.eq('username', username)` at :125 and :46 of
   `child-login-actions.ts`, each with the comment explaining that `_` is a LIKE
   wildcard permitted by `USERNAME_RE`. Durable cross-instance throttle read
   BEFORE the password is touched and checked **even for unknown usernames**, so
   it is not a lookup oracle; IP rate limit 30; identical vague error for
   unknown-user and wrong-PIN; throttle cleared only on success.
6. **`app/(app)/actions.ts:37` `setActiveFamilyAction`** — the pivot of the
   whole `ctx.active.familyId` model, and it is guarded: membership proven with
   `.eq('family_id', familyId).eq('user_id', auth.user.id)` before the
   `user_preferences` upsert. My scan flagged it only because it uses
   `auth.user.id` directly rather than `ctx`.
7. **`app/onboarding/actions.ts:326` `finalizeOnboardingAction`** — never trusts
   a client `familyId`: it is resolved from `family_members` or minted under a
   per-user DB lock (`onboarding_claim_family`), with
   `verifyOnboardingOwner(supabase, auth.user.id, expectedOwner)`
   (`lib/onboarding/verify-owner.ts`) refusing an adopted or ambiguous family
   first. `saveFamilyDetailsAction` (:170) DOES take `input.familyId`, but the
   write goes through the user-scoped client and
   `0052_family_onboarding.sql:38-41` is
   `for all to authenticated using (public.is_family_member(family_id)) with
   check (public.is_family_member(family_id))` — so a foreign family is
   rejected by RLS, and the service-role marketing writes that follow run
   **only after** that upsert returns without error. The ordering is correct.
8. **All 20 super-admin console actions.** `admin/actions.ts` (`assertSuperAdmin`
   at :31), `admin/admins`, `admin/feedback`, `admin/tier-features`,
   `admin/support-tickets`, `admin/marketing/social/recurring` — each opens with
   a local `guard()`/`requireAdmin()` that is `isSuperAdmin()` (+ `getUser()`).
   `recurring/actions.ts:5-6` states the principle the whole audit turns on:
   *"a server action is its own endpoint: a gate in the page that renders the
   form does not protect the function the form posts to."* These were the 85
   false positives of the naive file-level grep.
9. **`app/(app)/family/child-login-actions.ts`** — `isManager(ctx.active.role)`
   first, then the target member is loaded by the SERVICE client and explicitly
   compared: `if (!member || member.family_id !== ctx.active.familyId) return`.
   That is the right shape for a service-role action: authorization re-proven in
   code because RLS is bypassed. The unchecked rollback writes at :68/77/78 are
   compensating paths whose primary error is returned; noted, not filed.
10. **`lib/family/actions.ts`** — table whitelist, per-table column whitelist,
    `MANAGER_ONLY` set, `refuseIfUnentitled`, forced `family_id`/`created_by`,
    audit log, `.eq('family_id', ctx.active.familyId)` on every update and
    delete. The one gap is the `member_id` LOW filed above.
11. **`app/(app)/dashboard/concierge/runs/[id]/page.tsx:103` — an INLINE server
    action inside a gated page, and it re-authorizes.** This is the classic trap
    (the page calls `assertAIAccess` at :66; a POST to the action id does not
    run the page) and it is handled: the action re-derives
    `requireUserContext()`, compares `actor.active.familyId !== familyId`, and
    the manager check is real, not just claimed — `editStepInput` →
    `openRun(scope, runId, opts, /*requireManager*/ true)`
    (`lib/ai/runs/controls.ts:36-53`) refuses a non-manager.
12. **`app/(app)/marketplace/actions.ts:171`, `app/(app)/dashboard/trust/actions.ts`,
    `app/(app)/dashboard/auto/actions.ts`, `app/(app)/dashboard/social/actions.ts`,
    `app/(app)/account/actions.ts`, `app/(app)/settings/app-lock-actions.ts`,
    `app/(app)/dashboard/workload/actions.ts:45`** — all scope by
    `ctx.active.familyId` (or `ctx.user.id` for per-user rows) on every write,
    and the first four gate on role where the product says they should
    (`isBuyer/isSeller`, `managerCtx()`, `requireSocialPermission`, `isAdmin`).
13. **`sendReferralEmailAction`** (`app/(app)/referrals/actions.ts:56`) — flagged
    by `scan7.mjs` as an unmetered email sender; it is not. The throttle is
    `recordReferralEmailInvite(... config ...)` returning `'throttled'`, counted
    from the send timestamps on the `referrals` rows themselves
    (`REFERRAL_EMAIL_POLICY.limit` per family per day), and a failed send is
    rolled back (`rollbackReferralEmailInvite`). Recipient validated by
    `emailSchema`; self-invite refused.
14. **Prompt-injection surface of the three ungated AI actions.** The provider
    filters every message to `role === 'user' || 'assistant'`
    (`lib/ai/provider.ts:286,318,337,410`), so a caller cannot inject a system
    turn; `draftPaperworkReplyAction` fences the OCR text
    (`fenceUntrustedBlock('paperwork', source, 6000)` + `UNTRUSTED_CONTENT_RULE`)
    and deliberately writes nothing from the document back onto the row. The
    defence is real; only the metering is missing.

---

## What I could NOT reach this session — do not read these as clean

1. **Nothing was executed.** No local Supabase (no docker daemon, no Supabase
   CLI), so no session could be established and **not one of the 439 actions was
   POSTed**. Every finding above is source + committed SQL. Specifically
   unproven: that a third party can actually obtain the hand-off code
   (C3-S4-02); that the ungated AI actions accept a multi-megabyte `history` in
   practice rather than failing on Next's action-payload limit first
   (C3-S4-01 — the Server Actions `bodySizeLimit` defaults to 1 MB, which
   bounds but does not remove the finding, and I did not find an override in
   `next.config`); that `family_onboarding`'s RLS actually rejects a foreign
   `familyId` at runtime.
2. **Next.js's own action-id protection was not tested.** The premise of this
   whole pass — that an action id can be replayed by a caller who is not on the
   page — is Next's documented model, but I could not build the app and read the
   generated ids, so I could not demonstrate a replay. This does not change any
   finding (each one is also reachable by a legitimate user of the feature,
   which is the intra-family case I scoped them to), but it means the "anyone
   with the id" framing is inherited from the dispatch, not verified here.
3. **Production.** F-001 stands: if the production ledger really records only
   `0001-0003`, the RLS I rely on in C3-S4-02 and in verified-clean items 7 and
   the social secondary finding may not exist there. Every RLS-backstop claim
   above is a claim about the committed migrations.
4. **The 19 files carrying `'use server'` inside a function body or a comment**
   were classified and the two real inline-action cases read
   (`concierge/runs/[id]/page.tsx`, verified clean), but I did not exhaustively
   enumerate inline actions the way I enumerated top-level exports — an inline
   action does not match `^export async function`. If a later pass wants
   completeness on the 439 number, that is where the remainder is.
5. **`clientIp()` header trust** (`lib/server/rate-limit.ts:41-51`) takes the
   first `x-forwarded-for` entry. Every public action's rate limit is keyed on
   it. Whether the deployment's proxy makes that unspoofable is an
   infrastructure question I cannot answer from the repo; flagging it because
   three public actions' only defence rests on it.
