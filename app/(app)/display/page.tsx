import type { Metadata } from 'next';
import Link from 'next/link';
import { X } from 'lucide-react';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { AutoRefresh } from '@/components/display/auto-refresh';
import { DisplayGrid, DEFAULT_TILES, type DisplayData, type Tile } from '@/components/display/display-grid';

export const metadata: Metadata = { title: 'Kitchen Display', robots: { index: false } };
export const dynamic = 'force-dynamic';

// Kitchen Display Mode is a Family Basic feature. Fully customizable grid of
// widgets, with the layout persisted per-family in `display_layouts`.
export default async function KitchenDisplayPage() {
  const ctx = await requirePlanLevel(1);
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const in14 = new Date(start); in14.setDate(in14.getDate() + 14);
  const todayDate = start.toISOString().slice(0, 10);

  // Month bounds for the calendar widget.
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const [
    { data: members },
    { data: events },
    { data: upcoming },
    { data: chores },
    { data: mealRows },
    { data: groceryItems },
    { count: groceryCount },
    { data: reminders },
    { data: notes },
    { data: featuredRecipe },
    { data: monthEvents },
    { data: layoutRow },
  ] = await Promise.all([
    supabase.from('family_members').select('*').eq('family_id', familyId).eq('is_active', true).order('created_at'),
    supabase.from('calendar_events').select('id, title, starts_at, all_day, location, assignee_id')
      .eq('family_id', familyId).gte('starts_at', start.toISOString()).lt('starts_at', end.toISOString()).order('starts_at'),
    supabase.from('calendar_events').select('id, title, starts_at, all_day, location, assignee_id')
      .eq('family_id', familyId).gte('starts_at', end.toISOString()).lt('starts_at', in14.toISOString()).order('starts_at').limit(12),
    supabase.from('chore_assignments').select('id, status, member_id, chore_id, due_at')
      .eq('family_id', familyId).in('status', ['todo', 'in_progress', 'submitted'])
      .lte('due_at', end.toISOString()).order('due_at'),
    supabase.from('meal_plans').select('meal_type, meal_id').eq('family_id', familyId).eq('plan_date', todayDate),
    supabase.from('grocery_items').select('id, name').eq('family_id', familyId).eq('is_checked', false).order('created_at').limit(8),
    supabase.from('grocery_items').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('is_checked', false),
    supabase.from('reminders').select('id, title, remind_at').eq('family_id', familyId).eq('is_done', false)
      .lte('remind_at', in14.toISOString()).order('remind_at').limit(10),
    supabase.from('notes').select('id, title, body').eq('family_id', familyId).eq('is_pinned', true).order('updated_at', { ascending: false }).limit(6),
    supabase.from('family_recipes').select('name, category, photo_url').eq('family_id', familyId)
      .order('is_favorite', { ascending: false }).order('last_made_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
    supabase.from('calendar_events').select('starts_at')
      .eq('family_id', familyId).gte('starts_at', monthStart.toISOString()).lt('starts_at', monthEnd.toISOString()),
    supabase.from('display_layouts').select('tiles').eq('family_id', familyId).maybeSingle(),
  ]);

  const memberById = new Map((members ?? []).map((m) => [m.id, m]));

  // Resolve chore titles + today's meal names (no embedded joins in types).
  const choreIds = [...new Set((chores ?? []).map((c) => c.chore_id))];
  const mealIds = [...new Set((mealRows ?? []).map((m) => m.meal_id).filter(Boolean) as string[])];
  const [{ data: choreRows }, { data: meals }] = await Promise.all([
    choreIds.length ? supabase.from('chores').select('id, title').in('id', choreIds) : Promise.resolve({ data: [] as { id: string; title: string }[] }),
    mealIds.length ? supabase.from('meals').select('id, name').in('id', mealIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);
  const choreTitle = new Map((choreRows ?? []).map((c) => [c.id, c.title]));
  const mealName = new Map((meals ?? []).map((m) => [m.id, m.name]));

  const todaysMeals = (mealRows ?? [])
    .map((m) => ({ type: m.meal_type as string, name: m.meal_id ? mealName.get(m.meal_id) ?? null : null }))
    .filter((m): m is { type: string; name: string } => Boolean(m.name));

  // Birthdays in the next two weeks (month-day comparison, handles year wrap).
  const mmddToday = todayDate.slice(5);
  const mmddEnd = in14.toISOString().slice(5, 10);
  const birthdays = (members ?? [])
    .filter((m) => {
      if (!m.birthday) return false;
      const bd = m.birthday.slice(5);
      return mmddEnd >= mmddToday ? bd >= mmddToday && bd <= mmddEnd : bd >= mmddToday || bd <= mmddEnd;
    })
    .map((m) => ({
      name: m.display_name,
      date: new Date(`2000-${m.birthday!.slice(5)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    }));

  const eventDays = [...new Set((monthEvents ?? []).map((e) => new Date(e.starts_at).getDate()))];

  const data: DisplayData = {
    familyName: ctx.active.family.name,
    members: (members ?? []).map((m) => ({ id: m.id, display_name: m.display_name, color: m.color, role: m.role })),
    events: events ?? [],
    upcoming: upcoming ?? [],
    chores: (chores ?? []).map((c) => ({ id: c.id, status: c.status, member_id: c.member_id, title: choreTitle.get(c.chore_id) ?? 'Chore' })),
    meals: todaysMeals,
    grocery: { items: groceryItems ?? [], count: groceryCount ?? 0 },
    reminders: reminders ?? [],
    birthdays,
    notes: (notes ?? []).map((n) => ({ id: n.id, title: n.title, body: n.body })),
    featured: featuredRecipe ? { name: featuredRecipe.name, category: featuredRecipe.category, imageUrl: featuredRecipe.photo_url } : null,
    calendar: { year: now.getFullYear(), month: now.getMonth(), today: now.getDate(), eventDays },
  };

  const savedTiles = (layoutRow?.tiles as Tile[] | null) ?? null;
  const initialTiles = savedTiles && savedTiles.length ? savedTiles : DEFAULT_TILES;

  return (
    <div className="min-h-dvh bg-bg p-6 text-fg lg:p-10">
      <AutoRefresh seconds={120} />

      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-brand">FamilyOS</p>
          <h1 className="mt-1 text-4xl font-black lg:text-5xl">{ctx.active.family.name}</h1>
        </div>
        <Link href="/dashboard" title="Exit display" className="grid h-10 w-10 place-items-center rounded-full border border-border text-muted transition hover:text-fg">
          <X className="h-5 w-5" />
        </Link>
      </header>

      <DisplayGrid initialTiles={initialTiles} data={data} familyId={familyId} userId={ctx.user.id} />
    </div>
  );
}
