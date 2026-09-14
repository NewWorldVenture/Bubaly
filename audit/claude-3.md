# Claude-3 — Backend / API / Database / Auth / Security

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

# ══════════════════════════════════════════════════════════════════════════
# SESSION 3 — 2026-09-14 (parallel audit, Claude-3)
# New ground only. Nothing above this line is edited or removed.
#
# Out of scope by instruction (already closed by PR #548 / 0296): the
# family_credentials vault, invites_update's missing `with check` (0297),
# allowance_rules + the five sibling wallet tables (0298), medications /
# medication_schedules (0299), grades / screen_time_limits (0300),
# child_logins / behavior_logs (0301). Also already proven sound elsewhere and
# not re-derived here: Stripe webhook signature verification, the SSRF
# defences, notification recipient scoping, AI-memory trait privacy, all 24
# cron routes' hasCronAuthorization, the wallet/marketplace/circle SECURITY
# DEFINER RPCs, bearer/AAL2/middleware checks, rate_limits being RPC-only.
#
# Every DB statement below was run against the live replay
# (PGHOST=/tmp PGPORT=54401 PGDATABASE=bubaly, 313 migrations, SEED_ALL,
# 22/22 existing probes green) as a real `authenticated` session:
#   perform set_config('request.jwt.claim.sub', '<uid>', true); set local role authenticated;
# which is exactly what PostgREST does for a browser holding the anon key. A
# child IS a real Supabase auth user here (child-login-actions.ts calls
# admin.auth.admin.createUser), so a child can call PostgREST directly and RLS
# is the only boundary that binds.
# ══════════════════════════════════════════════════════════════════════════

```
[CLAUDE-3][CRITICAL][RLS/MONEY] A child can rewrite the price of their own chores, and every payout path reads the price back off the row they rewrote
Path:     public.chores — policy `chores_update` (UPDATE, qual+check = is_family_member(family_id))
          public.chore_assignments — policy `chore_assignments_update` (same)
          app/(app)/wallet/actions.ts:205-206   amount = assignment.cash_awarded_cents ?? chore?.cash_cents ?? 0
          app/(app)/missions/actions.ts:255-262 finalizeApproval → computeReward(rewardConfig(chore), score)
          app/(app)/missions/actions.ts:203-221 auto-approve, run under createServiceClient()
          lib/rewards/points.ts:29-30           points balance = Σ points_awarded where status='approved'
          lib/chores/logic.ts:51-75             computeReward — Math.max(0, …) is the ONLY bound
          lib/chores/logic.ts:85-95             canAutoApprove — returns score >= chore.auto_approve_score
Problem:  The chores economy's PRICE LIST lives in `public.chores`
          (points, cash_cents, cash_min_cents, cash_max_cents, points_min,
          points_max, reward_mode, auto_approve_score) and in
          `public.chore_assignments` (points_awarded, cash_awarded_cents).
          Both tables are UPDATE-able by `is_family_member(family_id)` — i.e.
          by the child who gets paid. The app gates chore authoring to managers
          (`refuseUnlessManager`, app/(app)/dashboard/chores/actions.ts:92-99,
          whose own comment says "the check sits here … because here is where
          the screen's claim lives"), but the browser talks to PostgREST with
          the anon key, so the server action is not the boundary — the policy is.

          Three cash-out paths all re-read the tampered value instead of
          re-deriving it:
            1. payChoreRewardAction (manager-only, but the AMOUNT is the child's
               number): `amount = assignment.cash_awarded_cents ?? chore.cash_cents`,
               then creditChildWallet. No upper bound, no comparison with what the
               chore was originally worth. evaluateTrust's `maxAmountCents` is a
               per-family policy row that does not exist by default
               (lib/trust/engine.ts:232 — the cap is opt-in).
            2. auto-approve: `canAutoApprove` returns true as soon as
               `verdict.quality_score >= chore.auto_approve_score`, and
               auto_approve_score is child-writable. Set it to 0 and the parent is
               out of the loop entirely; finalizeApproval then runs under the
               SERVICE ROLE and writes points_awarded / cash_awarded_cents from the
               tampered chore row.
            3. points: lib/rewards/points.ts sums `points_awarded` over approved
               assignments; that total is what reward_redemptions spends.

          0223's trigger `chore_assignment_decision_guard` does not cover this.
          It fires only on a transition INTO 'approved'/'rejected'
          (`new.status is distinct from old.status`), so an UPDATE that changes
          only cash_awarded_cents on an already-approved row passes untouched.
Evidence: Live, as a real child session (scratchpad p2-chore-price.sql). Parent
          creates the chore at $2.00 / 5 pts / no auto-approve; child then:

            perform set_config('request.jwt.claim.sub', child_uid::text, true);
            set local role authenticated;
            update public.chores set cash_cents = 5000000, points = 99999,
                   auto_approve_score = 0, cash_max_cents = 5000000,
                   points_max = 99999, reward_mode = 'fixed_cash' where id = ch;
            update public.chore_assignments
               set cash_awarded_cents = 4242424, points_awarded = 88888 where id = asg;

          returned:
            NOTICE: CHILD rewrote the PARENT-created chore price rows=1
            NOTICE: CHILD set cash_awarded_cents/points_awarded on its own
                    APPROVED assignment rows=1 (decision guard did NOT fire)
            NOTICE: AFTER: chores.cash_cents=5000000 points=99999
                    auto_approve_score=0 | assignment.status=approved
                    cash_awarded_cents=4242424

          Ruled out a guard elsewhere:
            · `select tgname from pg_trigger … relname='chores' and not tgisinternal`
              → only `trg_set_updated_at`. No decision guard on the price table.
            · chore_assignments' two triggers are `trg_set_updated_at` and
              `trg_chore_assignment_decision_guard`; the latter's body was dumped
              with pg_get_functiondef and guards `new.status` only.
            · payChoreRewardAction was read end to end (wallet/actions.ts:191-236):
              it checks isManager, checks for an existing wallet_transaction on the
              same assignment (so it is idempotent), and calls evaluateTrust — but
              never re-derives the amount or bounds it.
            · lib/services/tasks/index.ts:417 rejects NEGATIVE points; there is no
              upper bound anywhere, and that path is the manager-gated one anyway.
Impact:   A child with the ordinary Bubaly app (no tooling beyond the anon key the
          app already ships to their browser) can (a) mint unlimited points and
          spend them on rewards, (b) set the price a parent is shown and pays on
          the chores board, and (c) with auto_approve_score = 0 take the parent
          out of the approval loop so the service role stamps the payout. This is
          the same class as the closed allowance_rules CRITICAL — a child-writable
          input that a trusted server path later treats as authority — on the
          surface that fix did not cover.
Fix:      Narrow the write side of both policies to managers and keep the reads:
            drop policy chores_update on public.chores;
            create policy chores_update on public.chores for update
              using (can_manage_family(family_id)) with check (can_manage_family(family_id));
            -- chore_assignments: members must still move their OWN assignment
            -- through the member-driven statuses, so restrict the columns rather
            -- than the row — extend chore_assignment_decision_guard to raise when
            -- a non-manager changes points_awarded, cash_awarded_cents or
            -- approved_by/approved_at at all, on INSERT or UPDATE, regardless of
            -- whether status also changed.
          Belt and braces in the payout path: in payChoreRewardAction, take the
          amount from the chore's price as a manager last saved it and reject an
          assignment whose cash_awarded_cents exceeds it.
Status:   VERIFIED (proven on the live replay)
```

```
[CLAUDE-3][MEDIUM][RLS/PRIVACY] `journal_entries.is_private` is honoured nowhere — any family member can read, edit, delete and forge another member's journal
Path:     public.journal_entries — single policy "Members manage journal_entries"
          (ALL, qual = check = is_family_member(family_id))
          components/modules/journal-module.tsx:47-62
          lib/trust/sharing-presets.ts:19-31 (the repo's own TODO for this)
Problem:  The table carries a `member_id` and an `is_private boolean`, and the
          module calls itself "a private space to reflect". Neither column is
          consulted by anything that enforces:
            · RLS is a single FOR ALL policy on family membership;
            · the module scopes reads client-side with `.eq('member_id', memberId)`;
            · `remove(id)` is `.delete().eq('id', id)` — no member predicate at all.
          `is_private` appears in the whole repo only in lib/database.types.ts.
          It is a dead column that reads, to anyone maintaining this, like a guard.
Evidence: `grep -rn "is_private" app lib components` → 3 hits, all in
          lib/database.types.ts:827-829 (the generated Row/Insert/Update types).
          No query filters on it.

          Live, as a real child session (scratchpad p1-journal.sql) — parent
          writes an entry with is_private = true, then the child:
            NOTICE: CHILD sees parent private journal rows: 1
            NOTICE: CHILD read body: I am worried about the divorce and money.
            NOTICE: CHILD updated parent private journal rows: 1
            NOTICE: CHILD deleted parent private journal rows: 1
            NOTICE: CHILD inserted an entry under the PARENT member_id: ok

          Ruled out a guard elsewhere: the only two readers of the table are
          components/modules/journal-module.tsx (a 'use client' component using
          lib/supabase/client's anon key — so RLS is the only boundary) and
          app/api/ai/journal/route.ts. There is no server proxy in front of it.
          The repo KNOWS about the read half: lib/trust/sharing-presets.ts:19-22
          says "Per-member read scoping is M23's RLS migration (documents/notes/
          journal on member_id …) … Neither is shipped". That note covers READS
          only, and explicitly not the destructive half — a sibling silently
          deleting a parent's journal is not read-scoping.
          The sibling table proves the pattern is available: `documents_select`
          is `is_family_member(family_id) AND (NOT is_sensitive_document(...) OR
          can_manage_family(family_id))`.
Impact:   Every family member reads every other member's journal, including a
          child reading a parent's, and can destroy or forge entries. The forge
          is the worst of the three: an entry written by a child under a parent's
          member_id is indistinguishable from the parent's own in every surface
          that renders the journal.
Fix:      Replace the one FOR ALL policy with member-scoped ones:
            using ( is_family_member(family_id)
                    and (member_id is null or is_self_member(member_id)
                         or (not is_private and can_manage_family(family_id))) )
          and a `with check` that pins member_id to `is_self_member(member_id)`
          so an entry cannot be written under someone else's name. `is_self_member`
          already exists (0266) and is used this way elsewhere.
Status:   VERIFIED (proven on the live replay)
```

---
---

# ══ SESSION 3 (2026-09-14) — new ground ══════════════════════════════════════

Nothing below re-derives anything above, and nothing closed by PR #548 /
0296–0301 is re-reported. Harness: a private PG16 on `/tmp/pg3:54403`,
`docs/audit/pg-bootstrap.sh`, **315 migrations applied / 0 failed**
(pgvector installed, so 0237 and its dependants replay too), SEED_ALL applied,
`docs/audit/run-probes.sh` **23/23 PASS** before any probing began.

Every RLS finding below was run as a real `authenticated` session
(`set_config('request.jwt.claim.sub', …)` + `set local role authenticated`) —
i.e. exactly what PostgREST does for a browser holding the anon key. A child is
a real Supabase auth user (`app/(app)/family/child-login-actions.ts`), so RLS is
the only boundary on that path.

Probe scripts: `scratchpad/probe1.sql` (health/location), `probe2.sql`
(economy), `probe3.sql` / `probe4.sql` (billing).

## Findings

```
[CLAUDE-3][CRITICAL][RLS/MONEY] A child sets the price of their own reward redemption, and the approval RPC debits the price they wrote
Path:     policy `economy_redemptions_insert` (INSERT, with check `is_family_member(family_id)`)
          function public.economy_decide_redemption(uuid,boolean,text)  — SECURITY DEFINER
          app/(app)/economy/actions.ts:159-166 (requestRedemptionAction)
          app/(app)/economy/page.tsx:30 (what the approving parent is shown)
Problem:  `requestRedemptionAction` is careful: it reads `economy_rewards.cost`
          server-side and copies it onto the redemption row. But the row is a
          plain table the child can INSERT into directly through PostgREST —
          the INSERT policy constrains only `family_id`, not `cost`, not
          `member_id`, not `status`. And `economy_decide_redemption` debits
          `v_redemption.cost` — the value ON THE ROW — never re-reading
          `economy_rewards.cost` for `v_redemption.reward_id`, even though it
          already SELECTs that reward row (for `stock`) two statements earlier.
          The parent's approval screen renders `title` and `cost` from the same
          child-written row, so the forgery is invisible at the moment of consent.
Evidence: live, as real sessions (scratchpad/probe2.sql). Parent creates a
          "PlayStation 5" reward at 5000 stars and credits the child 10 stars:
            NOTICE: child balance before: 10 stars; the reward costs 5000
            NOTICE: 1 child INSERTED a pending redemption for "PlayStation 5" at cost=1
            NOTICE: 2 child self-INSERTED a row already marked fulfilled/decided_by=parent: 1 row(s)
            NOTICE: 3 child INSERTED a redemption whose member_id is the PARENT: 1 row(s)
            NOTICE: 4 parent approval result: {"ok": true, "status": "fulfilled", "txn_id": "de19…"}
            NOTICE: 4 redemption status=fulfilled ; child balance AFTER redeeming a 5000-star reward: 9 stars
            NOTICE: 4 the debit the ledger recorded: 1 stars
          `cost > 0` is the only constraint (`economy_redemptions_cost_check`),
          so 1 is the floor, not 0.
          Ruled out a guard elsewhere:
            · pg_trigger on economy_redemptions = `trg_economy_redemptions_updated_at`
              only (set_updated_at). No decision guard — unlike `reward_redemptions`,
              which DOES carry `trg_reward_redemption_decision_guard`. The sibling
              table got the trigger; this one did not.
            · The three other policies (`_mng_update`, `_mng_delete`, `_select`)
              are manager-gated; only INSERT is open, and INSERT is the whole attack.
            · The RPC's own manager check (`can_manage_family`) is intact — it
              gates WHO approves, not WHAT is approved.
            · The UI path is irrelevant: `components/modules/…` reach this table
              with lib/supabase/client's anon key.
Impact:   Any child in any family drains the reward catalogue for ~nothing, and
          the household ledger records a debit that reconciles perfectly against
          a forged price. Two further variants in the same probe: a child can
          insert a row already `status='fulfilled'` with `decided_by` set to a
          parent (a forged approval no parent ever gave), and can insert a
          redemption whose `member_id` is a SIBLING or PARENT — billing someone
          else's balance for their own reward.
Fix:      Two changes, both small.
          1. In `economy_decide_redemption`, when `reward_id is not null`, take
             cost from the reward row it already locks:
               select id, stock, cost into v_reward … ;
               if v_has_reward then v_cost := v_reward.cost; else v_cost := v_redemption.cost; end if;
             and use `v_cost` for the balance check and the debit.
          2. Tighten the INSERT policy so a member can only ask for themselves,
             in the pending state:
               with check ( is_family_member(family_id)
                            and is_self_member(member_id)
                            and status = 'pending'
                            and requested_by = auth.uid() )
             (`is_self_member` exists since 0266.) Managers requesting on a
             child's behalf keep working via an added `or can_manage_family(family_id)`.
Status:   VERIFIED (proven on the live replay)
```

```
[CLAUDE-3][HIGH][RLS/BILLING] A family admin writes their own `subscriptions` row, and that row IS the paywall
Path:     policy `subs_manage` — ALL, roles {public}, using/with check `is_family_admin(family_id)`
          lib/server/entitlement.ts:86-95 (resolveEntitlement)
          lib/server/plan.ts:36-51 (resolveFamilyPlanLevel)
Problem:  Entitlement is computed from `subscriptions.plan` + `.status`:
          `paidLevel = max(planLevel(s.plan))` over rows with
          `status in ('active','trialing')`. That table is directly writable by
          the customer: `subs_manage` grants ALL to anyone `is_family_admin`,
          which is every `role='parent'` member of the family. No trigger, no
          check constraint, no restrictive guard. The row that decides whether a
          family has paid is written by the family.
Evidence: live, as a real parent session (scratchpad/probe3.sql), on a family
          whose 5-day trial expired 30 days ago (so `computeEntitlement` would
          return locked):
            NOTICE: the auto-provisioned row says: free / trialing
            NOTICE: self-granted Family+ subscription: 1 row(s) REWRITTEN by a PARENT via RLS
            NOTICE: subscriptions now reads: plus_annual / active  -- exactly the row resolveEntitlement() sums into paidLevel
            NOTICE: parent also rewrote their own families.trial_ends_at: 1 row(s)
            NOTICE: parent can clear families.closed_at: 1 row(s)
          Catalogue: `select … from pg_policies where tablename='subscriptions'`
          returns exactly `subs_manage` (ALL) and `subs_select`; `pg_trigger`
          returns only `trg_set_updated_at`; `pg_constraint` returns two FKs and
          the PK. `information_schema.role_table_grants` shows `authenticated`
          holds INSERT/UPDATE/DELETE (Supabase default privileges).
          Ruled out a guard elsewhere: every legitimate writer of this table is
          server-side and service-role — app/api/webhooks/stripe/route.ts:73,79,
          app/api/billing/{change-plan,cancel}/route.ts, app/(app)/admin/actions.ts.
          `grep -rn "from('subscriptions')" app lib components` finds NO client
          component writing it. The client write privilege is pure excess; nothing
          in the product needs it.
          The same is true of `families_update` (`can_manage_family(id)`), which
          is how `trial_ends_at` and `closed_at` — the other two inputs to
          `computeEntitlement` — are also self-writable.
Impact:   Revenue. Any parent bypasses the paywall permanently with one PostgREST
          call and the public anon key: Family+ (level 2), never expiring,
          nothing charged. The same write also un-closes a soft-closed account,
          which is the lever an operator pulls for abuse or non-payment.
Fix:      Revoke the client write. Replace `subs_manage` with a select-only
          posture and let the service role (which bypasses RLS) keep doing the
          writing it already does:
            drop policy subs_manage on public.subscriptions;
            revoke insert, update, delete on public.subscriptions from authenticated, anon;
          Same for `billing_customers` (`billing_manage`) — see the next finding.
          For `families`, keep the update policy but stop it moving the billing
          columns, e.g. a restrictive UPDATE guard asserting
          `trial_ends_at is not distinct from old` is not expressible in RLS, so
          use a BEFORE UPDATE trigger that resets `trial_ends_at`/`closed_at` to
          their prior values unless the writer is the service role.
Status:   VERIFIED (proven on the live replay)
```

```
[CLAUDE-3][HIGH][BILLING/AUTHZ] The Stripe object ids the server hands to the Stripe API are client-writable, and neither billing route checks ownership
Path:     policy `billing_manage` on public.billing_customers (ALL, `is_family_admin(family_id)`)
          policy `subs_manage` on public.subscriptions (ALL, `is_family_admin(family_id)`)
          app/api/billing/portal/route.ts:20-45
          app/api/billing/change-plan/route.ts:94-124, 144-168
          lib/billing/plans.ts:14-16 (canChangeSubscriptionInPlace)
Problem:  Both routes authenticate the caller correctly, then read a Stripe
          identifier out of a table the caller can write and pass it straight to
          Stripe without ever asking Stripe whether that object belongs to this
          family.
            · portal: `stripe.billingPortal.sessions.create({ customer: data.customer_ref })`
              where `customer_ref` comes from `billing_customers` — writable.
            · change-plan: `stripe.subscriptions.update(sub.provider_ref, { …, metadata: { family_id: familyId } })`
              where `provider_ref` and `status` come from `subscriptions` — writable.
              `canChangeSubscriptionInPlace` only checks `provider_ref` is
              non-null and `status in ('active','trialing','past_due')`; both are
              attacker-set. It never compares `stripeSub.customer` or
              `stripeSub.metadata.family_id` against the caller's family.
            · change-plan's checkout branch: `stripe.checkout.sessions.create({ customer: customerId })`
              with the same writable `customer_ref`.
Evidence: live, as a real parent session (scratchpad/probe4.sql):
            NOTICE: parent wrote their own billing_customers row: 1 row(s)
            NOTICE: parent repointed customer_ref at another Stripe customer: 1 row(s); now reads cus_SOMEONE_ELSE
            NOTICE: parent repointed subscriptions.provider_ref: 1 row(s); now reads sub_SOMEONE_ELSE / active
          Code read for the ownership check that would stop it: portal/route.ts
          is 55 lines end to end and contains no Stripe-side verification;
          change-plan verifies the PRICE against Stripe (`verifyStripePlanPrice`)
          but never the subscription's owner.
          Ruled out a guard elsewhere: the Stripe webhook is NOT the mitigation —
          it resolves the family from `sub.metadata.family_id`
          (app/api/webhooks/stripe/route.ts:19), which is precisely the field
          `change-plan` lets the caller overwrite on someone else's subscription.
          `grep -rn "billing_customers" app lib` shows all five other call sites
          are server-side; nothing in the product needs the client write.
Impact:   With a victim's `cus_…` id, a portal session is minted for THEIR Stripe
          customer: saved payment methods, invoice history, and the ability to
          cancel their plan. With a victim's `sub_…` id, `change-plan` re-prices
          their subscription (prorated against their card) and rewrites its
          `metadata.family_id` to the attacker's family, so the next webhook
          marks the ATTACKER paid off the victim's money. Exploitation needs a
          Stripe id the attacker does not normally see, which is the only thing
          keeping this below CRITICAL — the authorization boundary itself is
          simply absent, and a Stripe id is not a secret (it appears on invoices,
          receipts, and in support threads).
Fix:      1. Revoke the client write (same one-liner as the previous finding) —
             this alone closes it.
          2. Defence in depth, 3 lines each: in portal, retrieve the customer and
             assert `customer.metadata.family_id === familyId`; in change-plan,
             after `stripe.subscriptions.retrieve`, assert
             `stripeSub.metadata.family_id === familyId` before updating.
             Both objects are already created WITH that metadata
             (change-plan/route.ts:159, checkout/route.ts), so the check is free.
Status:   VERIFIED (write proven on the live replay; the missing check read from source)
```

```
[CLAUDE-3][HIGH][RLS/HEALTH] Nine health tables are `FOR ALL … is_family_member` — a child rewrites and deletes a parent's medical record
Path:     policies `Members manage health_visits`, `Members manage immunizations`,
          `symptom_logs_all`, `Members can manage health_metrics`, `health_goals_all`,
          `Members can manage care_log`, `sleep_logs_all`, `sleep_checkins_all`,
          and `nutrition_logs_{insert,update,delete}` — all `is_family_member(family_id)`
Problem:  0299 closed `medications` and `medication_schedules` with three
          restrictive manager guards each. The nine sibling tables in the same
          health feature did not get them. Each is one permissive `FOR ALL`
          policy keyed on membership, so every row — including rows whose
          `member_id` is somebody else — is writable and deletable by any member,
          a child included. `lib/ai/context/policy.ts` names all nine SENSITIVE
          and forbids the AI from reading them; the browser reaches them directly.
Evidence: live, as real sessions (scratchpad/probe1.sql). Parent records a
          cardiology visit and a symptom log for THEMSELVES and an MMR
          immunization for the child; then, as the child:
            NOTICE: B child UPDATE own immunization: 1 row(s)
            NOTICE: B child DELETE own immunization: 1 row(s)
            NOTICE: C child REWRITES the PARENT's cardiology visit: 1 row(s)
            NOTICE: C child DELETES the PARENT's symptom log: 1 row(s)
          Catalogue confirming the shape:
            select tablename,cmd,permissive,qual from pg_policies
             where tablename in (…) ;
          returns exactly one PERMISSIVE `ALL` row per table with
          `qual = with_check = is_family_member(family_id)`, and
          `select … from pg_policies where permissive='RESTRICTIVE'` (62 rows)
          contains none of these nine.
          Ruled out a guard elsewhere: `pg_trigger` on these tables returns only
          `set_updated_at`. The read/write surfaces are client components
          (components/modules/medical-records-module.tsx,
          components/modules/care-module.tsx) using the anon key, so there is no
          server proxy in front. The *reads* are gated in two server pages
          (family-health, family-emergency) — which is the point: the app knows
          this data is manager-only and expresses it in the wrong layer.
Impact:   A child can erase their own immunization record (the row a school or a
          clinician asks for), rewrite a parent's visit outcome, and delete the
          symptom log a parent is keeping to decide whether to go to the ER. It
          is the `medications` defect with a different table name, and 0299's fix
          is a copy-paste away.
Fix:      Apply 0299's pattern verbatim to the nine, splitting them the way 0300
          split `grades` from `screen_time_limits`:
            · care records ABOUT a person — health_visits, immunizations,
              health_metrics, health_goals, care_log → manager-gated write
              (`can_manage_family(family_id)` restrictive INSERT/UPDATE/DELETE).
            · self-logged records — symptom_logs, sleep_logs, sleep_checkins,
              nutrition_logs → author-or-manager, i.e.
              `can_manage_family(family_id) or is_self_member(member_id)`,
              mirroring `behavior_logs_author_update_guard`.
Status:   VERIFIED (proven on the live replay)
```

```
[CLAUDE-3][HIGH][RLS/SAFETY] A child can move a parent's dot on the family map, silence their sharing, and forge their arrivals
Path:     policies `Members can manage member_locations`, `Members can manage location_events`,
          `safety_check_ins_{insert,update,delete}` — all `is_family_member(family_id)`
          app/(app)/dashboard/locator/actions.ts:28-31 and :58-63
Problem:  The server action says so itself, at line 30:
            "Strictly self-only — a member can only post their own location."
          and enforces it properly, writing `member_id: member.id` from the
          session. The RLS under it enforces nothing of the kind: one permissive
          `FOR ALL … is_family_member` policy per table. Any member can upsert
          ANY member's `member_locations` row, insert `location_events` under
          anyone's `member_id`, and edit or delete anyone's `safety_check_ins`.
          The stated rule exists in the one layer the browser does not have to go
          through.
Evidence: live, as a real child session (scratchpad/probe1.sql). Parent's live
          location is seeded at 40.7128 / -74.0060 (New York):
            NOTICE: D child SPOOFS the PARENT's live location + stops their sharing: 1 row(s)
            NOTICE: D parent now appears at latitude 34.0522          ← Los Angeles
            NOTICE: D child FORGES a location event for the PARENT: 1 row(s)
          The update set `is_sharing=false` in the same statement, so the parent
          also drops off the map for everyone else.
          Ruled out a guard elsewhere: `components/modules/locator-module.tsx:91-100`
          and `components/family/find-phone-view.tsx:24` are 'use client' and read
          through the anon key — the table is on the public API surface whether or
          not the action is used. `pg_trigger` on both tables is `set_updated_at`
          only. No restrictive policy on either (checked against the 62-row
          RESTRICTIVE catalogue).
Impact:   This is the safety feature. A teenager makes themselves appear at home,
          fabricates an "arrived at School" event on the timeline a parent checks,
          or hides a parent from the map. It also runs the other way: a member can
          plant a false location trail for someone else, which is the shape of the
          record a custody or safeguarding dispute would later rely on.
Fix:      Pin the subject to the writer and let managers see everything:
            member_locations / location_events / safety_check_ins:
              using      ( is_family_member(family_id) )                    -- reads unchanged
              with check ( is_family_member(family_id) and is_self_member(member_id) )
            and restrict UPDATE/DELETE to
              `is_self_member(member_id) or can_manage_family(family_id)`.
          A child writing their own position keeps working; writing someone
          else's stops.
Status:   VERIFIED (proven on the live replay)
```

```
[CLAUDE-3][MEDIUM][RLS/PRIVACY] `medical_profiles` is manager-gated in three places in the app and member-readable in the policy
Path:     policy `Members can read medical_profiles` (SELECT, `is_family_member(family_id)`)
          app/api/ai/pantry-chef/route.ts:128-130
          app/(app)/dashboard/family-health/page.tsx:26-32
          app/(app)/dashboard/family-emergency/page.tsx:24-31
Problem:  The repo states the rule plainly — pantry-chef/route.ts:129 reads the
          allergies with the SERVICE client and explains why: "(medical_profiles
          is manager-gated to clients)". family-health/page.tsx:26 says "Health
          data is sensitive — surfaced only to managers in summary form here" and
          gates the read on `isManager(ctx.active.role)`; family-emergency does
          the same. The write policies ARE manager-gated (three `Managers can …`
          policies). The SELECT policy is not: any member reads every row.
Evidence: live, as a real child session (scratchpad/probe1.sql), against a
          profile the parent wrote for themselves:
            NOTICE: A medical_profiles rows a CHILD can SELECT: 1
            NOTICE: A child reads parent profile: AB- / Epilepsy / Lamotrigine 200mg
          The columns reachable are blood_type, conditions, current_medications,
          primary_physician, preferred_pharmacy, pharmacy_phone, and the three
          emergency_contact_* fields.
          Ruled out a guard elsewhere: no RESTRICTIVE policy on the table (62-row
          catalogue); `pg_trigger` returns `set_medical_profiles_updated` only;
          `components/modules/medical-records-module.tsx:28` types straight off
          `Tables<'medical_profiles'>` and reads with the anon key, so the two
          server pages' `manager ?` ternaries are not on the only path.
Impact:   A child reads every family member's diagnoses, prescriptions and
          physician. It is the exact case §4 and the AI deny-list are written to
          prevent, and it is worth noting the deny-list only binds the model —
          the human with a browser was never in scope.
Fix:      Give SELECT the shape `documents_select` already uses:
            using ( is_family_member(family_id)
                    and (can_manage_family(family_id) or is_self_member(member_id)) )
          A member keeps their own profile; managers keep everything; the
          allergy projections that meals/groceries need already go through the
          service client (pantry-chef) or a services-layer projection
          (lib/services/meals/index.ts:656), so nothing else breaks.
Status:   VERIFIED (proven on the live replay)
```

```
[CLAUDE-3][MEDIUM][RLS/SAFETY] A teen driver can rewrite their own driving score — the sibling table in the same feature got the rule this one is missing
Path:     policies `driving_trips_{select,insert,update,delete}` — all `is_family_member(family_id)`
          components/family/driving-safety-view.tsx:29-40, 115
Problem:  `driver_licenses` and `driving_trips` are the two tables of the driving
          feature. `driver_licenses` carries the right rule on all four commands:
          `is_family_member(family_id) and (can_manage_family(family_id) or
          is_self_member(member_id))`. `driving_trips` — hard brakes, max speed,
          phone-use seconds, the score a parent looks at — is plain membership.
          The driver grades their own driving.
Evidence: live, as a real child session (scratchpad/probe1.sql), on a trip the
          parent recorded (score 41, 78 mph, 5 hard brakes, 240s phone use):
            NOTICE: E child rewrites their OWN driving score: 1 row(s)
            NOTICE: E driving score is now 100
            NOTICE: E child DELETES their own trip: 1 row(s)
          Side-by-side catalogue of the two tables' policies is in the session
          log; `driver_licenses` has the self/manager clause on all four,
          `driving_trips` on none.
          Ruled out a guard elsewhere: `components/family/driving-safety-view.tsx`
          is a client component writing through `createClient()` (anon key) at
          :40 and :115 — no server action, no route, so RLS is the whole boundary.
          `pg_trigger` on driving_trips is `set_driving_trips_updated` only.
Impact:   The safe-driving report a parent uses to decide about car keys or an
          insurance discount is editable by the teenager it is about, and a bad
          trip can simply be deleted.
Fix:      Copy `driver_licenses`' clause onto `driving_trips`' UPDATE and DELETE:
            using ( is_family_member(family_id) and can_manage_family(family_id) )
          — or, if a driver should be able to label their own trip,
            `can_manage_family(family_id) or is_self_member(member_id)` on UPDATE
          with the telemetry columns held by a trigger. INSERT can stay member-wide
          (the phone posts the trip); it is the after-the-fact edit that matters.
Status:   VERIFIED (proven on the live replay)
```

```
[CLAUDE-3][MEDIUM][API/ERROR-LEAK] `describeDbError` falls through to the raw Postgres message, and 311 server call sites use it where `describeActionError` is the documented boundary
Path:     lib/supabase/errors.ts:28-80 (describeDbError), :83-89 (describeActionError)
          311 call sites in 56 files under app/ and lib/ (server), e.g.
          lib/ai/planner/index.ts:253,446,519,582,595 · lib/ai/tools/*.ts ·
          app/(app)/dashboard/{kitchen,trip-intel}/actions.ts
          plus 14 sites returning `err.message` with no wrapper at all:
          app/(app)/dashboard/locator/actions.ts:64 ·
          app/(app)/dashboard/recipes/vote/actions.ts:40,123 ·
          lib/planning/prep-server.ts:28,46,49,62 · lib/twin/project-server.ts:177,192,223,252 ·
          lib/network/aggregate-server.ts:145,215,218
Problem:  `describeDbError`'s last line is `return raw.trim() || fallback` — an
          unclassified error is returned verbatim. The repo already knows this:
          `describeActionError` exists two functions below with the docstring
          "Describe an error for a server-action/API response WITHOUT exposing
          unclassified database or provider details to the browser or model", and
          its whole body is the guard `raw && described === raw ? fallback : described`.
          Only a minority of server paths use it. The `raw.trim()` branch is not
          hypothetical: the classifier matches ten specific shapes, and anything
          else — an enum coercion, a numeric overflow, a function-not-found, a
          provider error re-thrown as an Error — goes through untouched.
Evidence: classification gap demonstrated on the live database:
            insert … status='bogus'  → ERROR: invalid input value for enum redemption_status: "bogus"
          No branch of describeDbError matches that string (no 42501/23505/23503/
          23502/23514 code, and none of the ten substrings), so it is returned to
          the browser verbatim, disclosing the enum type name and value grammar.
          By contrast `symptom_logs_severity_check` IS caught ("violates check").
          Counts: `grep -rn "describeDbError(" app lib | grep -v errors.ts` → 311
          call sites across 56 files; the raw-`.message` grep → 14.
          Ruled out a guard elsewhere: there is no response middleware that
          rewrites action results — `lib/supabase/errors.ts` is the only
          normaliser in the repo, and the AI tool paths
          (lib/ai/tools/*.ts, lib/ai/planner/index.ts) put the string into
          `fail(...)`, which reaches both the browser AND the model context.
Impact:   Schema disclosure (type names, column names, constraint names, function
          signatures) to any authenticated user, and into AI prompt context on the
          planner/tool paths. Not exploitable on its own; it is reconnaissance,
          and it contradicts a boundary the codebase has already written down.
Fix:      Two lines of policy, mechanically applied:
          1. Make `describeDbError`'s fallback non-leaking by default — change the
             last line to `return fallback` and add
             `describeDbErrorVerbose` for the client components that genuinely
             want the raw string for their own query.
             (Safer variant if that is too wide: leave describeDbError alone and
             switch the 311 server call sites to `describeActionError`, which
             already composes over it.)
          2. Replace the 14 bare `err.message` returns with `describeActionError(err)`.
          Either way, add a lint/test ratchet: no file under `app/api/**`,
          `app/**/actions.ts` or `lib/**-server.ts` may return `.message`
          directly — the same shape as the existing context-policy static ratchet.
Status:   OPEN (classification gap proven live; the leak is a source-level property)
```

```
[CLAUDE-3][LOW][RLS] `marketplace_orders` UPDATE has a WITH CHECK weaker than its USING
Path:     policy `marketplace_orders_update`
            using      ( is_family_member(family_id) and (buyer_member = marketplace_member_id(family_id)
                                                          or seller_member = marketplace_member_id(family_id)) )
            with check ( is_family_member(family_id) )
Problem:  The USING clause is careful — only the buyer or the seller may touch
          the row. The WITH CHECK drops the condition entirely, so the row they
          are allowed to touch can be rewritten into a row they would not have
          been allowed to touch: reassign `buyer_member`/`seller_member` to
          another member, change `amount_cents`, or flip `status`. This is the
          same asymmetry 0297 fixed on `invites_update`.
Evidence: read from `pg_policies` on the live replay (qual and with_check quoted
          above verbatim). Not escalated to a behavioural probe because the
          impact is bounded: `marketplace_orders.family_id` is NOT NULL and the
          WITH CHECK still pins it, so the row cannot leave the family, and the
          module is an intra-family lending/selling ledger with no wallet or
          Stripe path behind it (`grep -rn "marketplace_orders" app lib` returns
          only the two cron reminder routes, the orders page, and
          app/(app)/marketplace/actions.ts:147, which sets `status` alone).
Impact:   A family member can reassign or re-price an order they are party to —
          a bookkeeping integrity issue inside one household, not a tenant break.
Fix:      Make the WITH CHECK the same expression as the USING, exactly as 0297
          did for invites.
Status:   OPEN (policy read; impact deliberately bounded rather than probed)
```

## Verified healthy this session (each was attacked, and held)

- **Secrets in the client bundle — SOUND, by whole-graph trace, not by grep.**
  Built the real import graph from all **452 `'use client'` entry files**,
  following value imports only (type-only `import type`/`export type` edges
  excluded) and **stopping at every `'use server'` file**, because Next replaces
  a server action with an RPC stub rather than bundling it. 868 modules are
  reachable. **Zero** of them read a non-`NEXT_PUBLIC_` environment variable.
  The first two runs of this trace reported 16 "leaks"; every one was an
  artefact of not modelling those two boundaries — worth recording, because that
  is exactly the false positive a grep-based check ships.
  (`scratchpad/trace2.js`.)
- **Storage object policies — SOUND.** All 22 `storage.objects` policies scope on
  `is_family_member((storage.foldername(name))[1]::uuid)` or
  `auth.uid()::text = (storage.foldername(name))[1]`. Path traversal is not
  reachable: a key whose first segment is not a UUID makes the cast raise, which
  denies rather than admits. The `documents` bucket additionally re-checks
  `is_sensitive_document(d.is_secure, d.category)` against the `documents` row on
  SELECT/UPDATE/DELETE — the storage layer and the table layer agree. (The two
  public buckets are already filed above from an earlier session.)
- **Child sign-in — SOUND.** `app/(auth)/actions.ts:76-147`. IP rate limit, then
  a durable per-username throttle read BEFORE the password is derived (and read
  for unknown usernames too, so it is not a lookup oracle), `eq` not `ilike` on
  both the throttle key and the lookup, vague failure text, throttle cleared on
  success. The 4-digit PIN never becomes the password — `deriveChildPassword`
  mixes it with `CHILD_LOGIN_SECRET`, so the Supabase password endpoint cannot be
  brute-forced directly either.
- **Active-family selection — SOUND.** `user_preferences` is self-writable
  (`prefs_all`), so `active_family_id` is attacker-controlled. All four resolvers
  intersect it with real memberships before use:
  lib/supabase/auth.ts:175, lib/supabase/bearer.ts:83,
  lib/server/entitlement.ts:78, lib/services/paperwork/link-access.ts:73.
  Setting it to a stranger's family selects nothing.
- **Role changes mid-session — SOUND.** `is_family_member` / `can_manage_family` /
  `is_family_admin` / `is_self_member` are all STABLE SECURITY DEFINER over
  `family_members` with `SET search_path = public`, so a demotion or an
  `is_active=false` takes effect on the next statement; no role is cached in the
  JWT. `family_members` itself is manager-gated on all of insert/update/delete
  (`fm_*`), so a child cannot promote themselves.
- **RLS coverage — SOUND.** `select relname from pg_class where relnamespace='public'
  and relkind='r' and not relrowsecurity` → **0 rows**. Every one of the 491
  public tables has RLS on. The 30 policies whose `roles` is `{public}` rather
  than `{authenticated}` are not a hole: their expressions all reduce to
  `is_family_member`/`can_manage_family`, which are false when `auth.uid()` is
  null, so `anon` gets nothing (and `run-probes.sh`'s rls-isolation-check asserts
  this behaviourally).
- **Admin surface — SOUND.** `admin_integrations`, `admin_notifications`,
  `super_admins` have RLS on and **no policy at all** → deny-all for `anon` and
  `authenticated`; only the service role (which bypasses RLS) reaches them.
  `admin_users` carries one `service_role`-only policy. `feature_flags` is
  authenticated-readable by design.
- **Referral crediting — SOUND.** `lib/referrals/server.ts`. `applyReferralCode`
  is guarded by a unique index on `referred_family_id` and handles the 23505 race
  explicitly; `markReferralConverted` only acts on a still-`signed_up` row;
  reward fulfilment is keyed by `rewardIdempotencyKey` and flips to `rewarded`
  only once Stripe confirms both sides, so webhook redelivery re-credits nobody.
  `referral_codes` has no client write policy and is written service-side.
- **`family_id` from the request — SOUND.** Across all 141 `app/api/**/route.ts`,
  only three handlers take a family id from the caller, and all three reject a
  mismatch against the session or a provider signature:
  moving/recalculate:132, vacations/confirmation-import:74-76, and
  contact-center/voice/transcription:26 (whose `?familyId=` is inside the URL the
  Twilio signature covers).
- **Mass assignment — SOUND.** `grep` for a request body spread into a write
  (`{...body}` / `{...payload}` / `{...input}` into insert/update/upsert) returns
  two sites, both in `app/(app)/admin/marketing/**`, both behind the super-admin
  gate and both over a Zod-parsed `payload` rather than the raw body.
- **`reward_redemptions` — SOUND, and the contrast that found the economy bug.**
  It carries `trg_reward_redemption_decision_guard`, which is why
  `run-probes.sh`'s reward-redemption-decision-check passes. `economy_redemptions`
  is the same shape with no such trigger; noticing the asymmetry is what produced
  the CRITICAL above.
```

<!-- end of Claude-3 session 3 block -->
```
