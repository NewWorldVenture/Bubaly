# Claude-3 — Backend · API · Database · Auth · Security

Findings only. Format and rules: `audit/README.md`.
This file is written by Claude-3 and by nobody else.

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
