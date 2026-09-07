-- ================================================================
-- Migration 0010: Support Tickets & Admin Users
-- ================================================================

-- ── support_tickets ─────────────────────────────────────────────
create table if not exists public.support_tickets (
  id               uuid        primary key default gen_random_uuid(),
  ticket_number    text        unique not null,
  subject          text        not null,
  description      text,
  category         text        not null default 'general',
    -- 'technical' | 'billing' | 'account' | 'family' | 'general' | 'feature_request'
  priority         text        not null default 'medium',
    -- 'low' | 'medium' | 'high' | 'urgent'
  status           text        not null default 'open',
    -- 'open' | 'in_progress' | 'pending' | 'resolved' | 'closed'
  requester_id     uuid        references auth.users(id) on delete set null,
  requester_name   text,
  requester_email  text        not null,
  assigned_agent_id uuid       references auth.users(id) on delete set null,
  assigned_agent_name text,
  family_id        uuid        references public.families(id) on delete set null,
  tags             text[]      not null default '{}',
  resolution_note  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  closed_at        timestamptz
);

-- auto-update updated_at
create or replace function public.set_support_ticket_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create trigger trg_support_tickets_updated_at
  before update on public.support_tickets
  for each row execute function public.set_support_ticket_updated_at();

-- sequential ticket number generator
create sequence if not exists public.support_ticket_seq;

-- RLS: only service-role (admin console) reads/writes
alter table public.support_tickets enable row level security;
create policy "service_role_all" on public.support_tickets
  using (true) with check (true);

-- ── admin_users ──────────────────────────────────────────────────
create table if not exists public.admin_users (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        references auth.users(id) on delete cascade,
  email         text        not null unique,
  full_name     text,
  avatar_url    text,
  admin_role    text        not null default 'administrator',
    -- 'super_administrator' | 'administrator' | 'content_manager'
    -- | 'billing_manager'  | 'moderator'     | 'viewer'
  permissions   text[]      not null default '{}',
  status        text        not null default 'pending',
    -- 'active' | 'inactive' | 'pending'
  last_active_at timestamptz,
  joined_at     timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

alter table public.admin_users enable row level security;
create policy "service_role_all" on public.admin_users
  using (true) with check (true);

-- ── seed sample support tickets ──────────────────────────────────
insert into public.support_tickets
  (ticket_number, subject, category, priority, status,
   requester_name, requester_email, assigned_agent_name, updated_at)
values
  ('TKT-2024-0514-001','Can''t access Family Dashboard','account','high','open',
   'John Smith','john.smith@email.com','Sarah Johnson',
   '2024-05-14 10:24:00+00'),
  ('TKT-2024-0514-002','Payment failed but amount was deducted','billing','high','in_progress',
   'Lisa Brown','lisa.brown@email.com','Michael Davis',
   '2024-05-14 09:58:00+00'),
  ('TKT-2024-0514-003','Request refund for cancelled subscription','billing','medium','pending',
   'Emily Wilson','emily.w@email.com','Jessica Lee',
   '2024-05-14 09:32:00+00'),
  ('TKT-2024-0514-004','Unable to add family member','family','medium','open',
   'Robert Taylor','robert.t@email.com','David Wilson',
   '2024-05-14 08:45:00+00'),
  ('TKT-2024-0514-005','Content not playing on Apple TV','technical','low','in_progress',
   'Amanda Clark','amanda.c@email.com','Kevin Patel',
   '2024-05-14 07:21:00+00'),
  ('TKT-2024-0513-009','How do I set screen time limits?','general','low','resolved',
   'Daniel Martinez','daniel.m@email.com','Sarah Johnson',
   '2024-05-13 23:47:00+00'),
  ('TKT-2024-0513-008','App keeps logging me out','account','high','open',
   'Olivia Anderson','olivia.a@email.com','Michael Davis',
   '2024-05-13 22:30:00+00'),
  ('TKT-2024-0513-007','Unable to update payment method','billing','medium','pending',
   'Kevin Thomas','kevin.t@email.com','Jessica Lee',
   '2024-05-13 20:12:00+00'),
  ('TKT-2024-0513-006','Feature request: Dark mode for kids app','feature_request','low','open',
   'Sophia Garcia','sophia.g@email.com',null,
   '2024-05-13 18:05:00+00'),
  ('TKT-2024-0513-005','Parental controls not working properly','technical','high','in_progress',
   'Brian White','brian.w@email.com','Kevin Patel',
   '2024-05-13 16:20:00+00')
on conflict (ticket_number) do nothing;

-- ── seed sample admin users ───────────────────────────────────────
insert into public.admin_users
  (email, full_name, admin_role, permissions, status, last_active_at, joined_at)
values
  ('admin@familyos.com','Admin User','super_administrator',
   ARRAY['All Access'],'active','2024-05-14 10:24:00+00','2024-01-15 09:30:00+00'),
  ('michael.davis@familyos.com','Michael Davis','administrator',
   ARRAY['User','Content','Reports','Billing'],'active','2024-05-14 09:58:00+00','2024-02-10 11:20:00+00'),
  ('sarah.johnson@familyos.com','Sarah Johnson','administrator',
   ARRAY['User','Content','Security','Reports'],'active','2024-05-14 09:32:00+00','2024-02-18 14:15:00+00'),
  ('james.wilson@familyos.com','James Wilson','administrator',
   ARRAY['User','Billing','Support'],'active','2024-05-14 08:45:00+00','2024-03-01 10:10:00+00'),
  ('emily.brown@familyos.com','Emily Brown','administrator',
   ARRAY['Content','Reports','Support'],'active','2024-05-13 21:00:00+00','2024-03-12 09:45:00+00'),
  ('david.wilson@familyos.com','David Wilson','administrator',
   ARRAY['User','Support'],'active','2024-05-13 18:30:00+00','2024-03-20 13:00:00+00'),
  ('jessica.lee@familyos.com','Jessica Lee','content_manager',
   ARRAY['Content Management'],'active','2024-05-13 17:00:00+00','2024-04-05 15:40:00+00'),
  ('kevin.patel@familyos.com','Kevin Patel','billing_manager',
   ARRAY['Billing','Payments','Reports'],'active','2024-05-13 16:20:00+00','2024-04-12 11:25:00+00'),
  ('olivia.martinez@familyos.com','Olivia Martinez','moderator',
   ARRAY['Support','User Management'],'active','2024-05-12 21:15:00+00','2024-04-20 14:55:00+00'),
  ('robert.taylor@familyos.com','Robert Taylor','viewer',
   ARRAY['Reports (View Only)'],'inactive','2024-05-10 10:05:00+00','2024-04-28 09:00:00+00'),
  ('amanda.clark@familyos.com','Amanda Clark','content_manager',
   ARRAY['Content Management'],'pending',null,'2024-05-13 15:30:00+00'),
  ('brian.white@familyos.com','Brian White','administrator',
   ARRAY['User','Security','Reports'],'pending',null,'2024-05-14 08:10:00+00')
on conflict (email) do nothing;
