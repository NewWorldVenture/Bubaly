-- ============================================================================
-- 0256_idempotency_keys.sql — make "this write must not happen twice" a
-- database fact instead of a probe the application hopes to win.
-- ----------------------------------------------------------------------------
-- Spec §30 (duplicate protection) and §45: a retried tool call — the same run
-- step executed twice after a lease expiry, a POST the phone sent again on a
-- flaky connection — must produce ONE calendar event, ONE reminder, ONE to-do.
--
-- Until now `lib/services/idempotency.ts` guarded that with a natural-key
-- probe: "is there already an event with this title at this instant?". A probe
-- is a read before a write, so two concurrent retries can both read "no" and
-- both insert. This migration gives the six tables the AI writes an
-- `idempotency_key` and a PARTIAL unique index over `(family_id,
-- idempotency_key)` — partial, so the millions of rows people create by hand
-- (key null) are untouched and unconstrained.
--
-- `transactions` gets a different shape for a different duplicate: a receipt
-- scanned twice is the same charge, and its identity is the charge itself, not
-- a run step. `fingerprint` (family + merchant + amount + date, hashed by the
-- caller), `source` (how the row arrived: manual, receipt, import, ai) and
-- `receipt_document_id` (the document it was read from) let the finance
-- service refuse the second copy and show the family where the first came
-- from. Its unique index is partial on `fingerprint` for the same reason.
--
-- ADDITIVE + IDEMPOTENT: every column and index is `if not exists`; no
-- existing row is rewritten and no policy changes. Safe to re-run.
-- ============================================================================

-- ─── The six tables the AI's write tools create rows in ─────────────────────
alter table public.calendar_events   add column if not exists idempotency_key text;
alter table public.family_reminders  add column if not exists idempotency_key text;
alter table public.todo_items        add column if not exists idempotency_key text;
alter table public.chore_assignments add column if not exists idempotency_key text;
alter table public.meal_plans        add column if not exists idempotency_key text;
alter table public.grocery_items     add column if not exists idempotency_key text;

create unique index if not exists uq_calendar_events_idempotency
  on public.calendar_events (family_id, idempotency_key) where idempotency_key is not null;
create unique index if not exists uq_family_reminders_idempotency
  on public.family_reminders (family_id, idempotency_key) where idempotency_key is not null;
create unique index if not exists uq_todo_items_idempotency
  on public.todo_items (family_id, idempotency_key) where idempotency_key is not null;
create unique index if not exists uq_chore_assignments_idempotency
  on public.chore_assignments (family_id, idempotency_key) where idempotency_key is not null;
create unique index if not exists uq_meal_plans_idempotency
  on public.meal_plans (family_id, idempotency_key) where idempotency_key is not null;
create unique index if not exists uq_grocery_items_idempotency
  on public.grocery_items (family_id, idempotency_key) where idempotency_key is not null;

-- ─── transactions: the same charge, not the same call ───────────────────────
alter table public.transactions add column if not exists fingerprint text;
alter table public.transactions add column if not exists source text not null default 'manual';
alter table public.transactions add column if not exists receipt_document_id uuid;

do $$
begin
  -- The documents table predates this file everywhere it matters, but a
  -- restore ordered differently must not fail the whole migration.
  if to_regclass('public.documents') is not null
     and not exists (
       select 1 from pg_constraint
       where conname = 'transactions_receipt_document_id_fkey'
         and conrelid = 'public.transactions'::regclass
     )
  then
    alter table public.transactions
      add constraint transactions_receipt_document_id_fkey
      foreign key (receipt_document_id) references public.documents(id) on delete set null;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'transactions_source_check' and conrelid = 'public.transactions'::regclass
  ) then
    alter table public.transactions
      add constraint transactions_source_check
      check (source in ('manual', 'receipt', 'import', 'ai'));
  end if;
end $$;

create unique index if not exists uq_transactions_fingerprint
  on public.transactions (family_id, fingerprint) where fingerprint is not null;

-- Production verification:
--   select indexname from pg_indexes
--    where indexname in ('uq_calendar_events_idempotency','uq_family_reminders_idempotency',
--                        'uq_todo_items_idempotency','uq_chore_assignments_idempotency',
--                        'uq_meal_plans_idempotency','uq_grocery_items_idempotency',
--                        'uq_transactions_fingerprint');
--   select count(*) from public.calendar_events where idempotency_key is not null; -- 0 before first AI write
