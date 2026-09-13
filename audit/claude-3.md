# Claude-3 — Backend · API · Database · Auth · Security

Findings only. Format and rules: `audit/README.md`.
This file is written by Claude-3 and by nobody else.

---

### [CLAUDE-3][CRITICAL][AUTH/RLS] `invites_update` has no `WITH CHECK`, so an invitee rewrites their own invite and becomes `parent` of any family
- **File:** `supabase/migrations/` → policy `invites_update` on `public.invites` (see `grep -rn "invites_update" supabase/migrations/`); consumed by `public.accept_invite(text)`
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
- **File:** policy `Managers manage child_logins` on `public.child_logins`;
  consumers `app/(app)/family/child-login-actions.ts:104` (`resetChildPinAction`)
  and `app/(auth)/actions.ts:116`
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
- **File:** schema-wide. 36 of them point at `public.families` (list below), 41 at `family_members`, 21 at `vacations`, 11 at `child_wallets`.
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
