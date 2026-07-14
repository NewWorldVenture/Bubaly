import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { AutoRefresh } from '@/components/display/auto-refresh';
import {
  DisplayShell, DEFAULT_TILES, resolveDisplaySettings,
  type DisplayData, type Tile,
} from '@/components/display/display-grid';
import type { DisplaySettings } from '@/lib/display/ambient';

export const metadata: Metadata = { title: 'Kitchen Display', robots: { index: false } };
export const dynamic = 'force-dynamic';

type LoadedDisplay = { data: DisplayData; initialTiles: Tile[]; initialSettings: DisplaySettings };

/** A complete, renderable DisplayData with no rows — the always-safe fallback. */
function emptyDisplay(familyName: string, now: Date): DisplayData {
  return {
    familyName,
    members: [], events: [], upcoming: [], chores: [], meals: [],
    grocery: { items: [], count: 0 }, reminders: [], birthdays: [],
    notes: [], featured: [], photos: [],
    calendar: { year: now.getFullYear(), month: now.getMonth(), today: now.getDate(), eventDays: [] },
  };
}

// Kitchen Display Mode is a Family Basic feature. Fully customizable grid of
// widgets, with the layout persisted per-family in `display_layouts`.
//
// This is an always-on kiosk surface: it must NEVER hard-crash into the error
// boundary. Every read is best-effort — a single failing query (a table missing
// on an un-migrated environment, an RLS edge, a transient outage) degrades that
// one widget to empty rather than taking down the whole screen. All data loading
// is wrapped so the page always renders, and query errors are logged for triage.
async function loadDisplay(
  supabase: Awaited<ReturnType<typeof createServer>>,
  familyId: string,
  familyName: string,
  now: Date,
): Promise<LoadedDisplay> {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const in14 = new Date(start); in14.setDate(in14.getDate() + 14);
  const todayDate = start.toISOString().slice(0, 10);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const results = await Promise.all([
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
      .order('is_favorite', { ascending: false }).order('last_made_at', { ascending: false, nullsFirst: false }).limit(6),
    supabase.from('calendar_events').select('starts_at')
      .eq('family_id', familyId).gte('starts_at', monthStart.toISOString()).lt('starts_at', monthEnd.toISOString()),
    supabase.from('display_layouts').select('tiles, settings').eq('family_id', familyId).maybeSingle(),
    supabase.from('family_photos').select('url, thumbnail_url')
      .eq('family_id', familyId).not('url', 'is', null)
      .order('taken_at', { ascending: false, nullsFirst: false }).limit(24),
  ]);

  // Best-effort: log any per-query error so a partial outage is diagnosable in
  // prod logs, but never let one failing widget crash the kiosk.
  const labels = [
    'members', 'events', 'upcoming', 'chores', 'mealPlans', 'grocery', 'groceryCount',
    'reminders', 'notes', 'recipes', 'monthEvents', 'layout', 'photos',
  ] as const;
  results.forEach((r, i) => {
    if (r.error) console.error(`[display] query "${labels[i]}" failed:`, r.error.message);
  });

  const [
    { data: members }, { data: events }, { data: upcoming }, { data: chores },
    { data: mealRows }, { data: groceryItems }, { count: groceryCount },
    { data: reminders }, { data: notes }, { data: featuredRecipe },
    { data: monthEvents }, { data: layoutRow }, { data: photoRows },
  ] = results;

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
      const mmdd = birthdayMonthDay(m.birthday);
      if (!mmdd) return false;
      return mmddEnd >= mmddToday ? mmdd >= mmddToday && mmdd <= mmddEnd : mmdd >= mmddToday || mmdd <= mmddEnd;
    })
    .map((m) => ({ name: m.display_name, date: formatBirthday(birthdayMonthDay(m.birthday)!) }));

  const eventDays = [...new Set((monthEvents ?? [])
    .map((e) => new Date(e.starts_at).getDate())
    .filter((d) => Number.isFinite(d)))];

  const data: DisplayData = {
    familyName,
    members: (members ?? []).map((m) => ({ id: m.id, display_name: m.display_name, color: m.color, role: m.role })),
    events: events ?? [],
    upcoming: upcoming ?? [],
    chores: (chores ?? []).map((c) => ({ id: c.id, status: c.status, member_id: c.member_id, title: choreTitle.get(c.chore_id) ?? 'Chore' })),
    meals: todaysMeals,
    grocery: { items: groceryItems ?? [], count: groceryCount ?? 0 },
    reminders: reminders ?? [],
    birthdays,
    notes: (notes ?? []).map((n) => ({ id: n.id, title: n.title, body: n.body })),
    featured: (featuredRecipe ?? []).map((r) => ({ name: r.name, category: r.category, imageUrl: r.photo_url })),
    // Photo ambience: family photos first, recipe photos as a fallback so the
    // photo background/frame works even before the family uploads pictures.
    photos: [
      ...(photoRows ?? []).map((p) => p.url).filter((u): u is string => Boolean(u)),
      ...(featuredRecipe ?? []).map((r) => r.photo_url).filter((u): u is string => Boolean(u)),
    ].slice(0, 24),
    calendar: { year: now.getFullYear(), month: now.getMonth(), today: now.getDate(), eventDays },
  };

  const savedTiles = (layoutRow?.tiles as Tile[] | null) ?? null;
  const initialTiles = Array.isArray(savedTiles) && savedTiles.length ? savedTiles : DEFAULT_TILES;
  const initialSettings = resolveDisplaySettings(layoutRow?.settings ?? null);

  return { data, initialTiles, initialSettings };
}

/** Normalize a stored birthday (date, ISO timestamp, or MM-DD) to "MM-DD", or null. */
function birthdayMonthDay(raw: string | null): string | null {
  if (!raw) return null;
  // Accept "YYYY-MM-DD", full ISO timestamps, or a bare "MM-DD".
  const m = raw.match(/(?:^|\D)(\d{2})-(\d{2})(?=\D|$)/);
  if (m) {
    const mm = m[1], dd = m[2];
    // Guard against catching a "YYYY-MM" tail: require the pair to be a real month/day.
    if (Number(mm) >= 1 && Number(mm) <= 12 && Number(dd) >= 1 && Number(dd) <= 31) return `${mm}-${dd}`;
  }
  const iso = raw.match(/^\d{4}-(\d{2})-(\d{2})/);
  return iso ? `${iso[1]}-${iso[2]}` : null;
}

/** "05-15" → "May 15" (safe; returns "" on a malformed pair). */
function formatBirthday(mmdd: string): string {
  const d = new Date(`2000-${mmdd}T00:00:00`);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '';
}

export default async function KitchenDisplayPage() {
  // requireFeature may redirect()/notFound() — that control flow must propagate,
  // so it stays outside the resilient loader.
  const ctx = await requireFeature('/display');
  const familyId = ctx.active.familyId;
  const familyName = ctx.active.family.name;
  const now = new Date();

  let loaded: LoadedDisplay;
  try {
    const supabase = await createServer();
    loaded = await loadDisplay(supabase, familyId, familyName, now);
  } catch (err) {
    // Absolute backstop: the kiosk still renders a clean, empty display rather
    // than crashing into the app error boundary.
    console.error('[display] fatal load error, rendering empty display:', err);
    loaded = {
      data: emptyDisplay(familyName, now),
      initialTiles: DEFAULT_TILES,
      initialSettings: resolveDisplaySettings(null),
    };
  }

  return (
    <>
      <AutoRefresh seconds={120} />
      <DisplayShell
        initialTiles={loaded.initialTiles}
        initialSettings={loaded.initialSettings}
        data={loaded.data}
        familyId={familyId}
        userId={ctx.user.id}
      />
    </>
  );
}
