-- 0094_calendar_context.sql
-- Personal / Work / Family separation for the unified family calendar, plus
-- per-person external calendars. Everyone still sees everything in one place;
-- `context` is a filterable lens, and AI scheduling reads per-person busy time.

-- A free-form-but-constrained context lens on every event.
alter table calendar_events
  add column if not exists context text not null default 'family'
  check (context in ('family', 'personal', 'work'));

create index if not exists idx_calendar_events_context on calendar_events(context);
create index if not exists idx_calendar_events_assignee on calendar_events(assignee_id);

-- External feeds (ICS / Google) can now belong to a person and carry a context,
-- so a synced "Work" calendar tags its events as that member's work events.
alter table calendar_feeds
  add column if not exists context text not null default 'family'
  check (context in ('family', 'personal', 'work'));
alter table calendar_feeds
  add column if not exists member_id uuid references family_members(id) on delete set null;
