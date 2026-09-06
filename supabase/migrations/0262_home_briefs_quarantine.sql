-- 0262: quarantine saved Home/Daily Brief snapshots without deleting their data.
-- Existing family-wide policies cannot revalidate access to every source in a
-- snapshot. Keep fresh generation independent and deny persisted access until
-- a complete authorization/invalidation contract can replace this containment.
-- A RESTRICTIVE policy is required: another permissive family policy must not
-- authorize access through OR composition. PUBLIC covers all non-bypassing roles.
-- Table owners and BYPASSRLS roles remain privileged; store helpers also refuse
-- reads/writes/claims even when supplied a privileged client.

do $quarantine$
declare
  briefs_table oid := to_regclass('public.home_briefs');
  existing_policy record;
begin
  if briefs_table is null then
    raise exception '0262: public.home_briefs is missing; apply the prerequisite migrations first';
  end if;

  lock table only public.home_briefs in access exclusive mode;
  if not exists (
    select 1 from pg_catalog.pg_class c
    where c.oid = briefs_table and c.relkind = 'r'
  ) then
    raise exception '0262: public.home_briefs is not an ordinary table; review this baseline';
  end if;

  alter table only public.home_briefs enable row level security;

  select p.polpermissive, p.polcmd, p.polroles,
    pg_get_expr(p.polqual, p.polrelid) as read_rule,
    pg_get_expr(p.polwithcheck, p.polrelid) as write_rule
  into existing_policy
  from pg_catalog.pg_policy p
  where p.polrelid = briefs_table and p.polname = 'home_briefs_snapshot_quarantine';

  if found then
    -- Idempotent only for the exact deny policy. Never silently accept or
    -- replace a differently defined policy under the expected name.
    if existing_policy.polpermissive is distinct from false
      or existing_policy.polcmd is distinct from '*'
      or existing_policy.polroles is distinct from array[0::oid]
      or existing_policy.read_rule is distinct from 'false'
      or existing_policy.write_rule is distinct from 'false'
    then
      raise exception '0262: unexpected quarantine policy definition; review this baseline';
    end if;
  else
    create policy home_briefs_snapshot_quarantine
      on public.home_briefs
      as restrictive
      for all
      to public
      using (false)
      with check (false);
  end if;
end;
$quarantine$;
