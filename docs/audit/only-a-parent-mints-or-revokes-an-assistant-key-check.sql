-- ── Only a parent mints or revokes an assistant key (SRV-001 m9, 0343) ──────
--
-- HOLDS: supabase/migrations/0343_only_a_parent_mints_or_revokes_an_assistant_key.sql
--
-- An assistant key (public.assistant_links) is a standing bearer grant over a
-- household: whoever holds the secret whose SHA-256 is `token_hash` can have
-- POST /api/assistant read the family's day aloud and, with the `capture`
-- scope, write events, notes, groceries and to-dos back. resolveAssistantLink
-- (lib/assistant/service.ts) matches on token_hash + `revoked_at is null` and
-- nothing else.
--
-- 0283 said "only a parent/admin can create or revoke one" and then wrote its
-- INSERT/UPDATE/DELETE policies on can_manage_family() — `role in ('parent',
-- 'adult')` — while granting insert/update/delete to `authenticated`. The app's
-- own parent-only check (canManage = isAdmin(role)) lives in a server action
-- whose writes go through the BYPASSRLS service client, so it guards nothing a
-- member's own browser client cannot route around. An `adult` — the one role
-- on which can_manage_family and is_family_admin disagree — could, over
-- /rest/v1/assistant_links with their own JWT:
--
--   * MINT a live ask+capture key with a secret of their own choosing,
--     stamped user_id/created_by = the PARENT;
--   * WIDEN the parent's read-only kitchen speaker from {ask} to {ask,capture};
--   * REVOKE the parent's key, and UN-REVOKE a retired one;
--   * DELETE the parent's key, cascading its assistant_link_events away;
--   * and two routes this probe adds, one per half of 0343's update guard:
--     - EXTRACT a key: UPDATE the family_id of the parent's key OUT of the
--       household into one where the adult IS a parent. The new row passes
--       any check (the adult parents its new household); only the update
--       guard's USING on the OLD row says no. Measured: with that USING
--       loosened to `true` and its WITH CHECK intact, the move lands;
--     - TRANSPLANT a key: mint it in a family where they ARE a parent
--       (legitimately), then UPDATE its family_id into the household where
--       they are only an adult. The insert guard never sees that row; only the
--       update guard's WITH CHECK on the NEW row does.
--
-- 0343 adds three RESTRICTIVE policies on is_family_admin(family_id) — insert
-- (WITH CHECK), update (USING + WITH CHECK), delete (USING) — `to
-- authenticated, anon`. This probe proves, as the real roles:
--
--   1. the adult is REFUSED all seven moves above, in the household where they
--      are an adult: the INSERT and the TRANSPLANT raise 42501 NAMING 0343's
--      guard (`assistant_links_admin_insert_guard` /
--      `assistant_links_admin_update_guard`); the widen, revoke, un-revoke and
--      extract UPDATEs touch zero rows (or raise 42501 naming
--      assistant_links_admin_update_guard — the only error they are allowed to
--      raise); the DELETE touches zero rows and raises nothing; and — read
--      back as postgres — nothing moved: scopes still {ask}, the live key still
--      live, the retired key still retired, both still in the parent's
--      household, the audit row still there;
--   2. the adult can still SEE those keys (SELECT is deliberately untouched by
--      0343, and it is also what makes the zero-row counts mean "refused"
--      rather than "could not see the row");
--   3. the same INSERT made as `anon` carrying the adult's sub is refused by the
--      same named guard — this is the `anon` half of 0343's role list. In
--      production anon has no sub and can_manage_family already refuses it, so
--      this proves the role list, not a live second hole. It runs only while
--      anon holds INSERT on the table (Supabase's default privileges); if a
--      later migration takes that grant away, the grant is the closure and the
--      probe says so in its OK line instead of pretending to test it;
--   4. the PARENT of that household still mints, widens, revokes, un-revokes
--      and deletes with their own JWT, and the service role — the app's actual
--      writer in assistants/actions.ts and lib/assistant/service.ts — still
--      mints, revokes and deletes. A guard that refuses everyone is not a
--      boundary;
--   5. 0343's three guards are in the catalog as the migration's own closing
--      block requires — present, RESTRICTIVE, on insert/update/delete — and,
--      beyond that block, each still `to authenticated, anon` and still
--      carrying is_family_admin(family_id) in every clause 0343 wrote: WITH
--      CHECK on the insert guard, USING and WITH CHECK on the update guard,
--      USING on the delete guard. Read from pg_policy as postgres after the
--      writes above. The delete guard is USING-only and never names itself in
--      an error, so this is the one place its attribution is read directly
--      rather than inferred from the control.
--
-- NEGATIVE CONTROL — IT RUNS FIRST
-- ---------------------------------------------------------------------------
-- 0343 keys on exactly one question: is the caller a `parent` of the row's
-- family? So the control is the SAME adult (same auth.uid(), same role
-- `authenticated`, same JWT sub), making the SAME statements (insert, widen,
-- revoke, un-revoke, delete, and one family_id move that stands for both the
-- extract and the transplant), naming the SAME columns (family_id, user_id,
-- provider, label, token_hash, token_prefix, scopes, created_by on the insert;
-- scopes, revoked_at and family_id on the updates), against rows in households
-- where that adult IS a parent — FB, and FE, the move's control destination.
--
-- Everything except the adult's role is held equal, and the fixture asserts
-- it before the control runs: FA, FB and FE were all created by the same
-- PARENT, who is a parent in all three; the adult is a member of all three
-- (`adult` in FA, `parent` in FB and FE); and every key the control or the
-- attack touches — K1, K2 in FA; KB1, KB2, KB3 in FB — is stamped
-- user_id = created_by = that PARENT, exactly as the control's own mint and
-- the attack's mint are. So a guard keyed on ownership (`created_by =
-- auth.uid()`, a family-creator check) refuses the control exactly as it
-- refuses the attack, and cannot stand in for 0343. The permissive
-- can_manage_family and is_family_member answer yes in every household in
-- this file; is_family_admin is the only answer that flips. All seven control
-- writes (six when anon holds no INSERT) MUST land, and if any does not the
-- probe raises "UNPROVEN" before a single refusal is read.
--
-- What the control catches — each of these would make the refusals below
-- "pass" with 0343's guard gone or loosened, and each refuses the control too:
--
--   * a revoked or missing table GRANT (insert/update/delete from
--     authenticated), or a column-level revoke on scopes, revoked_at or
--     family_id — which is why the control's UPDATEs SET those very columns;
--   * a dead auth.uid() (a claim renamed, a sub not set) — can_manage_family
--     would then refuse the control exactly as it refuses the attack;
--   * an unrelated guard TRIGGER on assistant_links, which is how this
--     repository refuses writes elsewhere (0223, 0305, 0326, 0331) — it raises
--     42501 too, and the refusal would be credited to 0343. Those triggers let
--     the service role and a session with no auth.uid() through, so one of
--     that shape passes the fixture (seeded as postgres) and stops the
--     control. A trigger that refuses EVERY role stops the fixture's first
--     assistant_links insert instead — red at that line, as postgres, before
--     any verdict is reached, and credited to nothing;
--   * a row the adult simply cannot see, which gives UPDATE 0 / DELETE 0 just
--     as readily as a USING clause does (point 2 closes the other half);
--   * an ownership guard — a `created_by = auth.uid()` clause, as 0357 writes
--     into family_facts' policies — or a family-creator check, added to this
--     table later:
--     every row either side touches belongs to the PARENT, in a household the
--     PARENT created, so such a guard refuses the control's widen, revoke,
--     un-revoke and delete exactly as it refuses the attack's. (Measured: a
--     restrictive `using (created_by = auth.uid())` delete policy standing in
--     for a DROPPED delete guard fails the control's DELETE of KB1 — "removed
--     0 rows", UNPROVEN — because KB1 is the parent's row and the adult is the
--     actor. An earlier draft stamped KB1 for the adult, and that same stand-in
--     left it green.)
--
-- The insert and transplant refusals additionally require the error to NAME
-- 0343's guard, so a refusal that came from the permissive policy (a
-- can_manage_family that stopped answering yes for an adult) or anywhere else
-- is reported as unattributed rather than as the boundary holding. The widen,
-- revoke, un-revoke and extract may raise only 42501 naming
-- assistant_links_admin_update_guard (which is what they do if its USING is
-- loosened while its WITH CHECK holds: the new row is still in FA); any other
-- error there, and ANY error from the delete, is reported as unattributed.
--
-- Measured on fresh clones of the audit template (bubaly_tpl carries 0283 and
-- not 0343), this exact file each time, with 0343 applied on top by `psql -f`
-- before every run but the first:
--   * template as is, 0343 absent: exit 3 — "assistant key boundary failed: an
--     ADULT MINTED … | … WIDENED 1 … | … REVOKED 1 … | … UN-REVOKED 1 … |
--     … EXTRACTED 1 … | … DELETED 1 … | … TRANSPLANTED 1 … | an anon request
--     … MINTED … | the parent's kitchen speaker is GONE | … retired key is
--     LIVE again … | … audit trail has 0 rows … | 2 key(s) minted by a
--     non-parent exist in FA | the transplanted key now sits in family …a1 …
--     | 0343's assistant_links_admin_insert_guard is not in the catalog | …
--     delete_guard … | … update_guard …";
--   * with 0343, and again with 0343 applied a second time: exit 0, three OK
--     lines;
--   * with 0343 applied and then all three guards DROPPED: the same red as the
--     bare template, every move landing and all three catalog lines firing;
--   * update guard WITH CHECK altered to `true`: exit 3 on the TRANSPLANT ("…
--     TRANSPLANTED 1 …"), its read-back, and "… update_guard has WITH CHECK
--     true, not is_family_admin(family_id)"; the other six moves stay refused;
--   * update guard USING altered to `true`: exit 3 on the EXTRACT ("…
--     EXTRACTED 1 …") and "… update_guard has USING true …"; the widen,
--     revoke and un-revoke raise 42501 naming the update guard (its WITH CHECK
--     on the new row, still in FA) and count as refused;
--   * delete guard DROPPED alone: exit 3 — "… DELETED 1 … | the parent's
--     kitchen speaker is GONE | … audit trail has 0 rows … | 0343's
--     assistant_links_admin_delete_guard is not in the catalog";
--   * delete guard DROPPED and a restrictive `using (created_by = auth.uid())`
--     delete policy in its place: exit 3 on the CONTROL — "UNPROVEN … the
--     adult's DELETE of a key in a household they DO parent removed 0 rows";
--   * insert/update/delete REVOKED from authenticated: exit 3 on the CONTROL —
--     "UNPROVEN … (42501: permission denied for table assistant_links)";
--   * UPDATE re-granted on label, last_used_at, updated_at only: exit 3 on the
--     CONTROL — "UNPROVEN … WIDEN … raised 42501: permission denied …";
--   * a BEFORE trigger raising 42501 for `authenticated` and `anon`: exit 3 on
--     the CONTROL — "UNPROVEN … (42501: decoy …)";
--   * a BEFORE trigger raising 42501 for every role: exit 3 at the fixture's
--     first assistant_links insert, before the control — never a false green.
--
-- Everything runs in one transaction and is rolled back, so a re-run is
-- idempotent. UUIDs here all carry the `4000-8343` group and appear nowhere
-- else under docs/audit or supabase/migrations.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/only-a-parent-mints-or-revokes-an-assistant-key-check.sql

\set FA  '00000000-0000-4000-8343-0000000000a1'
\set UP  '00000000-0000-4000-8343-0000000000a2'
\set UA  '00000000-0000-4000-8343-0000000000a3'
\set FB  '00000000-0000-4000-8343-0000000000a4'
\set FE  '00000000-0000-4000-8343-0000000000a5'
\set MA  '00000000-0000-4000-8343-0000000000a6'
\set MBA '00000000-0000-4000-8343-0000000000a7'
\set MEA '00000000-0000-4000-8343-0000000000a8'
\set K1  '00000000-0000-4000-8343-0000000000b1'
\set K2  '00000000-0000-4000-8343-0000000000b2'
\set EV1 '00000000-0000-4000-8343-0000000000b3'
\set KB1 '00000000-0000-4000-8343-0000000000c1'
\set KB2 '00000000-0000-4000-8343-0000000000c2'
\set EVB '00000000-0000-4000-8343-0000000000c3'
\set KB3 '00000000-0000-4000-8343-0000000000c4'

begin;

-- ── Fixtures, as postgres ───────────────────────────────────────────────────
insert into auth.users (id, email) values (:'UP','m0343-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UA','m0343-adult@example.com')  on conflict do nothing;

-- FA: the parent's household. The adult is an ADULT here — can_manage_family
-- yes, is_family_admin no. This is the gap 0343 closes.
insert into public.families (id, name, created_by) values (:'FA','Assistant Key House',:'UP') on conflict do nothing;
update public.family_members set role = 'parent', is_active = true where family_id = :'FA' and user_id = :'UP';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MA',:'FA',:'UA','Other Adult','adult',true)
  on conflict (family_id, user_id) do update set role = 'adult', is_active = true;

-- FB and FE: households the SAME PARENT created (so, like FA, the parent is
-- filed as a parent there by on_family_created and FA/FB/FE share a creator),
-- in which the SAME adult is filed as a PARENT rather than an adult. That one
-- role is the only thing that differs from FA. Upsert rather than assume,
-- because a control whose roles are wrong fails for a reason that is not the
-- control's.
insert into public.families (id, name, created_by) values (:'FB','Assistant Key House (second home)',:'UP') on conflict do nothing;
update public.family_members set role = 'parent', is_active = true where family_id = :'FB' and user_id = :'UP';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MBA',:'FB',:'UA','Other Adult (a parent here)','parent',true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
insert into public.families (id, name, created_by) values (:'FE','Assistant Key House (cabin)',:'UP') on conflict do nothing;
update public.family_members set role = 'parent', is_active = true where family_id = :'FE' and user_id = :'UP';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MEA',:'FE',:'UA','Other Adult (a parent here too)','parent',true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;

-- FA's keys, minted by the parent (as the service role would): a read-only
-- kitchen speaker with one recorded use, and a retired key.
insert into public.assistant_links (id, family_id, user_id, provider, label, token_hash, token_prefix, scopes, created_by)
  values (:'K1',:'FA',:'UP','alexa','Kitchen speaker','m0343-hash-k1','m0343k1',array['ask'],:'UP');
insert into public.assistant_links (id, family_id, user_id, provider, label, token_hash, token_prefix, scopes, revoked_at, created_by)
  values (:'K2',:'FA',:'UP','siri','Old phone','m0343-hash-k2','m0343k2',array['ask','capture'],now() - interval '1 day',:'UP');
insert into public.assistant_link_events (id, link_id, family_id, intent, utterance, outcome)
  values (:'EV1',:'K1',:'FA','ask','what is on today','answered');

-- The control's mirror image in FB, plus the row the control moves (and the
-- transplant then tries to move on). Stamped for the PARENT, like K1/K2 — not
-- for the adult who acts on them — so ownership cannot tell control from
-- attack.
insert into public.assistant_links (id, family_id, user_id, provider, label, token_hash, token_prefix, scopes, created_by)
  values (:'KB1',:'FB',:'UP','alexa','Kitchen speaker (control)','m0343-hash-kb1','m0343b1',array['ask'],:'UP');
insert into public.assistant_links (id, family_id, user_id, provider, label, token_hash, token_prefix, scopes, revoked_at, created_by)
  values (:'KB2',:'FB',:'UP','siri','Old phone (control)','m0343-hash-kb2','m0343b2',array['ask','capture'],now() - interval '1 day',:'UP');
insert into public.assistant_link_events (id, link_id, family_id, intent, utterance, outcome)
  values (:'EVB',:'KB1',:'FB','ask','what is on today','answered');
insert into public.assistant_links (id, family_id, user_id, provider, label, token_hash, token_prefix, scopes, created_by)
  values (:'KB3',:'FB',:'UP','generic','Transplant candidate','m0343-hash-kb3','m0343b3',array['ask','capture'],:'UP');

do $$
declare
  n int;
  n_owners int;
  n_fams int;
  same_owner boolean;
  same_creator boolean;
  failures text[] := '{}';
  control_ok boolean := true;
  anon_can_insert boolean;
  st text;
  msg text;
  v_scopes text[];
  v_revoked timestamptz;
  v_family uuid;
  g record;

  fam_a   constant uuid := '00000000-0000-4000-8343-0000000000a1';
  parent_u constant uuid := '00000000-0000-4000-8343-0000000000a2';
  adult_u constant uuid := '00000000-0000-4000-8343-0000000000a3';
  fam_b   constant uuid := '00000000-0000-4000-8343-0000000000a4';
  fam_e   constant uuid := '00000000-0000-4000-8343-0000000000a5';
  k1      constant uuid := '00000000-0000-4000-8343-0000000000b1';
  k2      constant uuid := '00000000-0000-4000-8343-0000000000b2';
  minted  constant uuid := '00000000-0000-4000-8343-0000000000b4';
  anon_minted constant uuid := '00000000-0000-4000-8343-0000000000b5';
  kb1     constant uuid := '00000000-0000-4000-8343-0000000000c1';
  kb2     constant uuid := '00000000-0000-4000-8343-0000000000c2';
  kb3     constant uuid := '00000000-0000-4000-8343-0000000000c4';
  ctl_minted constant uuid := '00000000-0000-4000-8343-0000000000c5';
  anon_ctl_minted constant uuid := '00000000-0000-4000-8343-0000000000c6';
  parent_row constant uuid := '00000000-0000-4000-8343-0000000000d1';
  service_row constant uuid := '00000000-0000-4000-8343-0000000000d2';
begin
  anon_can_insert := has_table_privilege('anon', 'public.assistant_links', 'INSERT');

  -- The control and the attack must differ in the adult's role and nothing
  -- else a guard could key on. Read as postgres, before anyone acts: every key
  -- either side touches is stamped for the same owner, who is the PARENT, and
  -- all three households share that creator.
  select count(*), count(distinct (user_id, created_by)), bool_and(user_id = parent_u and created_by = parent_u)
    into n, n_owners, same_owner
    from public.assistant_links where id in (k1, k2, kb1, kb2, kb3);
  select count(*), bool_and(created_by = parent_u) into n_fams, same_creator
    from public.families where id in (fam_a, fam_b, fam_e);
  if n <> 5 or n_owners <> 1 or not same_owner or n_fams <> 3 or not same_creator then
    raise exception 'assistant key probe FIXTURE WRONG: expected K1, K2, KB1, KB2, KB3 all stamped user_id = created_by = the parent and FA, FB, FE all created by the parent; got % keys, % distinct owners, all-parent %, % families, parent-created % — the control would differ from the attack in more than is_family_admin',
      n, n_owners, same_owner, n_fams, same_creator;
  end if;

  -- ── As the adult ─────────────────────────────────────────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', adult_u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- The fixture is the gap, or the probe proves nothing: in FA the adult must
  -- pass the permissive predicate and fail the restrictive one; in FB and FE
  -- they must pass both.
  if not public.can_manage_family(fam_a) or public.is_family_admin(fam_a)
     or not public.is_family_admin(fam_b) or not public.is_family_admin(fam_e) then
    raise exception 'assistant key probe FIXTURE WRONG: expected can_manage_family(FA)=t, is_family_admin(FA)=f, is_family_admin(FB)=t, is_family_admin(FE)=t; got %, %, %, % — the refusals below would not be measuring the adult/parent gap',
      public.can_manage_family(fam_a), public.is_family_admin(fam_a),
      public.is_family_admin(fam_b), public.is_family_admin(fam_e);
  end if;

  -- ── NEGATIVE CONTROL: the same adult, the same statements, where they ARE a
  --    parent. Every one must land. ─────────────────────────────────────────
  begin
    insert into public.assistant_links (id, family_id, user_id, provider, label, token_hash, token_prefix, scopes, created_by)
      values (ctl_minted, fam_b, parent_u, 'alexa', 'Minted by the adult (control)', 'm0343-hash-ctl-minted', 'm0343cm', array['ask','capture'], parent_u);
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: the adult''s INSERT of an assistant key in a household they DO parent stored %s rows', n));
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: the adult was refused an assistant key in a household they DO parent (%s: %s), so a refusal in FA would prove only that something said no', sqlstate, sqlerrm));
  end;

  if control_ok then
    begin
      update public.assistant_links set scopes = array['ask','capture'] where id = kb1;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, format('CONTROL FAILED: the adult''s WIDEN of scopes on a key in a household they DO parent changed %s rows, so the zero-row refusal below would prove nothing', n));
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: the adult''s WIDEN of scopes on a key they DO parent raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  if control_ok then
    begin
      update public.assistant_links set revoked_at = now() where id = kb1;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, format('CONTROL FAILED: the adult''s REVOKE of a key in a household they DO parent changed %s rows', n));
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: the adult''s REVOKE of a key they DO parent raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  if control_ok then
    begin
      update public.assistant_links set revoked_at = null where id = kb2;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, format('CONTROL FAILED: the adult''s UN-REVOKE of a key in a household they DO parent changed %s rows', n));
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: the adult''s UN-REVOKE of a key they DO parent raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  if control_ok then
    begin
      delete from public.assistant_links where id = kb1;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, format('CONTROL FAILED: the adult''s DELETE of a key in a household they DO parent removed %s rows', n));
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: the adult''s DELETE of a key they DO parent raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  if control_ok then
    begin
      -- The transplant's control: move a key between two households the adult
      -- parents. Same row, same column; only the destination's
      -- is_family_admin differs from the refusal below.
      update public.assistant_links set family_id = fam_e where id = kb3;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, format('CONTROL FAILED: the adult''s move of a key between two households they DO parent changed %s rows', n));
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: the adult''s move of a key between two households they DO parent raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  if control_ok and anon_can_insert then
    set local role anon;
    perform set_config('request.jwt.claim.role', 'anon', true);
    begin
      insert into public.assistant_links (id, family_id, user_id, provider, label, token_hash, token_prefix, scopes, created_by)
        values (anon_ctl_minted, fam_b, parent_u, 'alexa', 'Minted as anon (control)', 'm0343-hash-anon-ctl', 'm0343ac', array['ask','capture'], parent_u);
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, format('CONTROL FAILED: an anon INSERT carrying the adult''s sub into a household they DO parent stored %s rows', n));
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: an anon INSERT carrying the adult''s sub into a household they DO parent raised %s: %s', sqlstate, sqlerrm));
    end;
    set local role authenticated;
    perform set_config('request.jwt.claim.role', 'authenticated', true);
  end if;

  -- A failed control makes every refusal below unreadable. Say so now, while
  -- the reason is in hand, rather than letting an unguarded statement below
  -- bury it under a raw "permission denied".
  if not control_ok then
    raise exception 'assistant key boundary UNPROVEN (the control this probe rests on did not hold): %', array_to_string(failures, ' | ');
  end if;

  -- ── THE REFUSALS: the same adult, in FA, where they are only an adult ────

  -- 0. Reads stay open, deliberately — and this is also what makes 2-6's zero
  --    rows a refusal rather than a row this session never saw. Read BEFORE
  --    any write is attempted, so a breach below cannot confound it.
  select count(*) into n from public.assistant_links where id in (k1, k2);
  if n <> 2 then
    failures := array_append(failures, format('the adult can SEE %s of the parent''s 2 keys (expected 2) — SELECT was meant to stay open, and without it the zero-row refusals below are unattributed', n));
  end if;

  -- 1. Mint a key stamped as the parent, with a secret only the adult knows.
  --    unique_violation is a breach, not a pass: RLS WITH CHECK runs before
  --    the unique index, so reaching it means RLS let the row through.
  begin
    insert into public.assistant_links (id, family_id, user_id, provider, label, token_hash, token_prefix, scopes, created_by)
      values (minted, fam_a, parent_u, 'alexa', 'Minted by the adult', 'm0343-hash-minted', 'm0343mi', array['ask','capture'], parent_u);
    failures := array_append(failures, 'an ADULT MINTED a live ask+capture assistant key in a household they do not parent, stamped as the parent — a bearer credential whose secret only they know');
  exception
    when insufficient_privilege then
      get stacked diagnostics msg = message_text;
      if msg not like '%assistant_links_admin_insert_guard%' then
        failures := array_append(failures, format('the adult''s mint was refused, but NOT by 0343''s assistant_links_admin_insert_guard (%s) — the boundary is unattributed', msg));
      end if;
    when unique_violation then
      failures := array_append(failures, 'the adult''s mint reached the unique index on token_hash, so RLS did not refuse it');
  end;

  -- 2-5. The UPDATEs. Each must touch zero rows. The one error each may raise
  --      instead is 42501 naming assistant_links_admin_update_guard — which is
  --      0343 refusing on the new row (its USING loosened, its WITH CHECK not),
  --      a refusal all the same. Any other error is not 0343 and is reported
  --      as unattributed; a breach is a row count, and is reported as one.

  -- 2. Widen the parent's read-only kitchen speaker.
  begin
    update public.assistant_links set scopes = array['ask','capture'] where id = k1;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('an ADULT WIDENED %s parent key(s) from {ask} to {ask,capture}', n));
    end if;
  exception
    when insufficient_privilege then
      get stacked diagnostics msg = message_text;
      if msg not like '%assistant_links_admin_update_guard%' then
        failures := array_append(failures, format('the adult''s widen was refused, but NOT by 0343''s assistant_links_admin_update_guard (%s) — the boundary is unattributed', msg));
      end if;
    when others then
      failures := array_append(failures, format('the adult''s widen raised %s: %s instead of touching zero rows — not 0343, the boundary is unattributed', sqlstate, sqlerrm));
  end;

  -- 3. Revoke the parent's live key.
  begin
    update public.assistant_links set revoked_at = now() where id = k1;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('an ADULT REVOKED %s parent key(s)', n));
    end if;
  exception
    when insufficient_privilege then
      get stacked diagnostics msg = message_text;
      if msg not like '%assistant_links_admin_update_guard%' then
        failures := array_append(failures, format('the adult''s revoke was refused, but NOT by 0343''s assistant_links_admin_update_guard (%s) — the boundary is unattributed', msg));
      end if;
    when others then
      failures := array_append(failures, format('the adult''s revoke raised %s: %s instead of touching zero rows — not 0343, the boundary is unattributed', sqlstate, sqlerrm));
  end;

  -- 4. Bring a retired key back to life.
  begin
    update public.assistant_links set revoked_at = null where id = k2;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('an ADULT UN-REVOKED %s retired parent key(s)', n));
    end if;
  exception
    when insufficient_privilege then
      get stacked diagnostics msg = message_text;
      if msg not like '%assistant_links_admin_update_guard%' then
        failures := array_append(failures, format('the adult''s un-revoke was refused, but NOT by 0343''s assistant_links_admin_update_guard (%s) — the boundary is unattributed', msg));
      end if;
    when others then
      failures := array_append(failures, format('the adult''s un-revoke raised %s: %s instead of touching zero rows — not 0343, the boundary is unattributed', sqlstate, sqlerrm));
  end;

  -- 5. The extract: move the parent's key OUT of FA into FB, where the adult
  --    is a parent. The new row passes every check there is, so only the
  --    update guard's USING on the old row can say no — the half 2-4 cannot
  --    isolate, because their new rows are still in FA. K2, not K1, so a
  --    breach here cannot hand the delete below a row in FB to "succeed" on.
  begin
    update public.assistant_links set family_id = fam_b where id = k2;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('an ADULT EXTRACTED %s parent key(s) out of the parent''s household into one they parent, by rewriting family_id', n));
    end if;
  exception
    when insufficient_privilege then
      get stacked diagnostics msg = message_text;
      if msg not like '%assistant_links_admin_update_guard%' then
        failures := array_append(failures, format('the adult''s extract was refused, but NOT by 0343''s assistant_links_admin_update_guard (%s) — the boundary is unattributed', msg));
      end if;
    when others then
      failures := array_append(failures, format('the adult''s extract raised %s: %s instead of touching zero rows — not 0343, the boundary is unattributed', sqlstate, sqlerrm));
  end;

  -- 6. Delete the parent's key (and, by cascade, its audit trail). 0343's
  --    delete guard is USING-only: it filters, it never raises. So an error
  --    here is by construction something else's refusal.
  begin
    delete from public.assistant_links where id = k1;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('an ADULT DELETED %s parent key(s), cascading away assistant_link_events', n));
    end if;
  exception when others then
    failures := array_append(failures, format('the adult''s delete raised %s: %s — 0343''s delete guard never raises, so this refusal is not 0343''s and the boundary is unattributed', sqlstate, sqlerrm));
  end;

  -- 7. The transplant: the key the control just moved into FE (a household the
  --    adult parents) is now moved into FA. USING sees the old row (FE, admin:
  --    yes); only the update guard's WITH CHECK on the new row can say no.
  begin
    update public.assistant_links set family_id = fam_a where id = kb3;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('an ADULT TRANSPLANTED %s key(s) into a household they do not parent by rewriting family_id — minting past the insert guard', n));
    else
      failures := array_append(failures, 'the adult''s transplant touched zero rows instead of being refused on the new row — the control moved this very row, so this is not the guard speaking');
    end if;
  exception
    when insufficient_privilege then
      get stacked diagnostics msg = message_text;
      if msg not like '%assistant_links_admin_update_guard%' then
        failures := array_append(failures, format('the adult''s transplant was refused, but NOT by 0343''s assistant_links_admin_update_guard (%s) — the boundary is unattributed', msg));
      end if;
  end;

  -- 8. The anon half of the role list: the same mint as `anon` with the
  --    adult's sub.
  if anon_can_insert then
    set local role anon;
    perform set_config('request.jwt.claim.role', 'anon', true);
    begin
      insert into public.assistant_links (id, family_id, user_id, provider, label, token_hash, token_prefix, scopes, created_by)
        values (anon_minted, fam_a, parent_u, 'alexa', 'Minted as anon', 'm0343-hash-anon-minted', 'm0343am', array['ask','capture'], parent_u);
      failures := array_append(failures, 'an anon request carrying the adult''s sub MINTED an assistant key in a household the adult does not parent — 0343''s guard does not cover anon');
    exception
      when insufficient_privilege then
        get stacked diagnostics msg = message_text;
        if msg not like '%assistant_links_admin_insert_guard%' then
          failures := array_append(failures, format('the anon mint was refused, but NOT by 0343''s assistant_links_admin_insert_guard (%s)', msg));
        end if;
      when unique_violation then
        failures := array_append(failures, 'the anon mint reached the unique index on token_hash, so RLS did not refuse it');
    end;
    set local role authenticated;
    perform set_config('request.jwt.claim.role', 'authenticated', true);
  end if;

  -- ── Read back as postgres: nothing the adult tried actually moved ────────
  set local role postgres;
  select scopes, revoked_at into v_scopes, v_revoked from public.assistant_links where id = k1;
  if not found then
    failures := array_append(failures, 'the parent''s kitchen speaker is GONE');
  else
    if v_scopes is distinct from array['ask'] then
      failures := array_append(failures, format('the parent''s read-only speaker now has scopes %s', v_scopes));
    end if;
    if v_revoked is not null then
      failures := array_append(failures, 'the parent''s live speaker is now REVOKED');
    end if;
  end if;
  select revoked_at into v_revoked from public.assistant_links where id = k2;
  if not found or v_revoked is null then
    failures := array_append(failures, 'the parent''s retired key is LIVE again (or gone)');
  end if;
  select count(*) into n from public.assistant_link_events where link_id = k1;
  if n <> 1 then
    failures := array_append(failures, format('the parent speaker''s audit trail has %s rows (expected 1)', n));
  end if;
  select count(*) into n from public.assistant_links where id in (minted, anon_minted);
  if n <> 0 then
    failures := array_append(failures, format('%s key(s) minted by a non-parent exist in FA', n));
  end if;
  select family_id into v_family from public.assistant_links where id = kb3;
  if v_family is distinct from fam_e then
    failures := array_append(failures, format('the transplanted key now sits in family %s (expected it to stay in FE)', v_family));
  end if;

  -- ── The guards themselves, read from the catalog ─────────────────────────
  -- 0343's own closing block requires the three guards present and RESTRICTIVE
  -- and stops there. This reads the rest of what 0343 wrote: each on its own
  -- command, each `to authenticated, anon`, and is_family_admin(family_id) in
  -- every clause — WITH CHECK on the insert guard, USING and WITH CHECK on the
  -- update guard, USING on the delete guard. It is the delete guard's only
  -- attribution: USING-only, it filters and never names itself, so without
  -- this read "DELETE touched 0 rows" above says that SOMETHING refused the
  -- adult, not that 0343 did. Read as postgres, after the writes, so a guard
  -- that was in place when the adult acted is the one being described.
  for g in
    select e.polname, e.cmd, e.wants_using, e.wants_check,
           p.polpermissive, p.polcmd,
           (select array_agg(r.rolname::text order by r.rolname) from pg_roles r where r.oid = any(p.polroles)) as roles,
           pg_get_expr(p.polqual, p.polrelid) as using_expr,
           pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
      from (values ('assistant_links_admin_insert_guard', 'a', false, true),
                   ('assistant_links_admin_update_guard', 'w', true,  true),
                   ('assistant_links_admin_delete_guard', 'd', true,  false))
             as e(polname, cmd, wants_using, wants_check)
      left join pg_policy p
        on p.polname = e.polname and p.polrelid = 'public.assistant_links'::regclass
     order by e.cmd
  loop
    if g.polcmd is null then
      failures := array_append(failures, format('0343''s %s is not in the catalog', g.polname));
      continue;
    end if;
    if g.polpermissive then
      failures := array_append(failures, format('0343''s %s is PERMISSIVE, not RESTRICTIVE — it widens the union, it cannot refuse', g.polname));
    end if;
    if g.polcmd::text <> g.cmd then
      failures := array_append(failures, format('0343''s %s is on command %s, not %s', g.polname, g.polcmd, g.cmd));
    end if;
    if g.roles is distinct from array['anon', 'authenticated'] then
      failures := array_append(failures, format('0343''s %s is to %s, not to authenticated, anon', g.polname, coalesce(array_to_string(g.roles, ', '), 'public')));
    end if;
    if g.wants_using and coalesce(g.using_expr, '') not like '%is_family_admin(family_id)%' then
      failures := array_append(failures, format('0343''s %s has USING %s, not is_family_admin(family_id)', g.polname, coalesce(g.using_expr, '(none)')));
    end if;
    if g.wants_check and coalesce(g.check_expr, '') not like '%is_family_admin(family_id)%' then
      failures := array_append(failures, format('0343''s %s has WITH CHECK %s, not is_family_admin(family_id)', g.polname, coalesce(g.check_expr, '(none)')));
    end if;
  end loop;

  -- ── Positive control: the PARENT of FA still does all of it ─────────────
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  begin
    insert into public.assistant_links (id, family_id, user_id, provider, label, token_hash, token_prefix, scopes, created_by)
      values (parent_row, fam_a, parent_u, 'google', 'Parent''s new speaker', 'm0343-hash-parent', 'm0343pa', array['ask'], parent_u);
    update public.assistant_links set scopes = array['ask','capture'] where id = parent_row;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, 'the PARENT could not widen their own key'); end if;
    update public.assistant_links set revoked_at = now() where id = parent_row;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, 'the PARENT could not revoke their own key'); end if;
    update public.assistant_links set revoked_at = null where id = parent_row;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, 'the PARENT could not un-revoke their own key'); end if;
    delete from public.assistant_links where id = parent_row;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, 'the PARENT could not delete their own key'); end if;
  exception when others then
    failures := array_append(failures, format('the PARENT was refused a write to their own household''s keys (%s: %s) — the guard refuses everyone', sqlstate, sqlerrm));
  end;

  -- ── And the app's real writer, the service role (BYPASSRLS, no sub) ─────
  set local role service_role;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  begin
    insert into public.assistant_links (id, family_id, user_id, provider, label, token_hash, token_prefix, scopes, created_by)
      values (service_row, fam_a, parent_u, 'alexa', 'Minted by the action', 'm0343-hash-service', 'm0343sv', array['ask','capture'], parent_u);
    update public.assistant_links set last_used_at = now(), revoked_at = now() where id = service_row;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, 'the SERVICE ROLE could not touch/revoke a key'); end if;
    delete from public.assistant_links where id = service_row;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, 'the SERVICE ROLE could not delete a key'); end if;
  exception when others then
    failures := array_append(failures, format('the SERVICE ROLE (the app''s own writer) was refused (%s: %s)', sqlstate, sqlerrm));
  end;

  set local role postgres;

  if array_length(failures, 1) is not null then
    raise exception 'assistant key boundary failed: %', array_to_string(failures, ' | ');
  end if;

  raise notice 'OK assistant_links (0343): the same adult CAN mint, widen, revoke, un-revoke, delete and move keys in households they parent (control); in the household where they are only an adult the mint and the family_id transplant are refused by 0343''s named guards, the widen/revoke/un-revoke/delete touch 0 rows, and nothing moved';
  if anon_can_insert then
    raise notice 'OK assistant_links (0343): an anon INSERT carrying the adult''s sub lands where the adult parents (control) and is refused by assistant_links_admin_insert_guard where they do not';
  else
    raise notice 'OK assistant_links (0343): anon holds no INSERT on assistant_links, so the grant closes the anon half and the guard''s anon clause has nothing to refuse';
  end if;
  raise notice 'OK assistant_links (0343): the adult still SEES the parent''s keys; the parent still mints, widens, revokes, un-revokes and deletes; the service role still writes';
end $$;

rollback;
