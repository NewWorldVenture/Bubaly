-- Bubaly :: 0472 - a babysitter payment names its own family's babysitter and event
--
-- `babysitter_payments.babysitter_id` and `.event_id` are plain foreign keys
-- (0088): a missing id fails, but ANOTHER family's existing babysitter or
-- calendar event is accepted. The insert policies (0322, 0354) check only the
-- payment's own `family_id`, and none of the same-family reference guards
-- (0311, 0313, 0462) covers this table. Measured on a replayed database as a
-- real authenticated parent of family A: a payment filed in A, naming B's
-- babysitter for B's date night, was INSERTED, while A could not even read
-- that babysitter.
--
-- The server action now reads both references back in the caller's family
-- before it writes (#701). That is not a boundary, for two reasons:
--
--   1. A parent's own session can write this table directly through PostgREST
--      without the action.
--   2. Even through the action, the read and the insert are separate
--      statements with an awaited Trust evaluation between them. A babysitter
--      or event moved to another family in that window still ends up named by
--      a payment of the old one. A second read would only move the window.
--
-- So the rule is enforced here, in the statement that writes the reference,
-- and on the other side, in the statement that moves the parent.
--
-- ── the payment side ───────────────────────────────────────────────────────
--
-- A BEFORE INSERT / UPDATE trigger reads each non-null reference's family and
-- refuses one that is not the payment's own (42501). It reads the parent row
-- `FOR SHARE`, and that is the part that covers a concurrent move: an UPDATE of
-- the parent's family_id needs a row lock that conflicts with it.
--
--   * If the move is first, the locking read waits for it and then, at READ
--     COMMITTED, re-reads the moved row: the payment sees the NEW family and
--     is refused.
--   * If the payment is first, the move waits until the payment commits, and
--     the parent-side guard below then sees it.
--
-- FOR KEY SHARE would not do: a family_id change is a non-key update, and the
-- lock it takes does not conflict with KEY SHARE.
--
-- ── the parent side ────────────────────────────────────────────────────────
--
-- 0322 lets a manager update a babysitter profile, and checks the manager's
-- rights in the old and the new family. It does not stop a manager of BOTH
-- families (or a member of both, for a calendar event) from moving a
-- babysitter or event that this family's payments already name. A BEFORE
-- UPDATE OF family_id trigger on each parent refuses the move while any
-- payment of a different family names the row.
--
-- ── what does not change ───────────────────────────────────────────────────
--
-- * NULL references. An event stays optional, and ON DELETE SET NULL still
--   clears one.
-- * A reference that resolves to nothing. That is the foreign key's error
--   (23503), not this trigger's.
-- * Reads, and every other column. A payment's amount or status can be edited
--   without touching the guard.
-- * The trusted server (service role, or a migration or seed with no session)
--   is exempt on both sides, as throughout this series: backfills
--   legitimately move rows.
-- * Isolation level. The ordering argument above is for READ COMMITTED, which
--   is what PostgREST and the app use. At REPEATABLE READ the payment side
--   fails closed (a locked re-read of a moved row is a serialization failure),
--   but the parent side's check reads the transaction's snapshot and could miss
--   a payment committed after it began.
--
-- This stands alone. It does not reuse 0311's `reference_shares_family()`,
-- because that helper takes no lock, and 0311 is still listed as unapplied in
-- production (docs/PENDING_PROD_MIGRATIONS.md). Nothing here depends on it.
--
-- Before any trigger is created, existing rows are checked, read-only. A
-- payment that already names another family's babysitter or event stops the
-- migration, counted, rather than being rewritten: which side of such a row is
-- wrong is a person's decision.
--
-- Proof: docs/audit/a-babysitter-payment-names-its-own-familys-sitter-and-event-check.sql.

do $$
declare
  cross_sitter bigint;
  cross_event bigint;
begin
  if to_regclass('public.babysitter_payments') is null
     or to_regclass('public.babysitter_profiles') is null
     or to_regclass('public.calendar_events') is null then
    return;
  end if;

  select count(*) into cross_sitter
    from public.babysitter_payments p
    join public.babysitter_profiles s on s.id = p.babysitter_id
   where s.family_id is distinct from p.family_id;
  select count(*) into cross_event
    from public.babysitter_payments p
    join public.calendar_events e on e.id = p.event_id
   where e.family_id is distinct from p.family_id;

  if cross_sitter > 0 or cross_event > 0 then
    raise exception
      'babysitter_payments already holds % payment(s) naming another family''s babysitter and % naming another family''s event; they need a decision before this guard can be installed',
      cross_sitter, cross_event;
  end if;
end
$$;

create or replace function public.babysitter_payment_references_own_family()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  ref_family uuid;
begin
  if current_user = 'service_role'
     or coalesce(auth.role(), '') = 'service_role'
     or auth.uid() is null then
    return new;
  end if;

  if new.babysitter_id is not null then
    select family_id into ref_family
      from public.babysitter_profiles where id = new.babysitter_id
      for share;
    if found and ref_family is distinct from new.family_id then
      raise exception 'babysitter_payments.babysitter_id points at a babysitter in another family'
        using errcode = '42501';
    end if;
  end if;

  if new.event_id is not null then
    select family_id into ref_family
      from public.calendar_events where id = new.event_id
      for share;
    if found and ref_family is distinct from new.family_id then
      raise exception 'babysitter_payments.event_id points at a calendar event in another family'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$fn$;

comment on function public.babysitter_payment_references_own_family() is
  'A babysitter payment may name only its own family''s babysitter and calendar event. Reads each parent FOR SHARE, so a concurrent move of that parent to another family is either seen or waits (0472).';

create or replace function public.babysitter_payment_parent_keeps_its_family()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  ref_col text := tg_argv[0];
  named_by bigint;
begin
  if new.family_id is not distinct from old.family_id then
    return new;
  end if;
  if current_user = 'service_role'
     or coalesce(auth.role(), '') = 'service_role'
     or auth.uid() is null then
    return new;
  end if;

  execute format(
    'select count(*) from public.babysitter_payments where %I = $1 and family_id is distinct from $2',
    ref_col)
    into named_by using old.id, new.family_id;
  if named_by > 0 then
    raise exception '% is named by % babysitter payment(s) of its family and cannot move to another family',
      tg_table_name, named_by
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

comment on function public.babysitter_payment_parent_keeps_its_family() is
  'A babysitter profile or calendar event that a babysitter payment names may not move to another family while it is named. Takes the payment column as its trigger argument (0472).';

do $$
begin
  if to_regclass('public.babysitter_payments') is null
     or to_regclass('public.babysitter_profiles') is null
     or to_regclass('public.calendar_events') is null then
    return;
  end if;

  drop trigger if exists trg_babysitter_payments_reference_family on public.babysitter_payments;
  create trigger trg_babysitter_payments_reference_family
    before insert or update of babysitter_id, event_id, family_id on public.babysitter_payments
    for each row execute function public.babysitter_payment_references_own_family();

  drop trigger if exists trg_babysitter_profiles_keep_paid_family on public.babysitter_profiles;
  create trigger trg_babysitter_profiles_keep_paid_family
    before update of family_id on public.babysitter_profiles
    for each row when (old.family_id is distinct from new.family_id)
    execute function public.babysitter_payment_parent_keeps_its_family('babysitter_id');

  drop trigger if exists trg_calendar_events_keep_paid_family on public.calendar_events;
  create trigger trg_calendar_events_keep_paid_family
    before update of family_id on public.calendar_events
    for each row when (old.family_id is distinct from new.family_id)
    execute function public.babysitter_payment_parent_keeps_its_family('event_id');
end
$$;
