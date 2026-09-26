-- The listing state machine must decide from the row it writes to.
--
-- `marketplace_set_listing_status` read the listing with no lock and wrote with
-- no predicate, so the transition was judged against a row another transaction
-- may already have changed. When 0317 was written, twenty-two SECURITY DEFINER
-- functions in this schema read a row and then updated it, and this was the only
-- one with NEITHER mechanism — every other one took `for update`, predicated its
-- write, or both. That number is 0317's and dated to 0317: functions have been
-- added since (twenty-four match today), so step 2 below sweeps the live catalog
-- rather than trusting a count, and the closing notice prints how many it swept.
--
-- The race itself needs two sessions, so it is not reproduced here. It was
-- measured directly, buyer vs. seller, and recorded in 0317's header:
--
--   before:  seller: (no error — the forbidden transition was accepted)
--            listing=pending  claimed_by=<buyer>  confirmed_orders=1
--   after:   seller: ERROR: Cannot move listing from claimed to pending
--
-- What this probe holds is (1) that the mechanism is present in the function
-- the database actually has — read out of pg_get_functiondef, not out of a
-- file, so it cannot pass against a definition that was replaced later — and
-- (2) that the state machine still behaves, including the transitions that are
-- SUPPOSED to be legal. `claimed -> withdrawn` is one of them: a seller whose
-- buyer falls through must still be able to pull the listing, and that is not
-- the defect above.
--
-- NEGATIVE CONTROL, and it runs FIRST, before the refusal it gives meaning to
-- ---------------------------------------------------------------------------
-- The rule under test today is 0317's, and 0317 is the LAST word on it.
-- `marketplace_set_listing_status` is created in 0154 and re-created by
-- `0317_listing_status_decides_from_a_locked_row.sql`; those are the only two
-- migrations in supabase/migrations that name it at all, and nothing after 0317
-- touches marketplace_listings except 0321's index migration. So there is no
-- later definition to replay over this one — which is the mistake that once
-- credited 01051's child_logins predicate after 0297 had replaced it.
--
-- MECHANISM: not RLS, and that matters, because a control has to be aimed at the
-- thing that actually says no. The function is SECURITY DEFINER, so it runs as
-- its owner and `marketplace_listings_update` (0154) is never consulted on the
-- write it performs. Not a trigger: the only triggers on the table are
-- `set_marketplace_listings_updated` (0120's `execute format` loop — before
-- update, set_updated_at) and `trg_marketplace_log_price_change` (0191 — `after
-- update of price_cents`, and only when the price really moves; this probe never
-- moves a price); no later migration's dynamic-SQL loop names this table. Not a
-- CHECK constraint: 0120's `status in ('available','pending','claimed',
-- 'completed','withdrawn')` is still the only one on the column — 0151 replaced
-- the KIND check and 0183 added one on sale_format, neither this one — and a
-- column CHECK cannot see the status the row is coming FROM, which is the entire
-- question here. Not a unique index: the table carries five indexes — the primary
-- key on id, 0120's (family_id, status, created_at desc) and (family_id,
-- member_id), 0183's partial (sale_format, auction_ends_at) and 0321's
-- (highest_bidder_family_id) — and only the primary key is unique, on an id this
-- probe lets the database generate. Not a GRANT: EXECUTE on the function is held
-- two ways — Postgres's default EXECUTE to PUBLIC, which nothing here revokes
-- (pg-bootstrap.sh's default privileges cover TABLES only, and no migration
-- revokes on this function; the ACL reads `=X/postgres, authenticated=X/postgres`)
-- and 0154's explicit grant to authenticated. Dropping the 0154 line alone would
-- change nothing; `revoke execute … from public, authenticated` would refuse
-- EVERY call, legal or illegal, which is exactly what leg 0a below detects. The
-- table's own write grant is not in play either: a SECURITY DEFINER function
-- writes as its owner. What refuses `claimed -> pending` is ONE expression inside
-- the function — `v_ok := case … when p_status = 'pending' then v_listing.status
-- = 'available' … end` — judged against the row the `for update` read holds, with
-- `and status = v_listing.status` on the UPDATE behind it.
--
-- So the control is the same seller, through that same expression, with the one
-- thing the refused statement carries — the target status — answered the other
-- way, on the control's own listing and from the SAME `claimed` state, staged out
-- of band exactly as step 5 stages it: `claimed -> completed`, which the case
-- allows, and which MUST LAND. Its first leg is the same `pending` arm read the
-- other way (`available -> pending`, legal), so the two legs bracket the refusal
-- — the refused call lands from the status its arm allows, and a legal call lands
-- from the status the refusal is judged from.
--
-- WHAT IT ADDS, said exactly. Step 5 swallows every exception (`exception when
-- others then null`), so on its own it reads as PASS whenever that call fails
-- for any reason at all. It was never on its own: steps 3, 4 and 6 are counted
-- controls on the row under test — step 3 is `available -> pending`, leg 0a's
-- own transition, and step 6 is `claimed -> withdrawn`, a legal write of a
-- CLAIMED row by the same seller through the same function immediately after
-- step 5's refusal — so EXECUTE revoked from public and authenticated, a dead
-- auth.uid() (it is `nullif(current_setting('request.jwt.claim.sub', true),
-- '')::uuid` here, and a null one makes `marketplace_member_id` null and the
-- ownership check refuse), or a guard trigger refusing to rewrite a `claimed`
-- row (this repository refuses writes with BEFORE triggers in 0223, 0305, 0326
-- and 0331, so that is not hypothetical) each already produced CONTROL FAILED
-- lines there. This control does not replace those; it changes what a red build
-- SAYS. It runs before any row under test exists, holds the target fixed at
-- `pending` in one leg and the source fixed at `claimed` in the other, and when
-- a leg fails the probe's verdict is `0317 UNPROVEN` carrying the refusal's own
-- sqlstate and message in one line — rather than a tally of failed controls with
-- step 5 counted green among them. And if the `for update` is ever dropped back
-- out, step 1 says so from pg_get_functiondef while step 5 measures it
-- behaviourally, with the control standing behind step 5.
--
-- Because the control calls the SAME RPC as the write under test it names the
-- same columns by construction, so the column-level revoke that matters in the
-- RLS probes has nowhere to hide here.
--
-- What this control does NOT cover, said plainly rather than papered over: step
-- 7, where a session with no `request.jwt.claim.sub` is refused by the ownership
-- check. That refusal cannot be given a control of this shape — auth.uid() is
-- null for that session, so `marketplace_member_id` returns null and the function
-- refuses on `v_caller is null` whichever listing it is handed. There is no
-- listing that session owns, so for that actor there is no "the other way".
--
-- The control invents no UUID: it reuses this probe's own anchors (fam, u) and
-- its seller, and takes a database-generated id for its own listing, so it cannot
-- collide with a row any other probe seeds into the one database run-probes.sh
-- drives every probe it globs through in sequence. Its row is deleted before the
-- case under test runs. A failed leg is COUNTED, not fatal: steps 1 and 2 read
-- pg_proc and depend on neither this session nor any grant — they are the only
-- checks that see 0317's mechanism directly — so a dead session must not silence
-- them. They still run, still report, and the block then ends in `0317 UNPROVEN`
-- naming the leg's reason instead of a plain `0317 FAILED`. The probe runs in
-- autocommit, so that raise rolls back everything the block seeded.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-0000000c8a01';
  u   uuid := '00000000-0000-4000-8000-0000000c8a0a';
  seller uuid; listing uuid;
  src text;
  st text;
  failures int := 0;
  swept int := 0;   -- how many read-then-write SECURITY DEFINER functions step 2 examined
  -- The negative control's own listing. Its id is database-generated on purpose:
  -- the control introduces no UUID that could collide with another probe's rows
  -- in the shared database run-probes.sh drives every probe through.
  ctl uuid; ctl_st text;
  control_ok boolean := true;
  control_note text;
begin
  delete from public.marketplace_listings where family_id = fam;

  insert into auth.users (id, email) values (u, 'statemachine@example.com') on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'State family', u) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, u, 'Seller', 'parent', true) on conflict do nothing;
  select id into seller from public.family_members where family_id = fam and user_id = u;

  -- ══ 0. NEGATIVE CONTROL — the same seller, the same expression, the other ══
  --       answer. It runs FIRST, before the refusal it gives meaning to.
  --
  -- The boundary is one expression inside `marketplace_set_listing_status`
  -- (0317 — the last migration to create that function): the `v_ok` case, judged
  -- against the row its `for update` read holds. So this control replays step 5's
  -- call on its own listing, changing only what step 5's call carries — the
  -- target status — and it must LAND, visibly, in the row.
  --
  -- What it catches: step 5 swallows every exception, so it reads as PASS
  -- whenever that call fails for any reason at all — EXECUTE revoked from public
  -- and authenticated, a dead auth.uid(), a guard trigger on marketplace_listings
  -- of the kind 0223, 0305, 0326 and 0331 use elsewhere, a row this session
  -- cannot write. Each of those fails a leg below; steps 3, 4 and 6 would catch
  -- them too, on the row under test, and the probe then reports the boundary
  -- UNPROVEN — with the leg's sqlstate and message — instead of green. See the
  -- header for why it is this mechanism and not RLS, a trigger, a CHECK
  -- constraint, a unique index or a GRANT.
  insert into public.marketplace_listings (family_id, member_id, title, kind, price_cents, status)
    values (fam, seller, 'Control listing', 'sell', 3000, 'available') returning id into ctl;

  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;

  -- 0a. The `pending` arm, answered the other way. `available -> pending` is the
  --     transition the case ALLOWS, and it is the one 0317's race got accepted
  --     off a stale read; here the row really is `available`, so the same call
  --     step 5 makes must land. EXECUTE revoked from public and authenticated, a
  --     null auth.uid() or a listing this seller cannot write dies here, with its
  --     own sqlstate in hand, instead of being counted as step 5's boundary
  --     holding.
  begin
    perform public.marketplace_set_listing_status(ctl, 'pending');
    select status into ctl_st from public.marketplace_listings where id = ctl;
    if ctl_st is distinct from 'pending' then
      control_ok := false;
      control_note := format('the seller''s LEGAL available -> pending left the control listing at %s, so this session never had the write step 5 is supposed to be measuring', coalesce(ctl_st, '<not visible to this session>'));
    end if;
  exception when others then
    control_ok := false;
    control_note := format('the seller could not make a LEGAL transition on a listing they own (%s: %s), so step 5''s refusal would prove only that something said no', sqlstate, sqlerrm);
  end;

  -- 0b. Stage the control's own row into the SAME status step 5 is judged from,
  --     the same out-of-band way step 5 stages it.
  --     Guarded: a guard trigger keyed on writing `claimed` (the shape "only
  --     buy-now may claim") passes leg 0a and dies here, and that is a control
  --     failure with a reason, not an unhandled error.
  if control_ok then
    reset role;
    begin
      update public.marketplace_listings set status = 'claimed' where id = ctl;
    exception when others then
      control_ok := false;
      control_note := format('the control listing could not be staged into claimed out of band (%s: %s), so leg 0c has no claimed row to write and step 5''s own staging would die the same way', sqlstate, sqlerrm);
    end;
    perform set_config('request.jwt.claim.sub', u::text, true);
    set local role authenticated;
  end if;

  -- 0c. THE ONE THING THE REFUSED STATEMENT CARRIES, ANSWERED THE OTHER WAY:
  --     same seller, same function, same `claimed` row state — only the target
  --     status changes, to `completed`, which the case allows from `claimed`. It
  --     MUST LAND. This is the leg that separates the state machine from a guard
  --     trigger or anything else that refuses to rewrite a claimed listing: if
  --     writing a claimed row is impossible for this seller, step 5's refusal is
  --     not the transition case's doing and the probe must not credit it.
  if control_ok then
    begin
      perform public.marketplace_set_listing_status(ctl, 'completed');
      select status into ctl_st from public.marketplace_listings where id = ctl;
      if ctl_st is distinct from 'completed' then
        control_ok := false;
        control_note := format('a LEGAL claimed -> completed left the control listing at %s, so step 5''s refusal of claimed -> pending is not attributable to the transition case', coalesce(ctl_st, '<not visible to this session>'));
      end if;
    exception when others then
      control_ok := false;
      control_note := format('a LEGAL claimed -> completed was refused (%s: %s) — something other than the transition case stops this seller writing a CLAIMED listing, so step 5 proves nothing about the state machine', sqlstate, sqlerrm);
    end;
  end if;

  -- The control's row does not outlive the control: the sweeps and counts below
  -- are measured against exactly what they were before it existed.
  reset role;
  delete from public.marketplace_listings where id = ctl;

  -- A failed control makes step 5's verdict unreadable, so say why here, while
  -- the reason is still in hand — and COUNT it rather than abort on it. Steps 1
  -- and 2 read pg_proc: they depend on neither this session nor any grant, and
  -- they are the only checks that see 0317's mechanism directly, so a dead
  -- session must not silence them. The closing raise names the control instead
  -- of a plain FAILED, so the boundary is reported neither as holding nor as
  -- broken: it is reported as unproven, and the build is red either way.
  if not control_ok then
    raise warning 'CONTROL FAILED (negative control, step 0): %', control_note;
    failures := failures + 1;
  end if;

  -- 1. The mechanism, in the installed function.
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'marketplace_set_listing_status';

  if src !~* 'for update' then
    raise warning 'BREACH: marketplace_set_listing_status reads without FOR UPDATE, so it decides from a row it does not hold';
    failures := failures + 1;
  end if;
  if src !~* 'and status = v_listing\.status' then
    raise warning 'BREACH: the UPDATE does not carry the status it decided from';
    failures := failures + 1;
  end if;

  -- 2. No other read-then-write SECURITY DEFINER function may drop both
  --    mechanisms either. This is the sweep that found this one, kept so the
  --    next such function is caught at replay rather than by a buyer.
  declare
    bare text[];
  begin
    -- How many functions the sweep below examines, so the closing notice carries
    -- the live number rather than the header's dated one.
    select count(*) into swept
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef
      and p.prosrc ~* 'select .* into ' and p.prosrc ~* 'update public\.';

    select coalesce(array_agg(p.proname order by p.proname), '{}') into bare
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef
      and p.prosrc ~* 'select .* into ' and p.prosrc ~* 'update public\.'
      and p.prosrc !~* 'for update'
      and p.prosrc !~* 'update public\.[a-z_]+[^;]*where[^;]*status\s*(=|in)';
    if array_length(bare, 1) > 0 then
      raise warning 'BREACH: % function(s) read a row then update it with neither a row lock nor a predicated write: %',
        array_length(bare, 1), array_to_string(bare, ', ');
      failures := failures + 1;
    end if;
  end;

  -- ── the state machine still works ────────────────────────────────────────
  insert into public.marketplace_listings (family_id, member_id, title, kind, price_cents, status)
    values (fam, seller, 'State bike', 'sell', 3000, 'available') returning id into listing;

  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;

  -- 3. Control: available -> pending is legal and still works.
  begin
    perform public.marketplace_set_listing_status(listing, 'pending');
    select status into st from public.marketplace_listings where id = listing;
    -- `is distinct from`, not `<>`: a row this session cannot see reads back
    -- NULL, and `null <> 'pending'` is NULL, which would count as nothing.
    if st is distinct from 'pending' then
      raise warning 'CONTROL FAILED: available -> pending did not take (status %)', coalesce(st, '<not visible to this session>');
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: available -> pending was refused (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 4. Control: pending -> available is legal and still works.
  begin
    perform public.marketplace_set_listing_status(listing, 'available');
  exception when others then
    raise warning 'CONTROL FAILED: pending -> available was refused (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 5. The forbidden one is still forbidden, judged from the true status.
  reset role;
  -- The out-of-band staging is guarded so that a decoy refusing every rewrite (a
  -- raising BEFORE trigger, say) is COUNTED here and the block still reaches its
  -- verdict: the control has already named that decoy above, and an unhandled
  -- error here would replace the UNPROVEN verdict with the decoy's own message.
  -- Nothing below is skipped on account of it.
  begin
    update public.marketplace_listings set status = 'claimed' where id = listing;
  exception when others then
    raise warning 'CONTROL FAILED: the listing could not be staged into claimed out of band (% %), so step 5 is not being judged from claimed', sqlstate, sqlerrm;
    failures := failures + 1;
  end;
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  begin
    perform public.marketplace_set_listing_status(listing, 'pending');
    raise warning 'BREACH: claimed -> pending was accepted';
    failures := failures + 1;
  exception when others then null;
  end;
  select status into st from public.marketplace_listings where id = listing;
  if st is distinct from 'claimed' then
    raise warning 'BREACH: after the refused call the listing reads % rather than claimed', coalesce(st, '<not visible to this session>');
    failures := failures + 1;
  end if;

  -- 6. Control: claimed -> withdrawn IS legal and must stay that way. A seller
  --    whose buyer falls through has to be able to pull the listing; widening
  --    the fix into forbidding this would break a real thing families do.
  begin
    perform public.marketplace_set_listing_status(listing, 'withdrawn');
    select status into st from public.marketplace_listings where id = listing;
    if st is distinct from 'withdrawn' then
      raise warning 'CONTROL FAILED: claimed -> withdrawn did not take (status %)', coalesce(st, '<not visible to this session>');
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: claimed -> withdrawn was refused (% %) — that transition is legal', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 7. Control: someone who does not own the listing still cannot move it.
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.marketplace_set_listing_status(listing, 'available');
    raise warning 'BREACH: a non-owner moved the listing';
    failures := failures + 1;
  exception when others then null;
  end;

  delete from public.marketplace_listings where family_id = fam;

  if failures > 0 then
    if not control_ok then
      -- The control did not hold, so step 5's verdict — whichever way it went —
      -- is not evidence about the state machine. Say UNPROVEN, not FAILED, and
      -- carry the leg's own reason; every other failed assertion has already
      -- printed its own WARNING above.
      raise exception '0317 UNPROVEN (the negative control this probe rests on did not hold: %) — % assertion(s) failed in all', control_note, failures;
    end if;
    raise exception '0317 FAILED: % assertion(s)', failures;
  end if;
  raise notice '0317 OK: the same seller CAN make the legal transitions, including out of claimed (2-leg negative control, run first), and the forbidden one is refused from the true status — the listing state machine decides from a locked row (9 assertions: 2 control legs + 7 steps; % read-then-write SECURITY DEFINER function(s) swept)', swept;
end
$probe$;
