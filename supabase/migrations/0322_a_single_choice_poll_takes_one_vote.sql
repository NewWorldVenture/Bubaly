-- Bubaly :: 0322 - a single-choice poll takes one vote per member
--
-- `family_polls.kind` is 'single' or 'multi', and components/modules/voting-module.tsx
-- enforces the difference in the browser:
--
--   if (poll.kind === 'single' && mine.size > 0) {
--     // Clear the prior selection first; if this fails, do NOT insert or the
--     // single-choice poll ends up with two votes for this member.
--     const { error: clearErr } = await supabase.from('family_poll_votes')
--       .delete().eq('poll_id', poll.id).eq('member_id', meId);
--     if (clearErr) return toastError(describeDbError(clearErr));
--   }
--
-- The comment is exactly right about the consequence and the ordering is
-- careful. It is also the only thing enforcing it. `family_poll_votes` carries
-- `UNIQUE (option_id, member_id)` — one vote per OPTION per member, which is
-- the correct rule for a 'multi' poll and no rule at all for a 'single' one.
-- The table is client-reachable, so the delete-then-insert dance is advisory.
--
-- ── measured, acting as a child of the family ───────────────────────────────
--
--   SINGLE-choice poll: one member cast 3 votes across 3 options
--
-- One member, one single-choice poll, every option. `voterCount` and the bar
-- chart read straight from these rows, so the poll reports a result the family
-- never gave.
--
-- ── why a trigger and not an index ──────────────────────────────────────────
--
-- The rule depends on `family_polls.kind`, which lives in another table, and a
-- unique index cannot reach across one. 0316 closed its equivalent ("a chore is
-- paid once") with a partial unique index precisely because its rule was
-- expressible in one table's own columns; this one is not.
--
-- That difference also changes how pre-existing bad rows are handled, and the
-- distinction is deliberate rather than a softening. 0316 had to REFUSE to
-- apply while duplicates existed, because `create unique index` physically
-- cannot be created over rows that violate it. A trigger governs new writes
-- only, so it installs cleanly regardless and leaves existing rows exactly as
-- they are. This migration therefore REPORTS what is already in the data as a
-- notice instead of blocking on it: silently deleting a family's recorded votes
-- is not this migration's business either.
--
-- ── why it locks the poll ───────────────────────────────────────────────────
--
-- A trigger that only SELECTs before it INSERTs is 0317's defect over again:
-- two simultaneous votes each read "no existing vote" and both land. Taking
-- `for update` on the poll row is what makes the second one wait and then see
-- the first. Voting on one poll is serialized for the moment it takes to
-- insert a row; different polls do not contend at all.
--
-- The UPDATE arm matters as much as the INSERT arm. Without it a member casts
-- one legal vote and then repoints a second row's `option_id` at another
-- option of the same poll, arriving where the INSERT arm refused to let them.

create or replace function public.family_poll_vote_is_single()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_other int;
begin
  -- `for update` serializes concurrent voters on THIS poll, so the count below
  -- is a decision from a locked row rather than from a stale read.
  select kind into v_kind from public.family_polls where id = new.poll_id for update;
  if v_kind is distinct from 'single' then
    return new;
  end if;

  select count(*) into v_other
    from public.family_poll_votes v
   where v.poll_id = new.poll_id
     and v.member_id = new.member_id
     and v.id is distinct from new.id;

  if v_other > 0 then
    raise exception
      'this poll takes one choice per member and % already has a vote on it', new.member_id
      using errcode = '23505';
  end if;
  return new;
end $$;

comment on function public.family_poll_vote_is_single() is
  'Refuses a second vote by one member on a single-choice poll. The rule reads family_polls.kind, which a unique index cannot reach across, and takes `for update` on the poll so two simultaneous votes cannot both find none (0322).';

do $$
declare
  stuffed int;
begin
  if to_regclass('public.family_poll_votes') is null then
    return;
  end if;

  -- Say what is already in the data. A trigger governs new writes only, so
  -- unlike 0316's index this does not have to block on existing rows — and
  -- repairing a family's recorded votes is a decision, not a migration.
  select count(*) into stuffed from (
    select 1
      from public.family_poll_votes v
      join public.family_polls p on p.id = v.poll_id
     where p.kind = 'single'
     group by v.poll_id, v.member_id
    having count(*) > 1
  ) d;
  if stuffed > 0 then
    raise notice
      '0322: % member/poll pair(s) already hold more than one vote on a single-choice poll. The trigger stops new ones; these rows are left untouched and need a decision.',
      stuffed;
  end if;

  drop trigger if exists family_poll_vote_is_single on public.family_poll_votes;
  create trigger family_poll_vote_is_single
    before insert or update of poll_id, option_id, member_id on public.family_poll_votes
    for each row execute function public.family_poll_vote_is_single();
end
$$;
