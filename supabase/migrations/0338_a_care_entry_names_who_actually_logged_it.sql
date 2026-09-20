-- Bubaly :: 0338 - a care, behaviour, screen-time or dose entry names the
--                  member who actually logged it (AUTHZ-017)
--
-- Four household ledgers carry an attribution column that nothing pins. Each
-- has exactly one policy, written when the table was created and never
-- narrowed:
--
--   care_log              0032   "Members can manage care_log"
--   screen_time_entries   0074   "Members manage screen_time_entries"
--   behavior_logs         00730  "Members manage behavior_logs"
--   medication_doses      00261  "Members can manage medication_doses"
--
-- all four `FOR ALL … is_family_member(family_id)`, which answers "is this
-- user in the household" and ignores role, and pins no column at all.
--
-- ── the reproduction, on a replayed database with all 346 migrations ────────
-- Acting as a `child` member, in one rolled-back transaction:
--
--   insert into care_log (family_id, member_id, log_type, occurred_at, note,
--                         logged_by, created_by)
--   values (<fam>, <the child>, 'medication', now(),
--           'Gave Grandma her tablets',
--           <the PARENT's family_members.id>, <the PARENT's uid>)   -> INSERT 1
--
--   insert into behavior_logs      (… logged_by = <the PARENT's uid> …)  -> INSERT 1
--   insert into screen_time_entries(… logged_by = <the PARENT's uid> …)  -> INSERT 1
--
-- and then, joining exactly as components/modules/care-module.tsx:253 does:
--
--   by Dad   <- note: Gave Grandma her tablets
--
-- ── why this one is sharper than 0333, and said plainly ────────────────────
-- `0333` pinned `parent_approvals.requested_by` and its header is careful to
-- say that NOTHING in the product selects that column, so no screen showed a
-- parent the wrong name. That is not true here. `care-module.tsx:253` renders
--
--   {e.logged_by && <div …>by {memberName(e.logged_by)}</div>}
--
-- under every entry in the care timeline. So a child can write a care entry
-- of type `medication` saying a dose was given, and the household reads it as
-- the parent's own record. In a care ledger that is the whole value of the
-- row. The other three are stored-record defects of `0320`'s class — nothing
-- renders their `logged_by` today — and are closed in the same migration
-- because they are the same column, written by the same shape of module, and
-- closing three now costs nothing over closing one.
--
-- NOT an escalation, and this does not claim one. Every one of these tables is
-- open to every member BY DESIGN and stays that way: logging care, a
-- behaviour note, screen time or a taken dose is what the product is for.
-- Only the NAME on the entry is pinned.
--
-- ── every writer, enumerated by bare table name ─────────────────────────────
-- Across app/, lib/, components/, scripts/ and mobile/, not only `.from('…')`:
--
--   care_log             components/modules/care-module.tsx — save() L116-117,
--                        quickLog() L127-130, remove() L138. Caller's own client.
--   behavior_logs        components/modules/behavior-module.tsx L77-79. Own client.
--   screen_time_entries  components/modules/screen-time-module.tsx L76-77, L85. Own.
--   medication_doses     components/modules/medications-module.tsx L288/291/295. Own.
--   READS ONLY           lib/server/notifications.ts, app/api/ai/insights,
--                        app/api/behavior/insight, lib/ai/insights.ts,
--                        lib/ai/context/policy.ts.
--
-- No service-role writer exists for any of the four, so nothing bypasses this.
-- SEED_ALL runs as the owner and bypasses RLS.
--
-- ── two details that decide the SHAPE, both read before writing SQL ─────────
--
-- 1. THE TYPES DIFFER. `care_log.logged_by` is a `family_members.id`
--    (care-module passes `selfMember?.id`); the other three are `auth.users.id`
--    (`userId`). So care_log needs the `exists (… fm.id = … and fm.user_id =
--    auth.uid())` shape and the rest take a bare `= auth.uid()`. Confirmed in
--    pg_constraint: care_log_logged_by_fkey -> family_members(id), the others
--    -> auth.users(id).
--
-- 2. NULL IS A STATE THE PRODUCT PRODUCES, for care_log only.
--    `logged_by: selfMember?.id ?? null` — so NULL must be allowed there or
--    every care entry written before `selfMember` resolves is refused. That is
--    not a hole worth closing: `{e.logged_by && …}` renders nothing for a NULL,
--    so an unattributed row shows NO name rather than the WRONG one, and this
--    finding is misattribution. The other three always pass `userId`, so NULL
--    is refused with everything else.
--
-- ── why INSERT is pinned by POLICY and UPDATE by TRIGGER ────────────────────
-- Not symmetry for its own sake. NONE of the four modules sets `logged_by` on
-- UPDATE — care-module's `fields`, behavior-module's `row` and the others all
-- omit it — so an UPDATE policy pinning `logged_by = auth.uid()` would be
-- evaluated against the row's EXISTING value and would refuse a parent editing
-- a CHILD's entry, which `openEdit` allows on purpose and no role check
-- forbids. A BEFORE UPDATE trigger that PRESERVES the column instead of
-- checking it closes the same hole and breaks nothing: the attribution simply
-- becomes immutable after insert, which is what these ledgers mean.
--
-- This is 0326's reasoning applied to a different column: raising the entry is
-- the member's, and only one field of it is not.
--
-- The INSERT guards are RESTRICTIVE rather than replacements, so `0032`,
-- `0074`, `00261` and `00730` keep owning the policies they named, and no
-- future permissive policy written out of habit can grant past these.
--
-- READS are untouched on all four. /care, /behavior, /screen-time and the
-- medication module render the household's own history to whoever is signed
-- in, deliberately.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent.

-- ── The attribution is fixed at insert ─────────────────────────────────────
create or replace function public.attribution_is_immutable()
returns trigger language plpgsql as $fn$
begin
  -- Preserve rather than refuse: the app never sends this column on UPDATE, so
  -- a check would fail the legitimate edit of somebody else's entry while a
  -- preserve simply keeps the truth that was recorded.
  new.logged_by := old.logged_by;
  if to_jsonb(new) ? 'created_by' then
    new.created_by := old.created_by;
  end if;
  return new;
end $fn$;

comment on function public.attribution_is_immutable() is
  '0338: logged_by/created_by are fixed at insert. Used by care_log, behavior_logs, screen_time_entries and medication_doses, whose modules never send these columns on UPDATE.';

do $$
declare
  t text;
begin
  -- care_log: logged_by is a family_members.id, and NULL is a state
  -- care-module genuinely produces (`selfMember?.id ?? null`).
  if to_regclass('public.care_log') is not null then
    drop policy if exists care_log_attribution_guard on public.care_log;
    create policy care_log_attribution_guard on public.care_log
      as restrictive for insert to authenticated
      with check (
        (logged_by is null or exists (
           select 1 from public.family_members fm
            where fm.id = care_log.logged_by
              and fm.user_id = auth.uid()
              and fm.family_id = care_log.family_id))
        and created_by = auth.uid()
      );
    revoke insert, update, delete, truncate on public.care_log from anon;
  end if;

  -- The other three take a user id and always receive one.
  foreach t in array array['behavior_logs', 'screen_time_entries', 'medication_doses'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists %I on public.%I', t || '_attribution_guard', t);
      execute format(
        'create policy %I on public.%I as restrictive for insert to authenticated '
        || 'with check (logged_by = auth.uid())', t || '_attribution_guard', t);
      execute format('revoke insert, update, delete, truncate on public.%I from anon', t);
    end if;
  end loop;

  -- One trigger per table, same function.
  foreach t in array array['care_log', 'behavior_logs', 'screen_time_entries', 'medication_doses'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists %I on public.%I', t || '_attribution_immutable', t);
      execute format(
        'create trigger %I before update on public.%I '
        || 'for each row execute function public.attribution_is_immutable()',
        t || '_attribution_immutable', t);
    end if;
  end loop;
end $$;

-- `anon` holds arwdDxt on every table created in `public` under Supabase's
-- default privileges, and all four still carried them. Not exploitable as it
-- stands — no permissive policy names anon, so RLS refuses for want of one —
-- and this does not claim otherwise; revoked for the reason 0290, 0322 and
-- 0328 give: one future policy written `TO public` would find the grant
-- waiting. SELECT is deliberately left alone.

do $$
declare
  t text;
  n int;
begin
  foreach t in array array['care_log', 'behavior_logs', 'screen_time_entries', 'medication_doses'] loop
    if to_regclass('public.' || t) is null then continue; end if;

    -- A migration that silently created nothing is worse than one that failed.
    select count(*) into n from pg_policies
     where schemaname = 'public' and tablename = t
       and policyname = t || '_attribution_guard'
       and permissive = 'RESTRICTIVE' and cmd = 'INSERT';
    if n = 0 then
      raise exception '0338: the restrictive attribution guard is missing from %', t;
    end if;

    select count(*) into n from pg_trigger tr
      join pg_class c on c.oid = tr.tgrelid
     where c.relname = t and not tr.tgisinternal
       and tr.tgname = t || '_attribution_immutable';
    if n = 0 then
      raise exception '0338: the attribution-immutable trigger is missing from %', t;
    end if;

    if has_table_privilege('anon', 'public.' || t, 'INSERT') then
      raise exception '0338: anon still holds INSERT on %', t;
    end if;

    -- Reads must be unchanged: these ledgers are the household's to read.
    if not exists (
      select 1 from pg_policies where schemaname = 'public' and tablename = t
        and permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL')
        and coalesce(qual, '') like '%is_family_member%'
    ) then
      raise exception '0338: % no longer has a household read policy — this migration must not have taken one away', t;
    end if;
  end loop;

  raise notice '0338 OK: care, behaviour, screen-time and dose entries name the member who logged them; logging stays open to every member, attribution is immutable after insert, reads unchanged.';
end $$;
