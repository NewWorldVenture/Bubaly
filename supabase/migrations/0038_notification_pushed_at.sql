-- Bubaly :: 0038 notification pushed_at
-- Split push and email delivery so a single notification can be BOTH pushed and
-- emailed. Previously both channels gated on notifications.sent_at and stamped
-- it, so whichever ran first in the cron starved the other. Push now tracks its
-- own pushed_at column; the email digest keeps sent_at.

alter table public.notifications
  add column if not exists pushed_at timestamptz;

-- Backfill: rows already delivered historically (sent_at set, stamped by the
-- push job before this split) are treated as already pushed so the next run
-- does not re-push the entire backlog.
update public.notifications
  set pushed_at = sent_at
  where sent_at is not null and pushed_at is null;

-- Index the un-pushed working set the dispatcher scans each run.
create index if not exists idx_notif_pending_push
  on public.notifications (created_at)
  where pushed_at is null;
