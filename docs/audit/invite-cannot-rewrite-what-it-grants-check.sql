-- ── CRITICAL An invite may not be rewritten by the person it invites ────────
--
-- `invites_update` was created with `USING` and no `WITH CHECK`. Postgres then
-- reuses `USING` as the write check, and that clause's invitee branch pinned
-- only `email` — so the invited person could rewrite `family_id` and `role` on
-- their own row and still satisfy it. `accept_invite()` is SECURITY DEFINER and
-- copies `family_id` and `role` from that row into `family_members`.
--
-- The end-to-end consequence, which is what this probe asserts: a babysitter
-- invited as `guest` issued one UPDATE and joined the household as a `parent`.
-- She needed no second family and no guessed UUID — the `family_id` was in her
-- own invite row, which `invites_select` lets her read.
--
-- 0298 removes the invitee branch (no application code updates `invites`;
-- acceptance runs entirely through `accept_invite`) and states `WITH CHECK`
-- explicitly so the omission cannot recur silently.
--
-- Four assertions, and the third is the one that matters — a structural check
-- would have passed over this for as long as the app never looked:
--
--   1. the invitee cannot change `role` on her own invite;
--   2. she cannot move it to another family;
--   3. **end to end**: after trying, she joins with the role she was offered;
--   4. a manager can still edit an invite in their own family, and cannot move
--      one out of it (the positive control, and the other half of the check).
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/invite-cannot-rewrite-what-it-grants-check.sql

\set FH '00000000-0000-4000-8000-00000000bf01'
\set FO '00000000-0000-4000-8000-00000000bf02'
\set UH '00000000-0000-4000-8000-00000000b001'
\set US '00000000-0000-4000-8000-00000000b002'
\set UO '00000000-0000-4000-8000-00000000b003'

begin;

insert into auth.users (id, email) values
  (:'UH','host@example.com'), (:'US','babysitter@example.com'), (:'UO','stranger@example.com')
  on conflict do nothing;
-- `Another Family` must have a DIFFERENT creator. A trigger on `families`
-- (`on_family_created` -> `handle_new_family`) provisions
-- `created_by` as a manager, so seeding both with the same owner makes the host
-- a manager of both — and the move-out assertion below then tests nothing. The
-- first draft of this probe did exactly that and reported the FIX as broken.
insert into public.families (id, name, created_by) values
  (:'FH','The Host Family',:'UH'), (:'FO','Another Family',:'UO') on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FH',:'UH','Host','parent',true) on conflict do nothing;
insert into public.invites (id, family_id, email, role, token, invited_by, status, expires_at)
  values ('00000000-0000-4000-8000-00000000be01', :'FH','babysitter@example.com','guest','tok-sitter',:'UH','pending', now() + interval '7 days');

grant select, insert, update, delete on public.invites to authenticated;

do $$
declare
  n int; rol text; fam uuid; joined text;
  failures text[] := '{}';
begin
  -- ── As the invited babysitter ───────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000b002', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-00000000b002","email":"babysitter@example.com","role":"authenticated"}', true);

  update public.invites set role = 'parent' where token = 'tok-sitter';
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('the invitee rewrote role on %s invite row(s)', n)); end if;

  update public.invites set family_id = '00000000-0000-4000-8000-00000000bf02' where token = 'tok-sitter';
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('the invitee moved the invite to another family on %s row(s)', n)); end if;

  -- The assertion that actually matters: what role does she END UP with?
  perform public.accept_invite('tok-sitter');

  perform set_config('role','postgres', true);
  select fm.role into joined from public.family_members fm
   where fm.family_id = '00000000-0000-4000-8000-00000000bf01'
     and fm.user_id = '00000000-0000-4000-8000-00000000b002';
  if joined is null then
    failures := array_append(failures, 'the invitee could not accept a legitimate invite at all — the fix is too tight');
  elsif joined <> 'guest' then
    failures := array_append(failures, format('the invitee joined as %s, having been offered guest', joined));
  end if;

  -- ── As the host: the positive control ───────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000b001', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-00000000b001","email":"host@example.com","role":"authenticated"}', true);

  update public.invites set role = 'adult' where token = 'tok-sitter';
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not edit an invite in their own family — the guard refuses everyone'); end if;

  -- …and WITH CHECK must stop even a manager moving one out of their family.
  --
  -- A WITH CHECK violation RAISES (42501); it does not quietly affect 0 rows,
  -- which is the difference between USING and WITH CHECK and the reason this
  -- assertion is written as a caught exception rather than a row count. The
  -- first draft counted rows and mis-reported the fix as broken.
  begin
    update public.invites set family_id = '00000000-0000-4000-8000-00000000bf02' where token = 'tok-sitter';
    failures := array_append(failures, 'a manager moved an invite into a family they do not manage — WITH CHECK is missing again');
  exception when insufficient_privilege then null;
  end;

  perform set_config('role','postgres', true);

  -- The structural cause, pinned: a policy with USING and no WITH CHECK reuses
  -- USING for the write, which is how one column of constraint became none.
  select count(*) into n from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relname = 'invites'
     and p.polcmd = 'w' and p.polwithcheck is null;
  if n <> 0 then
    failures := array_append(failures, 'invites_update has no WITH CHECK again — Postgres will reuse USING and the invitee branch constrains one column');
  end if;

  if array_length(failures, 1) is not null then
    raise exception 'invite grant check failed: %', array_to_string(failures, ' | ');
  end if;
  raise notice 'OK invites: the invitee cannot change what her invite grants, and joins as what she was offered';
end $$;

rollback;
