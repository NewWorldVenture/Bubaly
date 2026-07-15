-- ============================================================================
-- 0206 · Feedback → GitHub tracker + super-admin notifications
--
-- The /feedback board now accepts BUGS as well as ideas, and every new
-- submission (a) notifies the super admin and (b) is mirrored to a GitHub issue
-- tracker with two lists — bugs vs enhancements — driven by labels. A bot
-- (cron) reads both lists, reconciles each idea's status back here, and relays a
-- digest to the super admin.
--
--   • feedback_ideas gains `kind` ('idea' | 'bug') + the GitHub issue link
--     (number / url / state / synced_at) so each row round-trips with its issue.
--   • admin_notifications — a platform-wide (NOT family-scoped) super-admin feed
--     where new submissions and the bot's relays land. Service-role only (the
--     admin console reads it via the service role behind the super-admin gate);
--     no client policies → RLS denies direct access.
--
-- Additive + idempotent. Requires 0197 (feedback_ideas), set_updated_at.
-- ============================================================================

-- ── feedback_ideas: bug/idea kind + GitHub issue link ────────────────────────
alter table public.feedback_ideas
  add column if not exists kind text not null default 'idea'
    check (kind in ('idea','bug'));
alter table public.feedback_ideas add column if not exists github_issue_number integer;
alter table public.feedback_ideas add column if not exists github_issue_url    text;
alter table public.feedback_ideas add column if not exists github_state        text;   -- open | closed
alter table public.feedback_ideas add column if not exists github_synced_at    timestamptz;

create index if not exists idx_feedback_ideas_kind   on public.feedback_ideas(kind, status);
create index if not exists idx_feedback_ideas_gh     on public.feedback_ideas(github_issue_number);
-- Fast "which ideas still need a GitHub issue" scan for the backfill bot.
create index if not exists idx_feedback_ideas_unsynced on public.feedback_ideas(created_at)
  where github_issue_number is null;

-- ── admin_notifications: the super-admin platform feed ───────────────────────
create table if not exists public.admin_notifications (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null default 'info'
                 check (kind in ('feedback_new','github_sync','github_error','info')),
  title        text not null,
  body         text,
  url          text,                          -- deep link (an /admin/feedback or GitHub issue url)
  related_type text,                          -- e.g. 'feedback_idea'
  related_id   uuid,
  meta         jsonb not null default '{}'::jsonb,
  is_read      boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists idx_admin_notifications_unread on public.admin_notifications(is_read, created_at desc);

alter table public.admin_notifications enable row level security;
-- No policies: service-role only. The /admin console (super-admin-gated layout)
-- reads/writes it through the service role.
