import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { unstable_rethrow } from 'next/navigation';
import { requireFeature } from '@/lib/supabase/auth';
import { settle } from '@/lib/supabase/settle';
import { runPagePath } from '@/lib/ai/chat-request';
import { createServer } from '@/lib/supabase/server';
import { AutoRefresh } from '@/components/display/auto-refresh';
// ⚠️ RSC boundary rule (this WAS the kiosk's persistent crash): display-grid.tsx
// is a 'use client' module, so every value imported from it here — even a
// re-export of a pure helper — arrives as a client-reference proxy, and CALLING
// one throws on every request ("it's not possible to call a client function
// from the server"). The first throw was caught, but the catch block called
// another poisoned helper and THAT throw escaped to the error boundary as an
// opaque digest. Server code must import these from the pure libs directly;
// only type-only imports (erased at compile) and rendered components may come
// from client modules. Guarded by tests/display-server-safety.test.ts.
import { DEFAULT_TILES, resolveTiles, type Tile } from '@/lib/display/tiles';
import { normalizeSettings, type DisplaySettings } from '@/lib/display/ambient';
import { displayCalendarFilter, displayEventDays, displayReminderTime, eventOverlapsWindow, familyDisplayCalendar } from '@/lib/display/calendar';
import type { DisplayData } from '@/components/display/display-grid';
import type { HandledToday } from '@/components/display/handled-today-tile';
import { DisplayShellClient } from '@/components/display/display-shell-client';

export const metadata: Metadata = { title: 'Kitchen Display', robots: { index: false } };
export const dynamic = 'force-dynamic';

type LoadedDisplay = { data: DisplayData; initialTiles: Tile[]; initialSettings: DisplaySettings };

/** A complete, renderable DisplayData with no rows — the always-safe fallback. */
function emptyDisplay(familyName: string, now: Date, timezone: unknown): DisplayData {
  const calendar = familyDisplayCalendar(now, timezone);
  return {
    familyName,
    timezone: calendar.timezone, dayKey: calendar.dayKey, timezoneFallback: calendar.timezoneFallback,
    loadStatus: { events: 'error', upcoming: 'error', monthEvents: 'error', reminders: 'error' },
    members: [], events: [], upcoming: [], chores: [], meals: [],
    grocery: { items: [], count: 0 }, reminders: [], birthdays: [],
    notes: [], featured: [], photos: [],
    // `handled` is deliberately LEFT OUT here: this fallback is reached when the
    // load failed, and an unread ledger must render the tile's error state, not
    // a "0 things handled today" the screen cannot stand behind.

    calendar: { year: calendar.year, month: calendar.month, today: calendar.today, eventDays: [] },
  };
}

/** How many finished runs the tile lists under its count. */
const HANDLED_TILE_ITEMS = 3;

/**
 * "Bubaly handled today" — the count and the last three, from the ledger.
 *
 * COMPLETED runs only. `partially_completed` is a real and useful state, but
 * this tile is a headline number on a kitchen wall with nobody standing at it,
 * and "8 things handled" has to mean eight things that finished. The Handled
 * ledger on Home is where a partial run is shown honestly as partial.
 *
 * Unlike every other read on this page, this one FAILS CLOSED: a count is a
 * claim, and a claim behind a failed read is a lie the screen tells all day.
 * The tile renders "Bubaly could not read what it finished · Retry" instead —
 * never 0.
 */
async function loadHandledToday(
  supabase: Awaited<ReturnType<typeof createServer>>,
  familyId: string,
  start: Date,
  end: Date,
  untitledRun: string,
): Promise<HandledToday> {
  const [rowsRes, countRes] = await Promise.all([
    settle(supabase.from('family_automation_runs')
      .select('id, summary, completed_at')
      .eq('family_id', familyId)
      .eq('state', 'completed')
      .gte('completed_at', start.toISOString())
      .lt('completed_at', end.toISOString())
      .order('completed_at', { ascending: false })
      .limit(HANDLED_TILE_ITEMS)),
    settle(supabase.from('family_automation_runs')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', familyId)
      .eq('state', 'completed')
      .gte('completed_at', start.toISOString())
      .lt('completed_at', end.toISOString())),
  ]);

  const readError = rowsRes.error ?? countRes.error;
  // A null count with no error is still a number nobody can stand behind
  // (countOrNull's rule), so it fails closed exactly like an error does.
  if (readError || typeof countRes.count !== 'number') {
    console.error('[display] handled today read failed', readError);
    return { status: 'error' };
  }

  const rows = (rowsRes.data ?? []) as { id: string; summary: string | null; completed_at: string | null }[];
  return {
    status: 'ok',
    count: countRes.count,
    items: rows.map((run) => ({
      key: `run:${run.id}`,
      title: run.summary?.trim() || untitledRun,
      href: runPagePath(run.id),
      at: run.completed_at ?? start.toISOString(),
    })),
  };
}

// Kitchen Display Mode is a Family Basic feature. Fully customizable grid of
// widgets, with the layout persisted per-family in `display_layouts`.
//
// This is an always-on kiosk surface: it must NEVER hard-crash into the error
// boundary. Every read is best-effort — a single failing query (a table missing
// on an un-migrated environment, an RLS edge, a transient outage) degrades that
// one widget to unavailable rather than taking down the whole screen. Calendar
// and reminder reads carry independent status; errors must never imply free time.
async function loadDisplay(
  supabase: Awaited<ReturnType<typeof createServer>>,
  familyId: string,
  familyName: string,
  now: Date,
  timezone: unknown,
  untitledRun: string,
): Promise<LoadedDisplay> {
  const calendar = familyDisplayCalendar(now, timezone);
  const { start, end } = calendar.todayWindow;
  const in14 = calendar.upcomingWindow.end;
  const todayDate = calendar.dayKey;

  const results = await Promise.all([
    settle(supabase.from('family_members').select('*').eq('family_id', familyId).eq('is_active', true).order('created_at')),
    settle(supabase.from('calendar_events').select('id, title, starts_at, ends_at, all_day, location, assignee_id')
      .eq('family_id', familyId).or(displayCalendarFilter(calendar.todayWindow)).order('starts_at')),
    settle(supabase.from('calendar_events').select('id, title, starts_at, ends_at, all_day, location, assignee_id')
      .eq('family_id', familyId).or(displayCalendarFilter(calendar.upcomingWindow)).order('starts_at').limit(12)),
    settle(supabase.from('chore_assignments').select('id, status, member_id, chore_id, due_at')
      .eq('family_id', familyId).in('status', ['todo', 'in_progress', 'submitted'])
      .lt('due_at', end.toISOString()).order('due_at')),
    settle(supabase.from('meal_plans').select('meal_type, meal_id').eq('family_id', familyId).eq('plan_date', todayDate)),
    settle(supabase.from('grocery_items').select('id, name').eq('family_id', familyId).eq('is_checked', false).order('created_at').limit(8)),
    settle(supabase.from('grocery_items').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('is_checked', false)),
    settle(supabase.from('family_reminders').select('id, title, remind_at, status, snoozed_until')
      .eq('family_id', familyId).in('status', ['active', 'snoozed']).not('remind_at', 'is', null)
      .lt('remind_at', in14.toISOString()).order('remind_at')),
    settle(supabase.from('notes').select('id, title, body').eq('family_id', familyId).eq('is_pinned', true).order('updated_at', { ascending: false }).limit(6)),
    settle(supabase.from('family_recipes').select('name, category, photo_url').eq('family_id', familyId)
      .order('is_favorite', { ascending: false }).order('last_made_at', { ascending: false, nullsFirst: false }).limit(6)),
    settle(supabase.from('calendar_events').select('starts_at, ends_at, all_day')
      .eq('family_id', familyId).or(displayCalendarFilter(calendar.monthWindow))),
    settle(supabase.from('display_layouts').select('tiles, settings').eq('family_id', familyId).maybeSingle()),
    settle(supabase.from('family_photos').select('url, thumbnail_url')
      .eq('family_id', familyId).not('url', 'is', null)
      .order('taken_at', { ascending: false, nullsFirst: false }).limit(24)),
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
  // Started AFTER the batch above and awaited immediately, so no promise is in
  // flight across an array literal where a throw could orphan it (§3).
  const handled = await loadHandledToday(supabase, familyId, start, end, untitledRun);

  const choreTitle = new Map((choreRows ?? []).map((c) => [c.id, c.title]));
  const mealName = new Map((meals ?? []).map((m) => [m.id, m.name]));

  const todaysMeals = (mealRows ?? [])
    .map((m) => ({ type: m.meal_type as string, name: m.meal_id ? mealName.get(m.meal_id) ?? null : null }))
    .filter((m): m is { type: string; name: string } => Boolean(m.name));

  // Birthdays in the next two weeks (month-day comparison, handles year wrap).
  const mmddToday = todayDate.slice(5);
  const mmddEnd = calendar.upcomingWindow.endDay.slice(5);
  const birthdays = (members ?? [])
    .filter((m) => {
      const mmdd = birthdayMonthDay(m.birthday);
      if (!mmdd) return false;
      return mmddEnd >= mmddToday ? mmdd >= mmddToday && mmdd < mmddEnd : mmdd >= mmddToday || mmdd < mmddEnd;
    })
    .map((m) => ({ name: m.display_name ?? 'Member', date: formatBirthday(birthdayMonthDay(m.birthday)!) }));

  const eventDays = displayEventDays(monthEvents ?? [], calendar.monthWindow, calendar.timezone);
  const displayReminders = (reminders ?? []).map(row => ({ id: row.id, title: row.title, remind_at: displayReminderTime(row) }))
    .filter((row): row is { id: string; title: string; remind_at: string } => !!row.remind_at && Date.parse(row.remind_at) < in14.getTime())
    .sort((a, b) => a.remind_at.localeCompare(b.remind_at)).slice(0, 10);

  const data: DisplayData = {
    familyName,
    timezone: calendar.timezone, dayKey: calendar.dayKey, timezoneFallback: calendar.timezoneFallback,
    loadStatus: {
      events: results[1].error ? 'error' : 'ok', upcoming: results[2].error ? 'error' : 'ok',
      monthEvents: results[10].error ? 'error' : 'ok', reminders: results[7].error ? 'error' : 'ok',
    },
    members: (members ?? []).map((m) => ({ id: m.id, display_name: m.display_name ?? 'Member', color: m.color, role: m.role })),
    events: (events ?? []).filter(event => eventOverlapsWindow(event, calendar.todayWindow)),
    upcoming: (upcoming ?? []).filter(event => eventOverlapsWindow(event, calendar.upcomingWindow)),
    chores: (chores ?? []).map((c) => ({ id: c.id, status: c.status, member_id: c.member_id, title: choreTitle.get(c.chore_id) ?? 'Chore' })),
    meals: todaysMeals,
    grocery: { items: groceryItems ?? [], count: groceryCount ?? 0 },
    reminders: displayReminders,
    birthdays,
    notes: (notes ?? []).map((n) => ({ id: n.id, title: n.title, body: n.body })),
    featured: (featuredRecipe ?? []).map((r) => ({ name: r.name, category: r.category, imageUrl: r.photo_url })),
    // Photo ambience: family photos first, recipe photos as a fallback so the
    // photo background/frame works even before the family uploads pictures.
    photos: [
      ...(photoRows ?? []).map((p) => p.url).filter((u): u is string => Boolean(u)),
      ...(featuredRecipe ?? []).map((r) => r.photo_url).filter((u): u is string => Boolean(u)),
    ].slice(0, 24),
    calendar: { year: calendar.year, month: calendar.month, today: calendar.today, eventDays },
    handled,
  };

  // The stored layout is untrusted jsonb: a single malformed element (e.g. a
  // literal null from a historical sparse-array save) used to crash the whole
  // page during SSR — where widget boundaries can't catch. Normalize BOTH blobs.
  const initialTiles = resolveTiles(layoutRow?.tiles ?? null);
  const initialSettings = normalizeSettings(layoutRow?.settings ?? null);

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

/**
 * Kiosk reconnect screen: rendered instead of throwing when the account-context
 * queries hit a transient failure (getUserContext deliberately throws on those —
 * fine for interactive pages, fatal for a wall display that refreshes every two
 * minutes with nobody at the keyboard). AutoRefresh re-runs the page server-side
 * until the context resolves again. The display/error.tsx boundary remains the
 * backstop for anything unforeseen.
 */
async function DisplayReconnect() {
  const t = await getTranslations();
  return (
    <>
      <AutoRefresh seconds={15} />
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-[#0b1020] p-8 text-center text-white">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-30">
          <div className="absolute -left-24 top-10 h-72 w-72 rounded-full bg-violet-600/50 blur-3xl" />
          <div className="absolute -right-16 bottom-0 h-80 w-80 rounded-full bg-blue-600/40 blur-3xl" />
        </div>
        <div className="relative">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-white/40">{t('display.bubalyKitchen')}</p>
          <h1 className="mt-3 text-3xl font-black sm:text-4xl">{t('display.oneMoment')}</h1>
          <p className="mx-auto mt-3 max-w-sm text-sm text-white/55">{t('display.reconnectingToYourFamilySpace')}</p>
        </div>
      </div>
    </>
  );
}

export default async function KitchenDisplayPage() {
  // requireFeature may redirect()/notFound() — that control flow MUST propagate
  // (unstable_rethrow re-raises Next's internal signals). A genuine transient
  // error (e.g. a blipped context query) renders the self-refreshing reconnect
  // screen instead of hard-crashing the kiosk into the error boundary.
  let ctx: Awaited<ReturnType<typeof requireFeature>>;
  try {
    ctx = await requireFeature('/display');
  } catch (err) {
    unstable_rethrow(err);
    console.error('[display] context unavailable, rendering reconnect screen:', err);
    return <DisplayReconnect />;
  }
  const t = await getTranslations();
  const familyId = ctx.active.familyId;
  const familyName = ctx.active.family.name;
  const now = new Date();

  let loaded: LoadedDisplay;
  try {
    const supabase = await createServer();
    loaded = await loadDisplay(supabase, familyId, familyName, now, ctx.active.family.timezone, t('displayHandled.untitledRun'));
    // Serialization firewall: these props cross the server→client boundary
    // AFTER this function returns, so a single non-JSON value anywhere in the
    // rows (a BigInt from a numeric column, a circular ref) throws OUTSIDE any
    // try/catch and crashes the kiosk as an opaque digest. Round-tripping here
    // (a) moves that failure INSIDE the guard and (b) strips any poison, so
    // the props handed to the client are guaranteed serializable.
    loaded = JSON.parse(JSON.stringify(loaded)) as LoadedDisplay;
  } catch (err) {
    // Absolute backstop: the kiosk still renders a clean, empty display rather
    // than crashing into the app error boundary.
    console.error('[display] fatal load error, rendering empty display:', err);
    loaded = {
      data: emptyDisplay(familyName, now, ctx.active.family.timezone),
      initialTiles: DEFAULT_TILES,
      initialSettings: normalizeSettings(null),
    };
  }

  return (
    <>
      <AutoRefresh seconds={120} />
      {/* Client-only: SSR throws bypass every widget boundary (boundaries don't
          run server-side) — in the browser, a bad widget degrades to "—" instead
          of taking the kiosk down, and real error messages replace digests. */}
      <DisplayShellClient
        initialTiles={loaded.initialTiles}
        initialSettings={loaded.initialSettings}
        data={loaded.data}
        familyId={familyId}
        userId={ctx.user.id}
      />
    </>
  );
}
