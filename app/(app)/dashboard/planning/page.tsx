import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import {
  Calendar as CalendarIcon, CheckSquare, BellRing, StickyNote, FolderLock,
  Contact as ContactIcon, Award, Newspaper, ChevronRight, LayoutGrid, Image as ImageIcon,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { cn } from '@/lib/utils/cn';
import { fmtTime } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Planning & Organization' };
export const dynamic = 'force-dynamic';

const fmtDay = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

// Per-query fail-safe: a single domain erroring (e.g. a table not yet migrated on
// this database, or a slow/failed count) degrades that one card to empty instead
// of taking down the whole hub via the error boundary.
async function safe<T>(q: PromiseLike<{ data: T[] | null; count?: number | null }>): Promise<{ data: T[] | null; count: number | null }> {
  try {
    const r = await q;
    return { data: r.data ?? null, count: r.count ?? null };
  } catch {
    return { data: null, count: null };
  }
}

// One feature card in the hub grid.
function FeatureCard({
  index, title, href, icon: Icon, tint, count, countLabel, children,
}: {
  index: number; title: string; href: string; icon: React.ComponentType<{ className?: string }>;
  tint: string; count: number; countLabel: string; children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col rounded-2xl border border-border bg-surface/40 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className={cn('grid h-9 w-9 place-items-center rounded-xl', tint)}><Icon className="h-5 w-5" /></span>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted">{index}.</p>
            <h2 className="-mt-0.5 text-sm font-bold">{title}</h2>
          </div>
        </div>
        <Link href={href} className="flex items-center gap-0.5 rounded-lg px-2 py-1 text-xs font-semibold text-brand transition hover:bg-brand/10" aria-label={`Open ${title}`}>
          Open <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="min-h-[120px] flex-1 space-y-2">{children}</div>
      <Link href={href} className="mt-4 border-t border-border/60 pt-3 text-xs font-semibold text-muted transition hover:text-brand">
        {count} {countLabel} <ChevronRight className="inline h-3 w-3" />
      </Link>
    </section>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-center text-xs text-muted">{children}</p>;
}

function ListRow({ label, meta, dot }: { label: string; meta?: string; dot?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dot ?? 'bg-brand/60')} />
      <span className="min-w-0 flex-1 truncate text-sm text-fg/90">{label}</span>
      {meta && <span className="shrink-0 text-xs text-muted">{meta}</span>}
    </div>
  );
}

export default async function PlanningPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const now = new Date();
  const nowIso = now.toISOString();
  const todayIso = now.toISOString().slice(0, 10);

  const [
    { data: events, count: eventCount },
    { data: tasks, count: taskCount },
    { data: reminders, count: reminderCount },
    { data: notes, count: noteCount },
    { data: docs, count: docCount },
    { data: contacts, count: contactCount },
    { data: milestones, count: milestoneCount },
    { data: photos, count: photoCount },
  ] = await Promise.all([
    safe(supabase.from('calendar_events').select('id, title, starts_at, all_day', { count: 'exact' })
      .eq('family_id', familyId).gte('starts_at', nowIso).order('starts_at').limit(4)),
    safe(supabase.from('todo_items').select('id, title, due_date', { count: 'exact' })
      .eq('family_id', familyId).eq('is_done', false).order('due_date', { ascending: true, nullsFirst: false }).limit(4)),
    safe(supabase.from('family_reminders').select('id, title, remind_at', { count: 'exact' })
      .eq('family_id', familyId).eq('status', 'active').order('remind_at', { ascending: true, nullsFirst: false }).limit(4)),
    safe(supabase.from('notes').select('id, title, body, updated_at', { count: 'exact' })
      .eq('family_id', familyId).order('updated_at', { ascending: false }).limit(4)),
    safe(supabase.from('documents').select('id, title, category, created_at', { count: 'exact' })
      .eq('family_id', familyId).order('created_at', { ascending: false }).limit(4)),
    safe(supabase.from('family_contacts').select('id, name, relationship', { count: 'exact' })
      .eq('family_id', familyId).order('name').limit(5)),
    safe(supabase.from('family_milestones').select('id, title, milestone_date', { count: 'exact' })
      .eq('family_id', familyId).gte('milestone_date', todayIso).order('milestone_date').limit(4)),
    safe(supabase.from('family_photos').select('id, url, thumbnail_url', { count: 'exact' })
      .eq('family_id', familyId).order('created_at', { ascending: false }).limit(4)),
  ]);

  type Ev = { id: string; title: string; starts_at: string; all_day: boolean };
  type Td = { id: string; title: string; due_date: string | null };
  type Rm = { id: string; title: string; remind_at: string | null };
  type Nt = { id: string; title: string | null; body: string; updated_at: string };
  type Dc = { id: string; title: string; category: string | null; created_at: string };
  type Ct = { id: string; name: string; relationship: string | null };
  type Ms = { id: string; title: string; milestone_date: string };
  type Ph = { id: string; url: string | null; thumbnail_url: string | null };

  const PAGES = ['Calendar', 'Tasks', 'Reminders', 'Notes', 'Documents', 'Contacts', 'Milestones', 'Family Wall'];

  return (
    <div className="space-y-6 pb-28">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Planning &amp; Organization</h1>
          <p className="mt-1 text-sm text-muted">Every page. Everything you need to plan, organize and stay in sync as a family.</p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-2 self-start rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm font-bold">
          <LayoutGrid className="h-4 w-4 text-brand" /> 8 Pages
        </span>
      </div>

      {/* Intro hero */}
      <section className="rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/10 to-violet-500/5 p-6">
        <p className="text-sm font-semibold text-brand">All your plans, tasks, notes, documents and people — organized in one place.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {PAGES.map((p) => (
            <span key={p} className="rounded-full border border-border bg-surface/60 px-3 py-1 text-xs font-semibold text-fg/80">{p}</span>
          ))}
        </div>
      </section>

      {/* 8-card grid */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {/* 1. Calendar */}
        <FeatureCard index={1} title="Calendar" href="/dashboard/calendar" icon={CalendarIcon} tint="bg-blue-500/15 text-blue-400" count={eventCount ?? 0} countLabel="upcoming events">
          {(events ?? []).length === 0 ? <EmptyHint>No upcoming events.</EmptyHint>
            : (events as Ev[]).map((e) => <ListRow key={e.id} label={e.title} meta={e.all_day ? fmtDay(e.starts_at) : fmtTime(e.starts_at)} dot="bg-blue-400" />)}
        </FeatureCard>

        {/* 2. Tasks */}
        <FeatureCard index={2} title="Tasks" href="/dashboard/todos" icon={CheckSquare} tint="bg-emerald-500/15 text-emerald-400" count={taskCount ?? 0} countLabel="open tasks">
          {(tasks ?? []).length === 0 ? <EmptyHint>No open tasks.</EmptyHint>
            : (tasks as Td[]).map((t) => <ListRow key={t.id} label={t.title} meta={t.due_date === todayIso ? 'Today' : fmtDay(t.due_date)} dot="bg-emerald-400" />)}
        </FeatureCard>

        {/* 3. Reminders */}
        <FeatureCard index={3} title="Reminders" href="/dashboard/reminders" icon={BellRing} tint="bg-amber-500/15 text-amber-400" count={reminderCount ?? 0} countLabel="active reminders">
          {(reminders ?? []).length === 0 ? <EmptyHint>No active reminders.</EmptyHint>
            : (reminders as Rm[]).map((r) => <ListRow key={r.id} label={r.title} meta={r.remind_at ? fmtDay(r.remind_at) : ''} dot="bg-amber-400" />)}
        </FeatureCard>

        {/* 4. Notes */}
        <FeatureCard index={4} title="Notes" href="/dashboard/notes" icon={StickyNote} tint="bg-violet-500/15 text-violet-400" count={noteCount ?? 0} countLabel="notes">
          {(notes ?? []).length === 0 ? <EmptyHint>No notes yet.</EmptyHint>
            : (notes as Nt[]).map((n) => <ListRow key={n.id} label={(n.title ?? n.body ?? 'Untitled').slice(0, 60)} meta={fmtDay(n.updated_at)} dot="bg-violet-400" />)}
        </FeatureCard>

        {/* 5. Documents */}
        <FeatureCard index={5} title="Documents" href="/dashboard/documents" icon={FolderLock} tint="bg-sky-500/15 text-sky-400" count={docCount ?? 0} countLabel="documents">
          {(docs ?? []).length === 0 ? <EmptyHint>No documents yet.</EmptyHint>
            : (docs as Dc[]).map((d) => <ListRow key={d.id} label={d.title} meta={d.category ?? ''} dot="bg-sky-400" />)}
        </FeatureCard>

        {/* 6. Contacts */}
        <FeatureCard index={6} title="Contacts" href="/dashboard/contacts" icon={ContactIcon} tint="bg-rose-500/15 text-rose-400" count={contactCount ?? 0} countLabel="contacts">
          {(contacts ?? []).length === 0 ? <EmptyHint>No contacts yet.</EmptyHint>
            : (contacts as Ct[]).map((c) => <ListRow key={c.id} label={c.name} meta={c.relationship ?? ''} dot="bg-rose-400" />)}
        </FeatureCard>

        {/* 7. Milestones */}
        <FeatureCard index={7} title="Milestones" href="/dashboard/celebrations" icon={Award} tint="bg-fuchsia-500/15 text-fuchsia-400" count={milestoneCount ?? 0} countLabel="upcoming milestones">
          {(milestones ?? []).length === 0 ? <EmptyHint>No upcoming milestones.</EmptyHint>
            : (milestones as Ms[]).map((m) => <ListRow key={m.id} label={m.title} meta={fmtDay(m.milestone_date)} dot="bg-fuchsia-400" />)}
        </FeatureCard>

        {/* 8. Family Wall */}
        <FeatureCard index={8} title="Family Wall" href="/dashboard/social-feed" icon={Newspaper} tint="bg-indigo-500/15 text-indigo-400" count={photoCount ?? 0} countLabel="shared moments">
          {(photos ?? []).length === 0 ? <EmptyHint>No posts yet.</EmptyHint>
            : (
              <div className="grid grid-cols-4 gap-1.5">
                {(photos as Ph[]).map((p) => {
                  const src = p.thumbnail_url || p.url;
                  return (
                    <span key={p.id} className="relative aspect-square overflow-hidden rounded-lg bg-elevated">
                      {src ? <Image src={src} alt="Family moment" fill sizes="96px" className="object-cover" /> : <span className="grid h-full w-full place-items-center text-muted"><ImageIcon className="h-4 w-4" /></span>}
                    </span>
                  );
                })}
              </div>
            )}
        </FeatureCard>
      </div>
    </div>
  );
}
