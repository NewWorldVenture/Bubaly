-- ── 0300: the paywall is not a column the customer can write ────────────────
--
-- lib/server/entitlement.ts decides what a family may use from three facts:
-- the max plan across active/trialing `subscriptions` rows, and
-- `families.trial_ends_at` / `families.closed_at`. Before 0300 a signed-in
-- parent could write all of them from the browser with the public anon key, so
-- Family+ cost one PATCH and no Stripe call.
--
-- This probe re-measures that against the FULLY REPLAYED schema, which is the
-- only state a database actually runs in — 0253 verified its own lockdown at
-- its own moment in the chain and a later migration handed the grant back.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/entitlement-write-boundary-check.sql
--
-- Each attempt is judged on BOTH outcomes an attack can have: the refusal
-- (42501) and the row count. An UPDATE that RLS filters to no visible row
-- changes nothing and raises nothing, so an exception handler alone reads that
-- silent block as a breach — assertion 7 did exactly that in a first draft and
-- accused the child of a write RLS had already stopped.
--
-- And every attempt is given a NEGATIVE CONTROL that runs FIRST: the same
-- actor, the same statement, the same row, with the one thing the mechanism
-- keys on — the column name, or the privilege — changed so the answer comes out
-- the other way, which MUST land. What refuses these writes is a GRANT, not a
-- policy, so that is the axis the controls turn; the full argument, including
-- the one attribution no control here can supply and what carries it instead,
-- is written at the controls themselves.
-- Re-runnable: the fixture family's rows are cleared before each run.
do $$
declare
  fam   uuid := 'e0300000-0000-4000-8000-00000000fa01';
  other uuid := 'e0300000-0000-4000-8000-00000000fa02';
  par   uuid := 'e0300000-0000-4000-8000-00000000c001';
  kid   uuid := 'e0300000-0000-4000-8000-00000000c002';
  -- The negative control's own household: born inside the control and dead
  -- inside it. Same anchor style as the four above, and the literal appears
  -- NOWHERE else in docs/audit or supabase/migrations (grepped before it was
  -- chosen). That matters because run-probes.sh runs every docs/audit/*-check.sql
  -- in sequence against ONE database, and what a probe COMMITS is what the next
  -- probe finds. This `do` block is a single implicit transaction under psql's
  -- autocommit, so a raise anywhere in it rolls back everything the block wrote;
  -- on the SUCCESS path, though, the block commits, and a fixture row left
  -- behind there — or a UUID shared with some other probe's fixture — would
  -- quietly change what a later probe asserts.
  ctl   uuid := 'e0300000-0000-4000-8000-00000000fa03';
  -- The login role, so the control can hop back to clear its own household
  -- away without hard-coding 'postgres'. session_user is NOT changed by SET
  -- ROLE (only current_user is), so this could be read after the role switch
  -- just as well; it is a variable only so the hop-back names one value.
  owner text := cast(session_user as text);
  ctl_trial timestamptz;
  ctl_fail  text[] := '{}';
  n int; blocked boolean;
begin
  -- The fixture is the owner's work, and it is wrapped for the same reason the
  -- controls are: if a families write is refused HERE — a trigger that now
  -- refuses even the owner, a renamed column, a new NOT NULL — nothing below
  -- ran, and that must be said as such rather than as a bare SQLSTATE that
  -- looks like one of the seven attempts speaking.
  begin
    insert into public.families (id, name) values (fam,'0300 entitlement'), (other,'0300 other')
      on conflict (id) do nothing;
    insert into auth.users (id, email) values (par,'p0300@example.test'), (kid,'k0300@example.test')
      on conflict (id) do nothing;

    -- The control's household must not survive a previous run either. One
    -- delete is enough: the cascade takes the subscription, the member row and
    -- the ai settings that on_family_created seeds alongside it.
    delete from public.families where id = ctl;
    delete from public.billing_customers where family_id in (fam, other);
    delete from public.family_members    where family_id in (fam, other);
    insert into public.family_members (family_id,user_id,display_name,role,is_active) values
      (fam,par,'Parent','parent',true), (fam,kid,'Kid','child',true);

    -- The family is FREE with an expired trial: locked, per entitlement.ts.
    -- Every assertion below is about escaping that state, so it has to be the
    -- state.
    update public.families set trial_ends_at = now() - interval '30 days', closed_at = null where id = fam;
    delete from public.subscriptions where family_id = fam;
    insert into public.subscriptions (family_id, plan, status) values (fam, 'free', 'trialing');
    insert into public.billing_customers (family_id, provider, customer_ref) values (fam, 'stripe', 'cus_fixture');
  exception when others then
    raise exception '0300 entitlement write boundary UNPROVEN (the FIXTURE could not be built as %: %: %) — no control ran and none of the seven attempts was measured', session_user, sqlstate, sqlerrm;
  end;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', par::text, true);

  -- A probe that cannot tell "refused because the boundary holds" from
  -- "refused because nobody is signed in" passes against a broken schema too.
  if auth.uid() is distinct from par then
    raise exception '0300: impersonation failed — auth.uid() is %, expected the parent', auth.uid();
  end if;
  if not public.is_family_admin(fam) then
    raise exception '0300: fixture wrong — the parent is not a family admin, so nothing below is tested';
  end if;
  -- ...and a READ the parent is still allowed, so a lockdown that blanked the
  -- billing page would not read as a pass. (The matching WRITE the parent is
  -- still allowed — the family profile — is CONTROL 1 below, which is where a
  -- blanket revoke on families is caught and named.)
  select count(*) into n from public.subscriptions where family_id = fam;
  if n <> 1 then
    raise exception '0300: a parent can no longer read their own plan (% rows) — the billing page is blank', n;
  end if;

  -- ── NEGATIVE CONTROL, and it runs FIRST, before all seven attempts ────────
  --
  -- WHICH MECHANISM, AND HOW I KNOW. Nothing below is refused by an RLS
  -- predicate. It is refused by a GRANT, and the last migration in the whole
  -- chain to touch a grant or a write policy on these three tables is 0300:
  -- `grep -rniE '^ *(grant|revoke).*(families|subscriptions|billing_customers)'
  -- supabase/migrations` returns four lines — 0300:70, 74, 79, 83 — and nothing
  -- else, and `grep -rlwE 'subs_manage|billing_manage' supabase/migrations`
  -- (-w, because 00101 names an admin role called billing_manageR) returns
  -- 0004, 0118 and 0300 — where 0300 drops them. Concretely:
  --
  --   * subscriptions and billing_customers: `revoke insert, update, delete …
  --     from anon, authenticated` (0300:70,74) with the FOR ALL policies gone.
  --     The client holds NO write privilege on either table, for anybody.
  --   * families UPDATE: the table grant was dropped and re-issued over
  --     (name, address, timezone, cover_url, avatar_url) only (0300:79-81), so
  --     trial_ends_at and closed_at are denied BY COLUMN NAME.
  --   * families INSERT: same shape, re-issued over (id, name, address,
  --     timezone, cover_url, avatar_url, family_code, created_by) (0300:83-85),
  --     so naming trial_ends_at in the column list is the whole of 4's refusal.
  --   * The RLS gate that still stands over the families UPDATE is 0118's
  --     `families_update … using public.can_manage_family(id)`. 0118 is the LAST
  --     definition, not 0004's and not 01100's — `01100_family_profile` sorts
  --     BEFORE `0118` (compare the fourth character), which is the kind of
  --     replay-order detail that once let this audit credit a guard a later
  --     migration had replaced. It carries no WITH CHECK, so USING is reused as
  --     the write check.
  --   * Triggers, since a dynamic-SQL loop can attach one without ever writing
  --     the table's name: `select tgname, pg_get_triggerdef(oid) from pg_trigger
  --     where tgrelid = 'public.families'::regclass and not tgisinternal`
  --     returns two — on_family_created (AFTER INSERT, 0003, redefined 0257) and
  --     trg_set_updated_at (BEFORE UPDATE, attached by 0034:696-702's loop over
  --     every public table with an updated_at column). Neither raises. More to
  --     the point, NO trigger can be what refuses 3, 4 or 5 while the grant is
  --     absent: the engine checks table and column privileges at executor
  --     start, before a row is touched and before any trigger — statement- or
  --     row-level — fires, which is why every refusal below arrives as the
  --     engine's own "permission denied for table families" and not as a
  --     trigger's sentence. A trigger only gets to speak once a grant is back,
  --     and a grant being back is what the foot of this file asks the engine
  --     about directly.
  --
  -- WHAT THE CONTROL IS. A column-level grant keys on the COLUMN NAME, so "the
  -- same actor, the same predicate, the answer the other way" is the same
  -- parent, running the same statement against the same row, with the SET or
  -- INSERT list — the one thing the mechanism reads — swapped for the columns
  -- that ARE granted. That is also the only sense in which this control can
  -- "name the same columns as the write under test": naming trial_ends_at IS
  -- the write under test.
  --
  -- WHAT IT WOULD CATCH, and — said plainly — what it would not. Without it,
  -- 3, 4 and 5 are refusals with no attribution: a parent's INSERT or UPDATE of
  -- families raises 42501 for a missing table grant, for a column denial and
  -- for a dead auth.uid() alike. Revoke UPDATE on families outright because the
  -- profile form moved to a server action, and 3 and 5 keep printing green
  -- while the sentence this probe prints about them — "denied BY COLUMN NAME" —
  -- has stopped being true. Control 1 turns that: the same statement over the
  -- granted columns lands, so what stops trial_ends_at and closed_at is the
  -- column list and nothing wider. What a column swap CANNOT turn is a guard
  -- trigger keyed on the very column — the house style of 0223, 0305, 0326 and
  -- 0331, each of which raises 42501 only when the column it polices changes.
  -- A families trigger written that way would refuse 3 and 5 and wave control
  -- 1 through, and no control here claims otherwise. That axis is closed by
  -- the ordering above (a trigger cannot be the refusal while the grant is
  -- absent) together with the foot of this file, which asks the engine whether
  -- a grant is back by ANY route — so the trigger scenario cannot print green;
  -- at most it is a second refusal underneath a build that is already red.
  --
  -- ZERO ROWS. 3 and 5 also accept n = 0, and once a grant is back a row this
  -- session cannot SEE reports zero just as readily as a USING clause does.
  -- Control 1 changing exactly one row is what makes that zero mean something.
  --
  -- WHAT A CONTROL MAY REQUIRE. A control's truth-condition has to be a premise
  -- of a sentence this probe prints, never a wish of its own. Control 1 names
  -- the four columns the grant assertion at the FOOT of this file already
  -- requires, and deliberately not avatar_url, so it cannot be stricter than
  -- the probe. Control 2's premise is 0300:84-85's re-issued INSERT grant, on
  -- which the sentence about 4 above — "naming trial_ends_at in the column list
  -- is the whole of 4's refusal" — rests. Nothing in the app leans on that
  -- grant (the one families INSERT in the codebase, app/(app)/admin/actions.ts,
  -- uses the service client, and onboarding creates families through the
  -- SECURITY DEFINER RPCs of 0210 and 0212), so a later migration may well
  -- revoke it. When that happens 4 is refused for a wider reason than it
  -- claims, the sentence is false, and control 2 says UNPROVEN so the sentence
  -- gets rewritten instead of printed. That is a red on a TIGHTER database, and
  -- it is the right one: this file is a claim about WHY, not only WHETHER, and
  -- it is the same verdict control 1 hands a wholesale UPDATE revoke.
  --
  -- WHAT NO CONTROL CAN DO HERE, said out loud rather than faked: 1, 2, 6 and 7
  -- are refused because `authenticated` holds no write privilege on
  -- subscriptions or billing_customers AT ALL. The absence IS the boundary, so
  -- for those tables there is no other answer to get, and any "control" that
  -- wrote one of them would be asserting something untrue of this schema. The
  -- mirror that does exist is the privilege axis: the same actor, the same
  -- table, the same row, the same WHERE clause, READ instead of written, which
  -- must return exactly one row (control 3, and control 4 for the child). That
  -- proves the session reaches the row the write aims at and that subs_select /
  -- billing_select answer yes for it; it cannot prove a write privilege existed
  -- to be measured. The half it cannot carry is carried by two things that do:
  -- the catalog read at the foot of this file, which asks the engine whether a
  -- client write privilege is back instead of inferring it from a refusal, and
  -- control 1, which shows this very session DOES complete an UPDATE where a
  -- grant exists.
  --
  -- CONTROL 1 — the same parent, the same UPDATE, the same row, the SET list
  -- swapped for the columns the grant DOES cover. Must change exactly one row.
  -- These are also the only families columns the browser still writes
  -- (settings-module / family-module: name, address, timezone, cover_url), so
  -- a lockdown that went too far is named here, not met later as a bare 42501.
  begin
    update public.families
       set name     = '0300 entitlement',
           address  = '0300 control address',
           timezone = 'UTC',
           cover_url = 'https://example.test/0300-control.png'
     where id = fam;
    get diagnostics n = row_count;
    if n <> 1 then
      ctl_fail := array_append(ctl_fail, format('CONTROL 1 FAILED: this parent''s UPDATE of families over the GRANTED columns (name, address, timezone, cover_url) on their own family changed %s row(s), not 1 — so the refusals of trial_ends_at and closed_at below prove nothing about the column grant: a row this session cannot update reports zero either way', n));
    end if;
  exception when others then
    ctl_fail := array_append(ctl_fail, format('CONTROL 1 FAILED: this parent''s UPDATE of families over the GRANTED columns (name, address, timezone, cover_url) raised %s: %s — either the lockdown went too far and a parent can no longer edit their own family profile, or whatever refuses trial_ends_at and closed_at below is not the column grant this probe credits; either way 3 and 5 are unreadable', sqlstate, sqlerrm));
  end;

  -- CONTROL 2 — the same parent, the same statement shape as attempt 4 (INSERT
  -- into families with created_by = this parent), with `trial_ends_at` dropped
  -- from the COLUMN LIST. Two things differ from 4, both in the safe direction:
  -- `id` is named, so the control can find and remove its own row, and the
  -- name value is the control's own. id is inside 0300:84's INSERT grant, so
  -- naming it can only add a way for this statement to be refused, never take
  -- one away. Must store one row, and that row must come out WITH a trial
  -- clock: the foot of this file asserts that 0164:23's default is DECLARED;
  -- this shows it APPLIES to a row born the way 4 tries to be born. The trigger
  -- on_family_created is SECURITY DEFINER (0257), so the subscriptions row it
  -- seeds is not this session's write and needs no grant this session lacks.
  begin
    insert into public.families (id, name, created_by)
      values (ctl, '0300 control family', par);
    get diagnostics n = row_count;
    if n <> 1 then
      ctl_fail := array_append(ctl_fail, format('CONTROL 2 FAILED: this parent''s INSERT into families WITHOUT trial_ends_at stored %s row(s), not 1 — so 4''s refusal is not attributable to the column grant', n));
    else
      -- count and value together, deliberately: a bare `select … into` does NOT
      -- raise on zero rows in plpgsql, it just leaves the variable NULL, so
      -- "invisible row" and "NULL trial clock" would print the same accusation.
      select count(*), min(trial_ends_at) into n, ctl_trial
        from public.families where id = ctl;
      if n <> 1 then
        ctl_fail := array_append(ctl_fail, format('CONTROL 2 FAILED: the family this parent just created is not visible to the session that created it (%s row(s)) — families_select is not answering yes for its own creator, and 4''s column-list refusal cannot be read against that', n));
      elsif ctl_trial is null then
        ctl_fail := array_append(ctl_fail, 'CONTROL 2 FAILED: a family created WITHOUT naming trial_ends_at came out with a NULL trial clock — it is born grandfathered already, which is the state 4 exists to prevent, and 4 would never see it because 4 only ever watches the column list');
      end if;
    end if;
  exception when others then
    ctl_fail := array_append(ctl_fail, format('CONTROL 2 FAILED: this parent could not create a family at all (%s: %s) — then 4''s refusal below says nothing about trial_ends_at; it says the client cannot INSERT families, which is a different sentence', sqlstate, sqlerrm));
  end;

  -- The control's household does not outlive the control. This whole block is
  -- one transaction, so on any raise the household vanishes with everything
  -- else the block wrote; the path that needs this delete is the SUCCESS path,
  -- where the block commits and a stray family carrying a seeded subscription
  -- would be exactly the quiet contamination that turns one unattributed check
  -- here into some later probe's false failure. Unconditional: where the INSERT
  -- was refused there is nothing to remove. trg_family_keeps_a_manager is
  -- deferred and returns null once the family is gone (0299), so the cascade
  -- through family_members is safe. Wrapped, so a cleanup that cannot run is
  -- reported as the control's failure and not as a raw SQLSTATE with the
  -- diagnosis thrown away; an aborted sub-block rolls its own SET back, so the
  -- role is authenticated again on both paths.
  begin
    perform set_config('role', owner, true);
    delete from public.families where id = ctl;
    perform set_config('role', 'authenticated', true);
  exception when others then
    perform set_config('role', 'authenticated', true);
    ctl_fail := array_append(ctl_fail, format('CONTROL 2 FAILED: could not remove the control''s own family afterwards (%s: %s) — the fixture can no longer be trusted to be what the attempts below assume', sqlstate, sqlerrm));
  end;

  -- CONTROL 3 — the privilege-axis mirror for 6. Today 6 is refused at the
  -- engine's privilege check, which runs BEFORE RLS is consulted, so row
  -- visibility contributes nothing to 6's verdict as things stand. This control
  -- is for the state 0253 taught this audit to expect: a later migration hands
  -- the UPDATE grant back, and 6's verdict then rests on `n > 0` alone, where a
  -- row the parent cannot see prints zero and reads as "nothing was rewritten".
  -- One visible row now is what makes that zero mean what 6 says it means. (The
  -- same mirror for 1 and 2 is the `count(*) … from public.subscriptions` read
  -- above, which already raises on its own; billing_customers had no such proof
  -- at all.)
  begin
    select count(*) into n from public.billing_customers where family_id = fam;
    if n <> 1 then
      ctl_fail := array_append(ctl_fail, format('CONTROL 3 FAILED: the parent sees %s billing_customers row(s) for their own family, not 1 — 6 is aimed at a row this session cannot see, and "nothing was rewritten" would follow from that alone', n));
    end if;
  exception when others then
    ctl_fail := array_append(ctl_fail, format('CONTROL 3 FAILED: the parent cannot even READ their own billing_customers row (%s: %s), so 6 measures nothing', sqlstate, sqlerrm));
  end;

  -- CONTROL 4 — 7 re-measures the same refusal from a SECOND actor, and every
  -- control above is the PARENT's: it proves the guard lets somebody through,
  -- not that the CHILD's session could have written anything at all. That is
  -- the mistake the document-vault probe made for a whole release, passing
  -- while the teen could not INSERT a document in the first place. So the child
  -- gets their own mirror, on the same privilege axis, and before 7 runs.
  perform set_config('request.jwt.claim.sub', kid::text, true);
  if auth.uid() is distinct from kid then
    ctl_fail := array_append(ctl_fail, format('CONTROL 4 FAILED: impersonating the child did not take — auth.uid() is %s, expected the child', auth.uid()));
  end if;
  -- Wrapped like every other control: a renamed helper or a revoked EXECUTE
  -- must arrive as UNPROVEN with its reason, not as a raw SQLSTATE.
  begin
    if not public.is_family_member(fam) then
      ctl_fail := array_append(ctl_fail, 'CONTROL 4 FAILED: the fixture child is not an active member of the fixture family, so 7 is not a child of the household being refused — it is an outsider, which is a weaker claim than the one 7 prints');
    end if;
    if public.can_manage_family(fam) then
      ctl_fail := array_append(ctl_fail, 'CONTROL 4 FAILED: the fixture child counts as a MANAGER of the family, so 7 tests nothing about a child');
    end if;
  exception when others then
    ctl_fail := array_append(ctl_fail, format('CONTROL 4 FAILED: the membership helpers the fixture is checked with could not be called (%s: %s) — is_family_member / can_manage_family are what the RLS on these tables runs on, so 7 cannot be read', sqlstate, sqlerrm));
  end;
  begin
    select count(*) into n from public.subscriptions where family_id = fam;
    if n <> 1 then
      ctl_fail := array_append(ctl_fail, format('CONTROL 4 FAILED: the child sees %s subscriptions row(s) for their own family, not 1 — 7 is aimed at a row the child''s session cannot see, and "no row changed" follows from that alone', n));
    end if;
  exception when others then
    ctl_fail := array_append(ctl_fail, format('CONTROL 4 FAILED: the child cannot read the family plan (%s: %s), so 7 measures nothing', sqlstate, sqlerrm));
  end;
  -- Back to the parent: 1 through 6 are the parent's attempts.
  perform set_config('request.jwt.claim.sub', par::text, true);

  -- A failed control makes every refusal below unreadable, so say WHY the probe
  -- cannot speak here, while the reason is still in hand. The boundary is not
  -- reported as holding and it is not reported as broken: it is reported as
  -- UNPROVEN, and the build is red either way.
  if array_length(ctl_fail, 1) is not null then
    raise exception '0300 entitlement write boundary UNPROVEN (the controls the seven attempts below rest on did not hold): %', array_to_string(ctl_fail, ' | ');
  end if;

  -- 1. Self-upgrade to the top tier. planLevel('plus_annual') = 2.
  blocked := false; n := 0;
  begin
    update public.subscriptions set plan = 'plus_annual', status = 'active' where family_id = fam;
    get diagnostics n = row_count;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked and n > 0 then
    raise exception '0300: a parent granted themselves Family+ by writing subscriptions (% row(s)) — the paywall is client-side', n;
  end if;

  -- 2. Minting a second paid row rather than editing the seeded one.
  blocked := false;
  begin
    insert into public.subscriptions (family_id, plan, status) values (fam, 'plus', 'active');
  exception when insufficient_privilege then blocked := true;
       when unique_violation then blocked := true;  -- uq_subscriptions_family got there first
  end;
  if not blocked then
    raise exception '0300: a parent inserted their own paid subscription row';
  end if;

  -- 3. Clearing the trial clock. NULL is the GRANDFATHERED case: never locked.
  blocked := false; n := 0;
  begin
    update public.families set trial_ends_at = null where id = fam;
    get diagnostics n = row_count;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked and n > 0 then
    raise exception '0300: a parent cleared families.trial_ends_at (% row(s)) — the trial never ends', n;
  end if;

  -- 4. Being born grandfathered: the column has a 5-day default, not a refusal.
  blocked := false;
  begin
    insert into public.families (name, created_by, trial_ends_at) values ('born free', par, null);
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception '0300: a new family was created with trial_ends_at NULL — grandfathered on arrival';
  end if;

  -- 5. closed_at. Closing and reopening stay a parent's decision through
  --    app/(app)/account/actions.ts, which uses the service client; the column
  --    itself is not the browser's to set.
  blocked := false; n := 0;
  begin
    update public.families set closed_at = null where id = fam;
    get diagnostics n = row_count;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked and n > 0 then
    raise exception '0300: families.closed_at is writable from the browser';
  end if;

  -- 6. billing_customers.customer_ref decides whose Stripe portal opens in
  --    app/api/billing/portal — it is a server-trusted identifier.
  blocked := false; n := 0;
  begin
    update public.billing_customers set customer_ref = 'cus_someone_else' where family_id = fam;
    get diagnostics n = row_count;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked and n > 0 then
    raise exception '0300: a parent rewrote their billing customer reference';
  end if;

  -- 7. The child must not have gained anything either.
  perform set_config('request.jwt.claim.sub', kid::text, true);
  blocked := false; n := 0;
  begin
    update public.subscriptions set plan = 'plus', status = 'active' where family_id = fam;
    get diagnostics n = row_count;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked and n > 0 then
    raise exception '0300: a child wrote the family subscription';
  end if;

  reset role;
  raise notice '0300 entitlement write boundary OK';
end $$;

-- The grants themselves, read from the catalog rather than inferred from the
-- statements above: a policy can be re-created by a later migration, and a
-- table-level grant cannot be narrowed by revoking one column.
do $$
declare n int; d text; begin
  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public' and table_name in ('subscriptions','billing_customers')
     and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE');
  if n <> 0 then
    raise exception '0300: % client write grant(s) are back on the entitlement tables', n;
  end if;

  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'families'
     and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE')
     and column_name in ('trial_ends_at','closed_at');
  if n <> 0 then
    raise exception '0300: the paywall columns are client-writable again (% grant(s))', n;
  end if;

  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'families'
     and grantee = 'authenticated' and privilege_type = 'UPDATE'
     and column_name in ('name','address','timezone','cover_url');
  if n <> 4 then
    raise exception '0300: the family profile lost its write grant (% of 4 columns)', n;
  end if;

  -- information_schema lists a grant under the grantee it was made TO. A grant
  -- to PUBLIC, or to a role that anon/authenticated are members of, is listed
  -- under that name and walks past the three counts above — measured: after
  -- `grant update (trial_ends_at) on public.families to public` they still read
  -- zero. So ask the engine the question it asks at execution time, with PUBLIC
  -- and membership resolved. This is also what closes the trigger axis argued
  -- at the controls: a trigger can only become the refusal once a client write
  -- privilege is back by SOME route, and every route ends here.
  select count(*) into n
    from unnest(array['anon','authenticated']) as r,
         unnest(array['trial_ends_at','closed_at']) as c,
         unnest(array['INSERT','UPDATE']) as p
   where has_column_privilege(r, 'public.families', c, p);
  if n <> 0 then
    raise exception '0300: the engine resolves % client write privilege(s) on the paywall columns that the grant table does not show — a grant to PUBLIC or through role membership', n;
  end if;
  select count(*) into n
    from unnest(array['anon','authenticated']) as r,
         unnest(array['public.subscriptions','public.billing_customers']) as t
   where has_any_column_privilege(r, t::regclass, 'INSERT')
      or has_any_column_privilege(r, t::regclass, 'UPDATE')
      or has_table_privilege(r, t::regclass, 'DELETE');
  if n <> 0 then
    raise exception '0300: the engine resolves a client write privilege on % entitlement table/role pair(s) that the grant table does not show — a grant to PUBLIC or through role membership', n;
  end if;

  -- 4's claim is that trial_ends_at carries 0164:23's 5-day default rather
  -- than a refusal. Read the default itself, with no write and no grant in the
  -- way; control 2 shows the same default APPLYING to a row.
  select column_default into d from information_schema.columns
   where table_schema = 'public' and table_name = 'families' and column_name = 'trial_ends_at';
  if d is null or d not ilike '%now()%' or d not ilike '%5 days%' then
    raise exception '0300: families.trial_ends_at default is % — 4 rests on 0164:23''s now() + 5 days, and without it a new family is grandfathered on arrival', coalesce(d, '<none>');
  end if;
  raise notice '0300 entitlement grants OK';
end $$;
