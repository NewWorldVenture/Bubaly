import type { Metadata } from 'next';
import Link from 'next/link';
import { Calendar, CheckCircle2, ShoppingCart, UtensilsCrossed, Cake, X } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Avatar } from '@/components/ui/avatar';
import { fmtTime } from '@/lib/utils/format';
import { DisplayClock } from '@/components/display/display-clock';
import { AutoRefresh } from '@/components/display/auto-refresh';

export const metadata: Metadata = { title: 'Kitchen Display', robots: { index: false } };
export const dynamic = 'force-dynamic';

const MEAL_EMOJIS: Record<string, string> = { breakfast: '🍳', lunch: '🥗', dinner: '🍽️', snack: '🍎' };

export default async function KitchenDisplayPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const in7 = new Date(start); in7.setDate(in7.getDate() + 7);
  const todayDate = start.toISOString().slice(0, 10);

  const [
    { data: members },
    { data: events },
    { data: chores },
    { data: mealRows },
    { count: groceryCount },
  ] = await Promise.all([
    supabase.from('family_members').select('*').eq('family_id', familyId).eq('is_active', true).order('created_at'),
    supabase.from('calendar_events').select('id, title, starts_at, all_day, location, assignee_id')
      .eq('family_id', familyId).gte('starts_at', start.toISOString()).lt('starts_at', end.toISOString()).order('starts_at'),
    supabase.from('chore_assignments').select('id, status, member_id, chore_id, due_at')
      .eq('family_id', familyId).in('status', ['todo', 'in_progress', 'submitted'])
      .lte('due_at', end.toISOString()).order('due_at'),
    supabase.from('meal_plans').select('meal_type, meal_id').eq('family_id', familyId).eq('plan_date', todayDate),
    supabase.from('grocery_items').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('is_checked', false),
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
    .map((m) => ({ type: m.meal_type, name: m.meal_id ? mealName.get(m.meal_id) ?? null : null }))
    .filter((m) => m.name);

  const birthdays = (members ?? []).filter((m) => {
    if (!m.birthday) return false;
    const bd = m.birthday.slice(5);
    return bd >= todayDate.slice(5) && bd <= in7.toISOString().slice(5, 10);
  });

  return (
    <div className="theme-dark-island min-h-dvh bg-[#050c15] p-6 text-white lg:p-10">
      <AutoRefresh seconds={60} />

      {/* Header */}
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-brand">FamilyOS</p>
          <h1 className="mt-1 text-4xl font-black lg:text-5xl">{ctx.active.family.name}</h1>
          <div className="mt-3 flex -space-x-2">
            {(members ?? []).slice(0, 8).map((m) => (
              <Avatar key={m.id} name={m.display_name} color={m.color} size={36} className="ring-2 ring-[#050c15]" />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <DisplayClock />
          <Link href="/dashboard" title="Exit display" className="grid h-10 w-10 place-items-center rounded-full border border-white/15 text-white/50 transition hover:text-white">
            <X className="h-5 w-5" />
          </Link>
        </div>
      </header>

      {birthdays.length > 0 && (
        <div className="mt-6 flex items-center gap-3 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-5 py-3 text-lg font-semibold text-rose-200">
          <Cake className="h-6 w-6" />
          {birthdays.map((b) => `${b.display_name}'s birthday`).join(' · ')} coming up this week!
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Today's schedule — wide */}
        <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 lg:col-span-2">
          <div className="mb-5 flex items-center gap-3">
            <Calendar className="h-7 w-7 text-violet-300" />
            <h2 className="text-2xl font-bold">Today&apos;s Schedule</h2>
          </div>
          {events && events.length > 0 ? (
            <ul className="space-y-3">
              {events.map((e) => {
                const who = e.assignee_id ? memberById.get(e.assignee_id) : undefined;
                return (
                  <li key={e.id} className="flex items-center gap-4 rounded-2xl bg-white/[0.04] px-5 py-4">
                    <span className="w-24 shrink-0 text-xl font-bold tabular-nums text-violet-200">
                      {e.all_day ? 'All day' : fmtTime(e.starts_at)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xl font-semibold">{e.title}</p>
                      {e.location && <p className="truncate text-sm text-white/50">{e.location}</p>}
                    </div>
                    {who && <Avatar name={who.display_name} color={who.color} size={40} />}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Calendar className="h-12 w-12 text-white/15" />
              <p className="mt-3 text-xl text-white/40">Nothing scheduled today</p>
            </div>
          )}
        </section>

        {/* Right column */}
        <div className="space-y-6">
          {/* Chores today */}
          <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-6">
            <div className="mb-4 flex items-center gap-3">
              <CheckCircle2 className="h-6 w-6 text-emerald-300" />
              <h2 className="text-xl font-bold">Chores Today</h2>
            </div>
            {chores && chores.length > 0 ? (
              <ul className="space-y-2.5">
                {chores.slice(0, 6).map((c) => {
                  const who = memberById.get(c.member_id);
                  return (
                    <li key={c.id} className="flex items-center gap-3">
                      <span className={`h-3 w-3 shrink-0 rounded-full ${c.status === 'submitted' ? 'bg-amber-400' : 'bg-white/25'}`} />
                      <span className="min-w-0 flex-1 truncate text-lg">{choreTitle.get(c.chore_id) ?? 'Chore'}</span>
                      {who && <span className="shrink-0 text-sm text-white/50">{who.display_name.split(' ')[0]}</span>}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="py-6 text-center text-lg text-white/40">All done! 🎉</p>
            )}
          </section>

          {/* Tonight's meal */}
          <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-6">
            <div className="mb-4 flex items-center gap-3">
              <UtensilsCrossed className="h-6 w-6 text-amber-300" />
              <h2 className="text-xl font-bold">On the Menu</h2>
            </div>
            {todaysMeals.length > 0 ? (
              <ul className="space-y-2">
                {todaysMeals.map((m) => (
                  <li key={m.type} className="flex items-center gap-3 text-lg">
                    <span className="text-2xl">{MEAL_EMOJIS[m.type] ?? '🍽️'}</span>
                    <span className="capitalize text-white/50">{m.type}:</span>
                    <span className="font-semibold">{m.name}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-4 text-center text-lg text-white/40">No meals planned</p>
            )}
          </section>

          {/* Grocery count */}
          <section className="flex items-center gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-6">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-blue-500/15">
              <ShoppingCart className="h-7 w-7 text-blue-300" />
            </div>
            <div>
              <p className="text-3xl font-black">{groceryCount ?? 0}</p>
              <p className="text-white/50">items on the grocery list</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
