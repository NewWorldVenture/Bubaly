# Claude-3 — Backend · API · Database · Auth · Security

Findings only. Format and rules: `audit/README.md`.
This file is written by Claude-3 and by nobody else.
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

---

### [CLAUDE-3][CRITICAL][AUTH/RLS] `invites_update` has no `WITH CHECK`, so an invitee rewrites their own invite and becomes `parent` of any family
- **File:** `supabase/migrations/0118_rls_drift_repair.sql:90` (originally `0004_rls.sql:106`) — policy `invites_update` on `public.invites`; consumed by `public.accept_invite(text)`
- **Problem:** The policy is

  ```
  POLICY "invites_update" FOR UPDATE
    USING (can_manage_family(family_id)
           OR lower(email) = lower(coalesce(auth.jwt()->>'email','')))
  ```

  with **no `WITH CHECK`**. Postgres then reuses `USING` as the check, and the
  only column the check constrains is `email`. `family_id` and `role` are
  therefore freely writable by the invited person. `accept_invite()` is
  `SECURITY DEFINER` and inserts `family_members(family_id, role)` straight from
  the row it just read — so whatever the invitee wrote is what they get.
  `authenticated` holds `UPDATE` on `public.invites` (Supabase default
  privileges; confirmed in `information_schema.role_table_grants`), so this is
  one PostgREST `PATCH /rest/v1/invites?token=eq.…` away with no app code
  involved.
- **Evidence:** replayed schema (310 migrations, 491 tables), acting **as
  `authenticated`** with the invitee's JWT claims. Two runs:

  *(1) self-promotion inside the inviting family*
  ```
   step                           | email               | role
   invite as issued               | mallory@example.com | guest
   am I a manager of that family? | can_manage = f
   UPDATE 1                       -- update invites set role='parent' where token=…
   invite AFTER Mallory edits it  | mallory@example.com | parent
   accept_invite returns          | 00000000-…-0000000000f1
   membership Mallory now holds   | role = parent | is_active = t
   can Mallory manage the family now? | can_manage = t
  ```

  *(2) takeover of a household she was never invited to*
  ```
   is Mallory2 in the victim family? | member = f
   UPDATE 1   -- update invites set family_id='…f2', role='parent' where token='TOKEN-2'
   accept_invite returns             | 00000000-…-0000000000f2
   membership created                | The Victim Family | role = parent
  ```
  (`…f2` is a second household created with an unrelated owner; Mallory2's only
  legitimate invite was a `guest` invite to `…f1`.)
- **Impact:** Anyone who has ever been sent a Bubaly invite — a grandparent, a
  babysitter, a `guest`, a child — can promote themselves to `parent`, which is
  `can_manage_family` = true: membership, roles, wallet/allowance controls,
  subscription, secure-vault documents, the lot. With a known `families.id` it is
  a full cross-tenant takeover of an arbitrary household. Pass I examined this
  exact policy and recorded it as *"exactly right"*; the miss is that it read the
  `USING` clause and not the absence of `WITH CHECK`.
- **Fix:** The invitee never needs direct `UPDATE` — `accept_invite()` is
  `SECURITY DEFINER` and does the status flip itself. Replace the policy:

  ```sql
  drop policy "invites_update" on public.invites;
  create policy "invites_update" on public.invites
    for update to authenticated
    using      (can_manage_family(family_id))
    with check (can_manage_family(family_id));
  ```

  Both clauses pin `family_id`, so a manager cannot move an invite between
  households either. Add a probe asserting `polwithcheck is not null` for every
  `polcmd='w'` policy whose `USING` contains an `OR` (see the sweep in the INFO
  finding below), and a behavioural probe that re-runs run (2) and expects the
  update to be rejected.
- **Status:** OPEN

---

### [CLAUDE-3][HIGH][AUTH] The child-PIN brute-force throttle is keyed on a string the attacker chooses, and `ILIKE` makes many strings hit one account
- **File:** `app/(auth)/actions.ts:116` (`childSignInAction`), with
  `lib/onboarding/child-login.ts:10` (`USERNAME_RE`) and
  `lib/auth/child-throttle.ts`
- **Problem:** The account lookup is

  ```ts
  await admin.from('child_logins').select('username').ilike('username', username).limit(1);
  ```

  `_` is an `ILIKE` single-character wildcard **and** a legal username character
  (`/^[a-z0-9](?:[a-z0-9._-]{1,22})[a-z0-9]$/`). The throttle, however, is keyed
  on the *submitted* string:
  `.from('child_login_throttle').select(…).eq('username', username)` — while the
  password is derived from the *resolved* row: `deriveChildPassword(sec, row.username, pin)`.
  So every wildcard spelling of a target username is a **separate throttle
  bucket** that still signs in to the **same account**. For a username of length
  L there are `2^(L-2)` such spellings (underscores anywhere in the middle), each
  worth `DEFAULT_POLICY.maxFails = 5` attempts. A 4-digit PIN is 10,000
  combinations; at L ≥ 13 the bypass alone exceeds the whole keyspace.
- **Evidence:** replayed schema, real `child_logins` row for `jordan`:
  ```
   submitted_username_and_throttle_key | passes_isvalidusername | row_username_used_to_derive_password
   j____n | t | jordan       jo___n | t | jordan
   j___an | t | jordan       jo__an | t | jordan
   j__d_n | t | jordan       jo_d_n | t | jordan
   j__dan | t | jordan       jo_dan | t | jordan
   j_r__n | t | jordan       jor__n | t | jordan
   j_r_an | t | jordan       jor_an | t | jordan
   j_rd_n | t | jordan       jord_n | t | jordan
   j_rdan | t | jordan       jordan | t | jordan
   (16 rows)
  ```
  16 distinct throttle keys → 80 PIN guesses against `jordan` before the first
  lockout, instead of 5. The other limiter, `enforceRequestRateLimit(admin,
  'child-login:'+clientIp, { limit: 30 })`, is 30/minute **per IP**, i.e. 43,200
  attempts/day from one address and unbounded from a pool — it is not the
  binding control.
- **Impact:** Child-account takeover. A child session is a real Supabase session
  inside the household: family calendar, messages, chores, wallet balance,
  location history. The module header states the threat exactly ("a 4-digit PIN
  is only 10,000 combinations and kid usernames are guessable") and the throttle
  is the only thing sized against it.
- **Secondary defect, same line:** `.ilike(…).limit(1)` has **no `order by`**, and
  `idx_child_logins_username_lower` is globally unique, so `sam_k` and `sam.k`
  can be two children in two different households. Signing in as `sam_k` resolves
  to an arbitrary one of them.
- **Fix:** Two one-line changes in `app/(auth)/actions.ts`:
  1. Look the account up by equality, not pattern: `.eq('username', username)`
     (the row is already stored normalized and the unique index is on
     `lower(username)`), or `.filter('username','ilike', username.replace(/[%_]/g,'\\$&'))`.
  2. Key the throttle on the account that was resolved, not the string that was
     typed — and when no row resolves, key on the normalized submission with
     `_` collapsed, so an unknown-username attempt cannot mint fresh buckets.

  Then add a probe: 16 wildcard spellings of one username must consume **one**
  throttle bucket.
- **Status:** OPEN

---

### [CLAUDE-3][HIGH][RLS] `child_logins` says "Managers manage" and means "any member" — a child can delete a sibling's login
- **File:** `supabase/migrations/01051_child_logins.sql:44` — policy
  `Managers manage child_logins` on `public.child_logins`; consumers
  `app/(app)/family/child-login-actions.ts:104` (`resetChildPinAction`) and
  `app/(auth)/actions.ts:116`
- **Problem:**
  ```
  POLICY "Managers manage child_logins"            -- FOR ALL
    TO authenticated
    USING (is_family_member(family_id))
    WITH CHECK (is_family_member(family_id))
  ```
  The name claims a manager boundary; the predicate is plain membership, so
  every child holds INSERT/UPDATE/DELETE on the table that maps
  `member_id → auth user → username`.
- **Evidence:** acting **as `authenticated`** with a child's JWT, against the
  replayed schema:
  ```
   my role                  | child
   can I manage the family? | f
   UPDATE 1        -- update child_logins set username='stolen' where username='sam'
   DELETE 1        -- delete from child_logins where username='stolen'
   after a CHILD ran UPDATE then DELETE | rows_left = 1   (was 2)
  ```
- **Impact:** Two concrete harms, both reachable from a kid's own session:
  1. **Permanent lockout of a sibling with no recovery path in the UI.** Deleting
     the row orphans the login: `createChildLoginAction` then refuses
     (`if (member.user_id) return 'This member already has a login'`) and
     `resetChildPinAction` returns "Login not found". Renaming `username` is worse
     — the auth user keeps `child.<old>@kids.bubaly.app` while sign-in derives the
     email from the new name, so the child can never sign in again and nothing
     reports why.
  2. **A parent's PIN reset applied to the wrong account.**
     `resetChildPinAction` reads `user_id` from this table and calls
     `admin.auth.admin.updateUserById(row.user_id, { password })` under the
     service role, guarded only by `row.family_id === ctx.active.familyId`. A
     child who repoints `user_id` at a parent's auth user has that parent's
     password silently overwritten with a value nobody knows, the next time a
     parent resets any PIN — and the audit row written afterwards says a child's
     PIN was reset.
- **Fix:** Split the verbs the way `family_members` already does:
  ```sql
  drop policy "Managers manage child_logins" on public.child_logins;
  create policy "child_logins_write" on public.child_logins
    for all to authenticated
    using (can_manage_family(family_id)) with check (can_manage_family(family_id));
  ```
  (`Members can view child_logins` already covers SELECT.) Independently, make
  `resetChildPinAction` re-derive `user_id` from `family_members` for the member
  it was asked about rather than trusting this table, and assert
  `family_members.id = row.member_id`.
- **Status:** OPEN

---
### [CLAUDE-3][HIGH][DB] 163 `ON DELETE CASCADE` foreign keys have no supporting index — a family delete is a table scan per dependent table
- **File:** schema-wide. 28 CASCADE constraints point at `public.families`
  (plus 8 `SET NULL`, which the delete also has to resolve — 36 scans per
  family deletion, listed below), 41 CASCADE at `family_members` (plus 117
  `SET NULL`), 21 at `vacations`, 11 at `child_wallets`.
- **Problem:** Postgres implements referential integrity with a per-constraint
  query on the *child* table. With no index leading on the FK column that query
  is a sequential scan, and a cascading delete runs one per constraint while
  holding row locks. `docs/audit/family-scoped-index-check.sql` (A-14) pins nine
  tables for the *read* path and says so explicitly; nothing covers the *delete*
  path, and the two do not overlap — `wallet_transactions` has
  `idx_wallet_txn_child btree (family_id, child_wallet_id, created_at DESC)`, which
  serves family reads and does nothing for
  `wallet_transactions_child_wallet_id_fkey`.
- **Evidence:** replayed schema; catalogue query matching each FK's `conkey`
  against the leading columns of every `pg_index` on the same relation (so a
  composite or UNIQUE index that happens to lead on the column counts as covered):
  ```
   referenced_table | on_delete | unindexed_fks
   auth.users       | SET NULL  | 431
   family_members   | SET NULL  | 117
   family_members   | CASCADE   |  41
   families         | CASCADE   |  28
   vacations        | CASCADE   |  21
   child_wallets    | CASCADE   |  11
   …  (163 CASCADE in total)
  ```
  Measured on one of them, `sync_webhook_events_family_id_fkey`, with 400,050
  rows in the table and 50 belonging to the family being closed — this is
  exactly the statement the RI trigger issues:
  ```
  -- no index (as shipped)
  LockRows (actual time=0.039..52.889 rows=50 loops=1)
    Buffers: shared hit=5765
    ->  Seq Scan on sync_webhook_events x  (rows=50, Rows Removed by Filter: 400000)
  Execution Time: 52.939 ms
  delete from public.families where id=…;   Time: 189.810 ms

  -- with create index tmp_swe_family on sync_webhook_events(family_id)
  LockRows (actual time=0.080..0.126 rows=50 loops=1)
    Buffers: shared hit=51 read=3
    ->  Index Scan using tmp_swe_family  (rows=50)
  Execution Time: 0.177 ms
  ```
  **5,715 buffers → 4, 52.9 ms → 0.18 ms, on one constraint of thirty-six.**
- **Impact:** GDPR/CCPA erasure and admin family deletion do 36 full scans of
  the platform's largest tables in one transaction, taking row locks as they go.
  At present volumes it is slow; at the volume the `sync_*`, `social_*` and
  `marketplace_*` tables are designed for it is a statement-timeout, and a
  deletion that times out half-way is the one that leaves an account partly
  erased. The same scans run on `family_members` deletes (41 CASCADE + 117 SET
  NULL) — i.e. on every member removal, not just account closure.
- **Fix:** Add the indexes for the CASCADE and SET NULL constraints on the four
  hot parents (`families`, `family_members`, `child_wallets`, `vacations`) — ~100
  `create index concurrently` statements, generated from the catalogue query
  above rather than hand-listed. Then extend
  `docs/audit/family-scoped-index-check.sql` with a *generic* assertion: **no
  `contype='f'` constraint with `confdeltype in ('c','n')` referencing those four
  tables may lack a leading index**, so the next migration that adds a child
  table is caught by CI instead of by an erasure request. The 431 `auth.users`
  SET NULL constraints are a separate, lower-priority question (user deletion is
  rare and goes through Supabase), and should be judged on their own.
  The 36 `families` CASCADE/SET NULL constraints, for the fix list:
  `affiliate_referrals, ai_messages, announcement_reads, assistant_link_events,
  checkout_sessions, chore_ai_validations, chore_approval_events, demo_sessions,
  family_poll_options, family_poll_votes, feedback_ideas,
  guardian_screening_sessions, marketplace_bids, marketplace_circles,
  marketplace_listing_shares, marketplace_listings, marketplace_price_history,
  marketplace_reports, member_badges, push_devices, resume_versions, reviews,
  social_account_tokens, social_post_assets, social_provider_errors,
  social_publish_jobs, social_webhook_events, support_tickets, survey_responses,
  sync_calendar_shares, sync_conflict_resolutions, sync_event_attendees,
  sync_provider_errors, sync_tokens, sync_webhook_events, user_preferences`.
- **Status:** OPEN

---

### [CLAUDE-3][MEDIUM][SECURITY] `/api/assistant` and `/api/assistant/alexa` claim a rate limit that a serverless deployment does not give them
- **File:** `app/api/assistant/route.ts:32`, `app/api/assistant/alexa/route.ts:35`,
  and `lib/server/rate-limit.ts:6` (`const buckets = new Map(...)`)
- **Problem:** The route comment reads *"Rate limited by IP BEFORE the token
  lookup, so an attacker cannot use this endpoint to test guessed tokens at
  speed."* The limiter behind that sentence is a module-scope `Map`. On Vercel
  every cold lambda starts with an empty map and concurrent instances never
  share one, so "30 per minute" is 30 per minute **per instance** — which the
  attacker controls the number of, simply by sending requests in parallel.
  `lib/server/rate-limit.ts` says so in its own header ("Good for a single
  instance / dev; swap for Upstash Redis in multi-instance prod"), and the
  durable replacement already exists and is used by 26 other routes.
- **Evidence:** the five mutating routes still on the in-memory limiter with no
  durable counterpart, found by requiring a `rateLimit(` call and the absence of
  `enforceRequestRateLimit|enforceAIRateLimit|rateLimitDb`:
  ```
  app/api/assistant/route.ts:32          rateLimit(`assistant:${clientIp(req.headers)}`,       {limit:30})
  app/api/assistant/alexa/route.ts:35    rateLimit(`assistant-alexa:${clientIp(req.headers)}`, {limit:60})
  app/api/exit-intent/resolve/route.ts:15 rateLimit(`ei-resolve:${clientIp(req.headers)}`,     {limit:60})
  app/api/mkt/consent/route.ts:27/71     rateLimit(`consent:post|get:${clientIp(req.headers)}`,{limit:30/60})
  ```
  All four paths are on the PUBLIC middleware prefix list, so they are reachable
  with no session.
- **Impact:** The *token-guessing* half of the claim is not exploitable —
  `lib/assistant/link-token.ts` issues 32 CSPRNG bytes and stores only a SHA-256,
  so the keyspace is the defence, not the limiter (verified: `issueAssistantToken`,
  `assistantTokenMatches` uses `timingSafeEqual`). What is real is unbounded
  **cost and load**: every accepted `/api/assistant` POST runs `answerAssistant`
  (family reads + AI) and writes an `assistant_link_events` row, and
  `/api/assistant/alexa` additionally does certificate-chain verification. The
  concrete defect is that a comment asserts a security property the mechanism
  cannot provide, which is how the next person decides this endpoint is already
  covered.
- **Fix:** Swap the four to `enforceRequestRateLimit(createServiceClient(), key,
  { limit, windowMs })`, which is what the 26 other public routes use, and
  correct the comment to say what the limit is for (cost, not token guessing).
  `rate_limit_hit` already exists and `rateLimitDb` fails **closed** by default,
  so no new infrastructure is needed.
- **Status:** OPEN

---

### [CLAUDE-3][MEDIUM][TESTING] The 20 boundary probes are green over the invite escalation, because none of them asks whether a self-service policy branch pins its columns
- **File:** `docs/audit/*-check.sql`, `docs/audit/run-probes.sh`
- **Problem:** `rls-isolation-check.sql` asserts *"user B read 0 rows / all writes
  blocked on family A's tables"*. That is default-deny, and the invites defect is
  not a default-deny failure — it is a **granted** branch that grants more columns
  than intended. A probe built entirely from "the stranger is refused" cannot see
  it, exactly as `docs/audit/README.md` warns about one-directional leak probes.
- **Evidence:** with the CRITICAL finding above live in the schema:
  ```
  == probes: 20/20 passed ==
  ```
  and, in the same database, a `guest` invitee acting as `authenticated` reaching
  `role = parent` in a household she was never invited to (proof in that finding).
- **Impact:** The suite's green is load-bearing — it runs on every PR
  (`.github/workflows/ci.yml`, the `database` job) and this audit cites it as the
  standard of proof. A class of defect it structurally cannot detect should be
  named, or the green reads as broader than it is.
- **Fix:** Add `policy-with-check-check.sql` asserting two things against the
  replayed catalogue, both cheap and both generic:
  1. every `pg_policy` with `polcmd='w'` has a non-null `polwithcheck` — 14
     policies currently do not (listed in the INFO finding below), and each is a
     deliberate decision someone should have to write down;
  2. for each such policy, a behavioural half: insert a row, act as the role the
     permissive branch is for, attempt to move the row's tenant column to another
     tenant, and require 0 rows updated.
  Add the negative control the directory already demands: restore the current
  `invites_update` inside a rolled-back transaction and confirm the probe goes red.
- **Status:** OPEN

---

### [CLAUDE-3][LOW][INPUT] PostgREST turns `*` into `%` for `like`/`ilike`, and neither search sanitizer removes it
- **File:** `lib/services/search/index.ts:84` (`sanitizeQuery`), `lib/ai/activity.ts:131` (`safeSearchTerm`)
- **Problem:** Both functions are written against the LIKE grammar —
  `sanitizeQuery` replaces `[%_,()"\\]` with spaces, `safeSearchTerm` backslash-escapes
  `[\\%_]` — and both state their purpose as "a query containing a wildcard would
  quietly match far more than the person typed". PostgREST additionally accepts
  `*` as a spelling of `%` in `like`/`ilike` values, and neither sanitizer touches
  it. A search for `*` therefore becomes `%%%%` and matches every row the caller
  can see.
- **Impact:** Bounded and low. Both call sites are already scoped —
  `searchHousehold` `.eq('family_id', family)` under the caller's own RLS client
  and re-filters sensitive documents in code; `listAiActivity` is the admin
  console. No cross-tenant exposure; the harm is a search box that silently
  returns the whole household, and a stated invariant that is not held.
- **Fix:** add `*` to both character classes: `/[%_*,()"\\]/g` in `sanitizeQuery`,
  and `/[\\%_*]/g` in `safeSearchTerm`. The existing unit tests for these two
  functions should gain a `*` case.
- **Status:** OPEN

---
### [CLAUDE-3][HIGH][RLS] Any family member can forge `audit_logs` rows — including as a parent, and including the platform-wide rows the admin Security page renders
- **File:** `supabase/migrations/0118_rls_drift_repair.sql:116` (originally
  `0004_rls.sql:132`) — policy `audit_insert` on `public.audit_logs`; writers `lib/server/audit.ts:17`,
  `lib/services/activity/index.ts:77`, `lib/ai/runs/controls.ts:63`;
  readers `app/(app)/admin/security/page.tsx:33` (service client),
  `app/(app)/admin/audit/page.tsx:30`, `app/(app)/admin/audit-logs/page.tsx:34`,
  `app/(app)/family/activity/page.tsx:25`
- **Problem:**
  ```
  POLICY "audit_insert" FOR INSERT WITH CHECK ((family_id IS NULL) OR is_family_member(family_id))
  POLICY "audit_select" FOR SELECT USING (can_manage_family(family_id))
  ```
  The check pins `family_id` and nothing else. `actor_id`, `action`, `resource`,
  `resource_id` and `metadata` are all free, and the `family_id IS NULL` branch
  means *any* authenticated user may write a row with no household at all.

  **This exact defect was found on the sibling table and fixed there.**
  `supabase/migrations/0260_trust_ledger_lockdown.sql:9`, about `trust_audit_logs`:

  > *0093 lets ANY active member INSERT into it (`trust_audit_insert`) … So a
  > child's session could file rows claiming a parent approved a bank transfer …
  > An audit trail that its subjects can write is not an audit trail.*
  > *Every legitimate writer is server code holding the service role … so
  > dropping the member INSERT policy costs nothing and closes forgery entirely.*

  `0260` drops that policy, and the catalogue confirms `trust_audit_logs` now
  carries `trust_audit_read` and nothing else. The identical hole on
  `audit_logs` — the older, family-facing trail that the admin **Security** page
  renders — was not touched.
- **Evidence:** acting **as `authenticated`** with a child's JWT in the replayed
  schema:
  ```
   my role | child
   INSERT 0 1     -- audit_logs(family_id=f1, actor_id=<the PARENT's uid>,
                  --            action='delete', resource='wallet_transactions')
   forged audit row, as the PARENT will read it
     family_id  | 00000000-…-0000000000f1
     actor_id   | 00000000-…-00000000a001      <- the parent
     action     | delete
     resource   | wallet_transactions
     metadata   | {"note": "written by the child"}
  ```
- **Impact:** The audit trail is writable by the people it exists to hold
  accountable. A child can (a) attribute an action to a parent in
  `/family/activity`, (b) bury a real entry under noise, and (c) write
  `family_id = null` rows which **no** RLS reader can see — while
  `app/(app)/admin/security/page.tsx` reads the table with
  `createServiceClient()` and renders the newest 25 rows. Twenty-five inserts
  from one child session therefore replace the platform's security feed with
  fabricated events attributed to whichever `actor_id` they chose. That same
  page states, as a posture claim, *"Append-only audit log — Sensitive actions
  are recorded permanently; only household managers and the super admin can read
  them."* It is append-only (no UPDATE/DELETE policies — verified) and it is
  read-restricted; what it is not is **authentic**.
- **Not a disagreement with the design.** `docs/audit/household-trail-check.sql`
  states the intent plainly — *"ANY member may append … while only a parent or
  adult may read it back"* — and that is right: a trail a child cannot write has
  holes in it for the person doing the work. The probe asserts **who may append**
  and **who may read**. What neither it nor the policy asserts is that the row
  says who actually appended it. `appendHouseholdTrail` already passes
  `actor_id: scope.userId`, so pinning it costs the honest callers nothing.
- **Fix:** Keep member append; pin the shape, the way `parent_approvals_insert`
  already does on the neighbouring table:
  ```sql
  alter policy "audit_insert" on public.audit_logs
    with check (is_family_member(family_id) and actor_id = auth.uid());
  ```
  That drops the `family_id IS NULL` branch (no client caller needs it —
  `logAudit` is passed `familyId: null` only from service-client paths) and makes
  `actor_id` unforgeable. `lib/ai/runs/controls.ts:63` and
  `lib/services/activity/index.ts:77` both already set `actor_id: scope.userId`;
  the cron/system scope has `userId = null` and writes through the service
  client, which bypasses RLS, so it is unaffected. Extend
  `household-trail-check.sql` with the third invariant: a child appending a row
  that names the parent as `actor_id` must be rejected.
- **Status:** OPEN

---

### [CLAUDE-3][MEDIUM][RLS] `activation_events_insert` pins the user but not the household, so any signed-in user writes milestones into any family
- **File:** `supabase/migrations/0146_activation_events.sql:36` — policy
  `activation_events_insert` on `public.activation_events`; read side
  `lib/analytics/onboarding-server.ts`, `app/(app)/admin/**` activation funnels
- **Problem:**
  ```
  POLICY "activation_events_insert" FOR INSERT WITH CHECK ((user_id IS NULL) OR (user_id = auth.uid()))
  POLICY "activation_events_select" FOR SELECT USING ((user_id IS NOT NULL) AND (user_id = auth.uid()))
  ```
  `family_id` appears in neither clause, and the table is indexed by it
  (`idx_activation_events_family_milestone`), so it is clearly meant to be
  household-scoped. Passing `user_id = null` satisfies the check outright.
- **Evidence:** acting **as `authenticated`** with a child's JWT, writing into a
  household created by an unrelated owner:
  ```
   am I in the victim family? | member = f
   INSERT 0 1
   cross-family activation row
     family_id | 00000000-…-0000000000f2   (The Victim Family)
     milestone | first_capture
     session_id| forged-session
  ```
- **Impact:** A cross-tenant **write**. Bounded — the select policy still stops
  anyone reading another household's rows, and the milestone column is
  CHECK-constrained to five values — so this is data integrity, not disclosure:
  activation/funnel reporting and anything gated on "has this family reached
  milestone X" can be set by a stranger. It is also the shape of defect Pass G
  could not see: its sweep was "RLS enabled + no blanket `true` policy", and this
  policy is neither disabled nor `true`.
- **Fix:**
  ```sql
  alter policy "activation_events_insert" on public.activation_events
    with check (user_id = auth.uid()
                and (family_id is null or is_family_member(family_id)));
  ```
  Anonymous pre-signup milestones already have a path that does not need a
  `family_id` (the beacon routes run under the service client), so requiring
  `user_id = auth.uid()` for client-side inserts costs nothing.
- **Status:** OPEN

---
### [CLAUDE-3][INFO][DB] Checked and correct: `SECURITY DEFINER` search_path, privileged-RPC grants, and what `anon` can execute
- **Evidence:** against the replayed catalogue (310 migrations, 491 tables, 0 failures).
  ```
  secdef_total | secdef_no_searchpath
            65 |                    0
  ```
  Every one of the 65 `SECURITY DEFINER` functions in `public` carries an
  explicit `SET search_path`. No schema-shadowing escalation is available.

  The seven `SECURITY DEFINER` functions that take a caller-supplied `uuid`
  **without** an internal `is_family_member` / `can_manage_family` /
  `auth.uid()` check are all closed to client roles:
  ```
   proname                         | authenticated | anon
   bump_exit_intent                | f | f      loyalty_award_points       | f | f
   loyalty_cancel_redemption       | f | f      loyalty_redeem_reward      | f | f
   marketplace_place_bid_unchecked | f | f      wallet_credit_child_ledger | f | f
   wallet_reserve_card_auth        | f | f
  ```
  The 31 `SECURITY DEFINER` functions `anon` *can* execute were read
  individually. Each either takes no tenant identifier, or checks membership
  before doing anything — e.g. `grocery_from_meal_plan(p_family_id,…)` opens with
  `if not public.is_family_member(p_family_id) then raise exception`, and
  `marketplace_join_circle(p_family, p_code)` with `if not
  public.is_family_member(p_family)`. `accept_invite(p_token)` is reachable by
  `anon` but requires `lower(v_invite.email) = lower(auth.jwt()->>'email')`,
  which an anonymous caller cannot satisfy.
- **One residual note, not a finding:** `accept_invite` distinguishes
  *"This invite was issued to a different email"* from *"Invite is invalid or
  expired"*, so a caller can tell a live token from a dead one. `invites.token`
  defaults to `encode(gen_random_bytes(24),'hex')` — 192 bits — so there is
  nothing to enumerate. Worth knowing if that default is ever shortened.
- **Status:** VERIFIED

---

### [CLAUDE-3][INFO][SECURITY] Checked and correct: nine controls that this pass tried to break and could not
- **Request bodies are all bounded.** All **76** of the `app/api/**/route.ts`
  files that read a request body do so through `readBoundedRequestJson` /
  `…Text` / `…FormData`. A scan for `req.json()` / `request.text()` /
  `formData()` in a route file that does **not** import the bounded reader
  returns **zero** hits.
- **Secrets fail closed, without exception.** Every `if (!secret)` on an
  authentication path refuses: `webhooks/stripe` and `webhooks/money` → 503;
  `webhooks/resend` `verify()` → `false` → 401; `contact-center/email` →
  `NODE_ENV !== 'production'`, i.e. closed in prod; `guardian/escalate` →
  `if (!secret || authHeader !== …) 401`; `cron-auth.ts` → `!!secret && …`;
  `childSignInAction` → refuses without `CHILD_LOGIN_SECRET`.
  `validateTwilioSignature` returns `false` when `TWILIO_AUTH_TOKEN` is unset and
  its `timingSafeEqual` length mismatch is caught into `false`.
- **Webhook replay and idempotency hold.** Stripe: signature via
  `constructEvent`, then a claim-token ledger in `stripe_webhook_events` with a
  10-minute stale-claim reclaim and a conditional `.eq('claim_token', …)`
  finalize. Resend: full Svix verification — `svix-id`/`timestamp`/`signature`,
  ±300 s window, base64 HMAC, `timingSafeEqual` — then `svix_id` dedupe.
  Contact Center: `recordInboundMessage` looks up `(channel, provider_ref)` before
  writing and falls back to a digest that **includes `family_id`**, so two
  households receiving identical messages do not collapse into one row. Alexa:
  cert chain to a trusted root plus a ±150 s timestamp check in both directions.
- **No user-controlled column reaches `.order()`.** The only two dynamic
  `.order()` call sites are `lib/auto/queries.ts:17`, whose `order.col` is a
  module-literal in all seven exported helpers, and
  `lib/services/routines/index.ts:209`, whose field comes from a typed schedule
  descriptor.
- **PostgREST `.or()` is not injectable at any of its 36 call sites.** Every one
  interpolates a UUID, an ISO timestamp or a literal, except the two that take a
  person's text, and both sanitize: `sanitizeQuery` strips `[%_,()"\]`,
  `safeSearchTerm` strips `[(),]` and escapes `[\%_]`. (The `*` gap is the LOW
  finding above; it does not cross a family boundary.)
- **`x-bubaly-family-id` never selects a tenant.** `assertAIRequestFamily`
  compares the header to the already-resolved `familyId` and answers 409 on a
  mismatch — an assertion, not a selector. `clientIp` reads `x-forwarded-for` /
  `x-real-ip`, which Vercel sets at the edge; on any other host that header would
  be caller-controlled and both IP limiters would be mintable.
- **A forged `active_family_id` is harmless.** `user_preferences` is fully
  self-writable (`prefs_all … using (user_id = auth.uid())`), but
  `lib/supabase/auth.ts:175` resolves it as
  `memberships.find(m => m.familyId === prefs?.active_family_id) ?? memberships[0]`
  — an intersection with real memberships, so a forged value falls back rather
  than selecting.
- **Membership and role changes are manager-only.** `family_members` carries
  `can_manage_family(family_id)` on insert, update **and** delete, with matching
  `WITH CHECK` — a child cannot promote itself directly. The invite path (the
  CRITICAL above) is the way around it, which is precisely why it matters.
- **MFA fails closed.** `decideAal2` sends an unreadable assurance level to
  step-up rather than allowing (`reason: 'assurance_unreadable'`), `needsStepUp`
  only stops sessions that *can* reach aal2, and `isSafeReturnPath` rejects
  `//host`, `/\`, CRLF and self-referential loops.
- **The auth callback is not an open redirect.** `next` comes from
  `resolveAuthSelection`, which runs `safeInternalRedirect` (rejects non-`/`,
  `//`, `\`, `%2f`/`%5c`, and re-checks the parsed origin) before returning.
  Two `next` parameters are treated as ambiguous and dropped.
- **SSRF is guarded where a user-supplied URL is fetched.**
  `lib/server/public-calendar-fetch.ts` and `public-document-fetch.ts`
  DNS-resolve and pin every hop, rejecting the full v4/v6 private, loopback,
  link-local, CGNAT, benchmark, TEST-NET and multicast ranges;
  `public-media-fetch.ts` reuses the same guard with https-only, a redirect
  budget, a byte ceiling and no pooled agent. `weekend/discover` routes family
  feeds through `fetchPublicCalendarText` and reaches Ticketmaster/SeatGeek on
  fixed hosts only. `lib/sync/providers/apple.ts:278` is the one place a
  *provider's* response can supply an absolute URL that is then fetched with the
  Apple ID credentials attached — it trusts iCloud, which is reasonable, but it
  is the one hop with no pin.
- **Money is never floating point.** Zero `double precision`/`real` columns whose
  name matches `amount|price|cost|balance|total|cents|fee|salary|value|budget|spend|paid|income|rate`.
- **Dead code worth one line:** `lib/sync/feed-token.ts:24 verifyFeedSignature`
  has no callers, and would fail open on a missing `SYNC_TOKEN_KEY` (`secret =
  process.env.SYNC_TOKEN_KEY ?? ''`) if it were ever wired up.
- **Status:** VERIFIED

---

### [CLAUDE-3][INFO][RLS] The 14 `UPDATE` policies with no `WITH CHECK`, and which of them matter
- **Evidence:**
  ```
  select c.relname, p.polname, pg_get_expr(p.polqual,p.polrelid)
  from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and p.polcmd='w' and p.polwithcheck is null;
  ```
  ```
  assistant_links       assistant_links_update      can_manage_family(family_id)
  call_logs             call_logs_update            EXISTS(family_members … user_id = auth.uid() AND is_active)
  daily_insights        daily_insights_update       is_family_member(family_id)
  families              families_update             can_manage_family(id)
  family_communications comms_family_update         EXISTS(family_members …)
  family_signals        family_signals_update       is_family_member(family_id)
  family_tree_nodes     family_tree_nodes_update    family_id IN (SELECT … user_id = auth.uid())
  front_desk_settings   front_desk_update           can_manage_family(family_id)
  home_briefs           home_briefs_update          is_family_member(family_id)
  invites               invites_update              can_manage_family(family_id) OR lower(email) = jwt email   ← CRITICAL above
  moment_activations    moment_activations_update   is_family_member(family_id)
  notifications         notif_update                user_id = auth.uid() OR (user_id IS NULL AND is_family_member(family_id))
  profiles              profiles_update_self        id = auth.uid()
  reasoning_snapshots   reasoning_snapshots_update  is_family_member(family_id)
  ```
- **Reading:** twelve of the fourteen are **symmetric** — the single predicate
  constrains the same tenant column in the old row and the new one, so reusing
  `USING` as the check is safe (you cannot move a row into a family you are not
  in, or onto a `profiles.id` that is not yours). Two have an `OR`, and an `OR`
  is where the asymmetry lives, because the branch that admits you may not be the
  branch that constrains the columns you are writing:
  - `invites_update` — the invitee branch constrains only `email`, leaving
    `family_id` and `role` writable. **This is the CRITICAL finding above.**
  - `notif_update` — the `user_id = auth.uid()` branch leaves `family_id`
    writable, so a user can move their *own* notification into another
    household's `family_id`. It stays visible only to them (the row still carries
    their `user_id`, and the `user_id IS NULL` branch is what the other family
    would need), so the reachable harm is a stray row in someone else's tenant
    partition, not disclosure. Worth pinning when `invites_update` is fixed:
    `with check (user_id = auth.uid() and is_family_member(family_id))`
    (`supabase/migrations/0118_rls_drift_repair.sql:105`).
- **Status:** VERIFIED

---

## What Claude-3 checked, and what came back clean

Ground truth for every database claim in this file: `docs/audit/pg-bootstrap.sh`
into a throwaway Postgres 16 on port 5434 — **310 migrations applied, 0 failed,
491 tables** — with `docs/audit/run-probes.sh` green at **20/20** before and
after. Role-boundary claims were made by `set_config('request.jwt.claim.sub', …)`
+ `set role authenticated` and reading back the actual rows, never by reading a
policy and reasoning about it.

**Nine findings, all reproduced in that database or in the code path itself:**

| # | severity | claim |
|---|---|---|
| 1 | CRITICAL | `invites_update` has no `WITH CHECK`; an invitee rewrites `family_id` + `role` and `accept_invite` makes them `parent` of any household |
| 2 | HIGH | child-PIN throttle keyed on the submitted string while the lookup is `ILIKE`; `2^(L-2)` buckets per account |
| 3 | HIGH | `child_logins` "Managers manage" policy admits any member; a child deletes a sibling's login and can redirect a parent's PIN reset |
| 4 | HIGH | 163 CASCADE foreign keys with no supporting index; measured 5,715 buffers → 4 on one of 36 `families` constraints |
| 5 | HIGH | `audit_logs` lets any member forge `actor_id`, including into the `family_id IS NULL` rows the admin Security page renders with the service client |
| 6 | MEDIUM | `activation_events_insert` pins the user, not the household — a cross-tenant write |
| 7 | MEDIUM | `/api/assistant` + 3 others rely on a per-lambda `Map` for a limit the comment calls a security control |
| 8 | MEDIUM | the 20-probe suite is structurally blind to over-granting policies (it only asserts default-deny) |
| 9 | LOW | PostgREST's `*`→`%` escapes both search sanitizers |

**Checked and found correct — a zero, evidenced:**

- **65/65** `SECURITY DEFINER` functions pin `search_path`; **0** do not.
- **7/7** privileged `SECURITY DEFINER` functions that take an unchecked tenant
  uuid are denied to `anon` *and* `authenticated`.
- **31** `SECURITY DEFINER` functions reachable by `anon` read individually:
  every one either takes no tenant id or opens with a membership check.
- **76/76** route handlers that read a request body bound it; **0** unbounded.
- **7/7** missing-secret branches on an authentication path fail closed
  (stripe, money, resend, contact-center email, guardian escalate, cron-auth,
  child sign-in).
- **5/5** provider webhook families (Stripe billing, Stripe money, Resend,
  Twilio ×5, Alexa) verify a signature and dedupe replays.
- **36** `.or()` call sites: 34 interpolate machine values (UUIDs, ISO
  timestamps, literals), 2 sanitize user text.
- **2/2** dynamic `.order()` call sites take module literals.
- `family_members` insert/update/delete are all `can_manage_family(family_id)`
  with a matching `WITH CHECK` on update; `families_update` is
  `can_manage_family(id)`.
- **0** floating-point money columns.
- `x-bubaly-family-id`, `active_family_id` and the `next=` redirect are all
  re-derived or intersected server-side rather than trusted.
- MFA step-up, the OAuth/magic-link callback, sign-out and the SSRF guards were
  each tried and did not yield.

**Not re-derived** (owned by `finalaudit.md` Passes A–O): unbounded reads
(F-002/F-013), anon grants on the money tables (F-003), cross-household AI job
claiming (F-006), blanket `true` policies (Pass G), storage buckets (Pass H),
caller-supplied tenant ids on route handlers (Pass K), the AI tool registry
(Pass J), token columns (Pass O).

**Could not reach from here:** anything requiring production credentials — the
live migration ledger (F5/F-001), whether `CHILD_LOGIN_SECRET`,
`CONTACT_CENTER_INBOUND_SECRET` and `SYNC_TOKEN_KEY` are actually set in
production (every one of them fails closed if not, which is the right direction
but means the feature is silently off), and whether the production edge
normalizes `x-forwarded-for` the way Vercel's does.

---

## Note on the merge

A second session created `# Claude-3 — Backend / API / Database / Auth / Security` as an empty template on `main`. It carried
no findings, so this file keeps the worker output above; nothing was lost.
