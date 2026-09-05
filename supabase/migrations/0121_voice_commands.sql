-- Bubaly :: 0121 Voice commands ("Full conversational interface")
-- ----------------------------------------------------------------------------
-- Backs the Voice Control command center (/dashboard/voice): a family-scoped log
-- of every spoken command, how it was routed (task/note/event/shopping), what it
-- created, and its outcome. The transcript log powers the "recent commands"
-- history + one-tap re-run, and gives the conversational interface a memory.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.voice_commands (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  member_id     uuid references public.family_members(id) on delete set null,
  transcript    text not null,
  resolved_kind text check (resolved_kind in ('task','note','event','shopping')),
  action_table  text,                    -- e.g. 'todo_items', 'calendar_events'
  action_count  int not null default 0,  -- rows created by this command
  status        text not null default 'routed'
                  check (status in ('routed','failed','dismissed')),
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_voice_commands_family
  on public.voice_commands(family_id, created_at desc);
create index if not exists idx_voice_commands_member
  on public.voice_commands(family_id, member_id);

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['voice_commands'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;
