-- Remove malformed Auth users created by the retired onboarding-progress seed.
-- GoTrue owns auth.users and its identity/metadata invariants; seed scripts must
-- never write that table directly.

begin;

do $$
declare
  synthetic_count integer;
begin
  select count(*)
    into synthetic_count
  from auth.users
  where email ~ '^(onb[0-9]+@seed-onb\.bubaly\.test|person[0-9]+@seed\.bubaly\.test)$';

  if synthetic_count > 1000 then
    raise exception 'Refusing to remove % synthetic Auth users; expected at most 1000', synthetic_count;
  end if;

  delete from auth.users
  where email ~ '^(onb[0-9]+@seed-onb\.bubaly\.test|person[0-9]+@seed\.bubaly\.test)$';

  raise notice 'Removed % retired synthetic Auth users.', synthetic_count;
end $$;

commit;
