-- Family to-do lists (personal + shared, separate from household chores)

create table if not exists public.todo_lists (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  created_by   uuid references public.family_members(id) on delete set null,
  name         text not null,
  color        text default 'violet',
  icon         text default '📋',
  is_shared    boolean not null default true,
  sort_order   int not null default 0,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.todo_items (
  id             uuid primary key default gen_random_uuid(),
  family_id      uuid not null references public.families(id) on delete cascade,
  list_id        uuid not null references public.todo_lists(id) on delete cascade,
  created_by     uuid references public.family_members(id) on delete set null,
  assigned_to_id uuid references public.family_members(id) on delete set null,
  title          text not null,
  notes          text,
  is_done        boolean not null default false,
  priority       text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  due_date       date,
  tags           text[] not null default '{}',
  sort_order     int not null default 0,
  completed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Indexes
create index if not exists todo_lists_family_idx on public.todo_lists(family_id);
create index if not exists todo_items_list_idx   on public.todo_items(list_id);
create index if not exists todo_items_family_idx on public.todo_items(family_id);

-- RLS
alter table public.todo_lists enable row level security;
alter table public.todo_items enable row level security;

create policy "family member access" on public.todo_lists for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));

create policy "family member access" on public.todo_items for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));
