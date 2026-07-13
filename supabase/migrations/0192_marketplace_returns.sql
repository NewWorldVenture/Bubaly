-- ============================================================================
-- 0192 · Marketplace rent/borrow returns + overdue tracking.
--
-- The marketplace already supports 'rent' and 'borrow' listings, and orders
-- carry ends_on (the return due date). But nothing closes that loop: no "due
-- back Friday" reminder, no overdue flag when the ladder never comes home. For
-- a family lending library that's the whole point.
--
-- This is purely additive on marketplace_orders — two dedupe stamps so the
-- return-reminders cron sends each family exactly one due-soon nudge and one
-- overdue alert per order — plus an index the cron uses to find due/overdue
-- borrows cheaply. No new table. Requires 0151.
-- ============================================================================

alter table public.marketplace_orders
  add column if not exists due_reminder_sent_at timestamptz,
  add column if not exists overdue_notified_at  timestamptz,
  add column if not exists returned_at           timestamptz;

-- The cron scans open rent/borrow orders by due date.
create index if not exists idx_marketplace_orders_due
  on public.marketplace_orders(kind, status, ends_on)
  where kind in ('rent', 'borrow') and status in ('confirmed', 'active');
