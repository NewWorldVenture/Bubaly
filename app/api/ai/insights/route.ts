import { NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveProvider, isAIConfigured, describeAIError } from '@/lib/ai/provider';
import { INSIGHTS, isInsightKind, MANAGER_ONLY_INSIGHTS, type InsightData, type InsightKind } from '@/lib/ai/insights';
import { isManager } from '@/lib/constants/roles';
import { fenceUntrustedBlock, UNTRUSTED_CONTENT_RULE } from '@/lib/ai/safety/untrusted';
import type { SupabaseClient } from '@supabase/supabase-js';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Rows = Record<string, Record<string, unknown>[]>;

/**
 * Per-module "AI Assist". Fetches the family's own rows (RLS-scoped) for the
 * requested `kind`, hands them to the pure prompt registry, and returns the
 * model's grounded answer. Nothing is invented beyond the family's data.
 */
export async function POST(req: Request) {
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  if (!(await isAIConfigured())) {
    return NextResponse.json({ error: 'The AI engine isn’t configured. Add an API key in Admin → AI Engine.' }, { status: 503 });
  }

  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: 'Request body is too large.' }, { status: 400 });
  const body = (boundedBody.value ?? {}) as Record<string, unknown>;
  const kind = body.kind as string;
  if (!isInsightKind(kind)) return NextResponse.json({ error: 'Unknown insight kind' }, { status: 400 });

  // The route had no role check at all: `requireUserContext()` plus RLS was the
  // whole guard, and RLS on medications, family_messages, documents and the
  // finance tables is family-wide. So a child's session could ask a model to
  // summarise the household's prescriptions, private messages and documents —
  // the very areas the trust engine treats as sensitive for their role — and
  // get a helpful answer.
  if (MANAGER_ONLY_INSIGHTS.has(kind) && !isManager(ctx.active.role)) {
    return NextResponse.json({ error: 'That summary is for the adults in this family.' }, { status: 403 });
  }

  const question = typeof body.question === 'string' ? body.question.slice(0, 1000) : undefined;
  const params = { ...(body.params ?? {}), ...(question ? { question } : {}) };

  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-insights:${ctx.user.id}`, { limit: 20 });
  if (!limited.ok) return NextResponse.json(
    { error: 'Too many AI insight requests. Please try again shortly.' },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );
  const familyId = ctx.active.familyId;
  const tz = ctx.active.family.timezone || 'America/New_York';

  const { data: members } = await supabase
    .from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true);

  let rows: Rows = {};
  try {
    rows = await fetchRows(kind, supabase, familyId, params);
  } catch (err) {
    console.error('AI insights data load failed:', err);
    return NextResponse.json({ error: 'Could not load data for this insight.' }, { status: 500 });
  }

  const now = (() => {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date()); }
    catch { return new Date().toISOString(); }
  })();

  const data: InsightData = {
    familyName: ctx.active.family.name ?? 'Your family',
    now,
    members: (members ?? []).map((m) => ({ id: m.id as string, name: m.display_name as string })),
    rows,
    params,
  };

  const def = INSIGHTS[kind];
  try {
    const provider = await resolveProvider();
    const completion = await provider.complete({
      // The rule lives with the fence, and is appended here rather than inside
      // `lib/ai/insights.ts` — that module is imported by a client component,
      // and the fence reaches `node:crypto`.
      system: `${def.system}\n\n${UNTRUSTED_CONTENT_RULE}`,
      // The whole user turn is household rows — titles, notes, message bodies,
      // document names — assembled by the prompt registry. Every one of them is
      // §44 content, so the whole body goes inside one fence rather than
      // threading a fence through thirty `buildUser` functions. The rule that
      // says fenced text is data is in SHARED_RULES, which every kind carries.
      messages: [{ role: 'user', content: fenceUntrustedBlock(`insight_${kind}`, def.buildUser(data), 24_000) }],
      tools: [],
      maxTokens: def.maxTokens,
    });
    const text = completion.text.trim();
    if (!text) return NextResponse.json({ error: 'No suggestions just now. Please try again.' }, { status: 502 });
    return NextResponse.json({ text });
  } catch (err) {
    console.error('AI insights error:', err);
    return NextResponse.json({ error: describeAIError(err).message }, { status: 503 });
  }
}

const eq = (sb: SupabaseClient, table: string, familyId: string) => sb.from(table).select('*').eq('family_id', familyId);

async function fetchRows(kind: InsightKind, sb: SupabaseClient, familyId: string, params: Record<string, unknown>): Promise<Rows> {
  const nowIso = new Date().toISOString();
  const since = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

  switch (kind) {
    case 'chores': {
      const [chores, asg] = await Promise.all([
        eq(sb, 'chores', familyId).eq('is_active', true).limit(40),
        sb.from('chore_assignments').select('*').eq('family_id', familyId).in('status', ['todo', 'in_progress', 'submitted']).limit(60),
      ]);
      return { chores: chores.data ?? [], chore_assignments: asg.data ?? [] };
    }
    case 'closet': {
      const [items, logs] = await Promise.all([
        eq(sb, 'wardrobe_items', familyId).in('status', ['active', 'laundry', 'outgrown']).order('member_id').limit(160),
        eq(sb, 'outfit_logs', familyId).gte('worn_on', since(30).slice(0, 10)).order('worn_on', { ascending: false }).limit(60),
      ]);
      return { wardrobe_items: items.data ?? [], outfit_logs: logs.data ?? [] };
    }
    case 'watchlist': {
      const [titles, votes, sessions] = await Promise.all([
        eq(sb, 'watchlist_titles', familyId).in('status', ['want', 'watching']).order('priority').limit(120),
        eq(sb, 'watchlist_votes', familyId).limit(300),
        eq(sb, 'watch_sessions', familyId).order('watched_on', { ascending: false }).limit(30),
      ]);
      return { watchlist_titles: titles.data ?? [], watchlist_votes: votes.data ?? [], watch_sessions: sessions.data ?? [] };
    }
    case 'inventory': {
      const [locations, items, moves] = await Promise.all([
        eq(sb, 'home_locations', familyId).limit(200),
        eq(sb, 'inventory_items', familyId).neq('status', 'disposed').order('updated_at', { ascending: false }).limit(200),
        eq(sb, 'inventory_moves', familyId).order('moved_at', { ascending: false }).limit(20),
      ]);
      return { home_locations: locations.data ?? [], inventory_items: items.data ?? [], inventory_moves: moves.data ?? [] };
    }
    case 'sleep': {
      const [logs, routines, checkins] = await Promise.all([
        eq(sb, 'sleep_logs', familyId).gte('sleep_date', since(21).slice(0, 10)).order('sleep_date', { ascending: false }).limit(120),
        eq(sb, 'bedtime_routines', familyId).eq('is_active', true).limit(30),
        eq(sb, 'sleep_checkins', familyId).gte('checkin_date', since(21).slice(0, 10)).order('checkin_date', { ascending: false }).limit(80),
      ]);
      return { sleep_logs: logs.data ?? [], bedtime_routines: routines.data ?? [], sleep_checkins: checkins.data ?? [] };
    }
    case 'declutter': {
      const [zones, missions, sessions] = await Promise.all([
        eq(sb, 'declutter_zones', familyId).order('clutter_score', { ascending: false }).limit(60),
        eq(sb, 'declutter_missions', familyId).order('scheduled_for', { ascending: false, nullsFirst: false }).limit(60),
        eq(sb, 'declutter_sessions', familyId).order('started_at', { ascending: false }).limit(20),
      ]);
      return { declutter_zones: zones.data ?? [], declutter_missions: missions.data ?? [], declutter_sessions: sessions.data ?? [] };
    }
    case 'moving': {
      const live = await eq(sb, 'moves', familyId).neq('status', 'cancelled').order('move_date', { ascending: false }).limit(1);
      const mv = live.data?.[0];
      if (!mv) return { moves: [], move_tasks: [], move_boxes: [] };
      const [tasks, boxes] = await Promise.all([
        eq(sb, 'move_tasks', familyId).eq('move_id', mv.id).order('due_date', { ascending: true, nullsFirst: false }).limit(80),
        eq(sb, 'move_boxes', familyId).eq('move_id', mv.id).order('box_number').limit(80),
      ]);
      return { moves: [mv], move_tasks: tasks.data ?? [], move_boxes: boxes.data ?? [] };
    }
    case 'projects': {
      const live = await eq(sb, 'home_projects', familyId).not('status', 'in', '("done","cancelled")').order('priority').order('updated_at', { ascending: false }).limit(12);
      const ids = (live.data ?? []).map((p) => p.id);
      if (!ids.length) return { home_projects: [], project_materials: [], project_quotes: [] };
      const [materials, quotes] = await Promise.all([
        eq(sb, 'project_materials', familyId).in('project_id', ids).limit(120),
        eq(sb, 'project_quotes', familyId).in('project_id', ids).limit(60),
      ]);
      return { home_projects: live.data ?? [], project_materials: materials.data ?? [], project_quotes: quotes.data ?? [] };
    }
    case 'career': {
      const live = await eq(sb, 'career_profiles', familyId).eq('is_active', true).order('updated_at', { ascending: false }).limit(4);
      const ids = (live.data ?? []).map((p) => p.id);
      if (!ids.length) return { career_profiles: [], job_applications: [], resume_versions: [] };
      const [apps, resumes] = await Promise.all([
        eq(sb, 'job_applications', familyId).in('profile_id', ids).order('updated_at', { ascending: false }).limit(60),
        eq(sb, 'resume_versions', familyId).in('profile_id', ids).order('is_primary', { ascending: false }).limit(8),
      ]);
      return { career_profiles: live.data ?? [], job_applications: apps.data ?? [], resume_versions: resumes.data ?? [] };
    }
    case 'language': {
      const live = await eq(sb, 'language_goals', familyId).eq('is_active', true).order('updated_at', { ascending: false }).limit(4);
      const ids = (live.data ?? []).map((g) => g.id);
      if (!ids.length) return { language_goals: [], language_sessions: [], vocab_cards: [] };
      const [sessions, cards] = await Promise.all([
        eq(sb, 'language_sessions', familyId).in('goal_id', ids).order('practiced_on', { ascending: false }).limit(60),
        eq(sb, 'vocab_cards', familyId).in('goal_id', ids).order('due_on').limit(300),
      ]);
      return { language_goals: live.data ?? [], language_sessions: sessions.data ?? [], vocab_cards: cards.data ?? [] };
    }
    case 'calendar': {
      const ev = await eq(sb, 'calendar_events', familyId).gte('starts_at', since(1)).order('starts_at').limit(60);
      return { calendar_events: ev.data ?? [] };
    }
    case 'event': {
      const id = params.eventId;
      if (typeof id !== 'string' || !id) return { calendar_events: [] };
      const ev = await sb.from('calendar_events').select('*').eq('family_id', familyId).eq('id', id).limit(1);
      return { calendar_events: ev.data ?? [] };
    }
    case 'expenses': {
      const ex = await eq(sb, 'expense_splits', familyId).gte('spent_on', since(60).slice(0, 10)).order('spent_on', { ascending: false }).limit(120);
      return { expense_splits: ex.data ?? [] };
    }
    case 'grocery':
    case 'shopping': {
      const items = await eq(sb, 'grocery_items', familyId).eq('is_checked', false).limit(120);
      return { grocery_items: items.data ?? [] };
    }
    case 'homework': {
      const hw = await eq(sb, 'homework_assignments', familyId).neq('status', 'done').order('due_at', { ascending: true, nullsFirst: false }).limit(60);
      return { homework_assignments: hw.data ?? [] };
    }
    case 'medications': {
      const meds = await eq(sb, 'medications', familyId).eq('is_active', true).limit(40);
      const ids = (meds.data ?? []).map((m) => m.id as string);
      const sched = ids.length ? await sb.from('medication_schedules').select('*').in('medication_id', ids).limit(120) : { data: [] };
      return { medications: meds.data ?? [], medication_schedules: sched.data ?? [] };
    }
    case 'subscriptions': {
      const subs = await eq(sb, 'subscriptions_tracked', familyId).limit(80);
      return { subscriptions_tracked: subs.data ?? [] };
    }
    case 'todos': {
      const todos = await eq(sb, 'todo_items', familyId).eq('is_done', false).order('due_date', { ascending: true, nullsFirst: false }).limit(80);
      return { todo_items: todos.data ?? [] };
    }
    case 'trips': {
      const [trips, items] = await Promise.all([
        eq(sb, 'trips', familyId).neq('status', 'completed').order('start_date', { ascending: true, nullsFirst: false }).limit(15),
        eq(sb, 'trip_items', familyId).limit(80),
      ]);
      return { trips: trips.data ?? [], trip_items: items.data ?? [] };
    }
    case 'wishlists': {
      const items = await eq(sb, 'wishlist_items', familyId).eq('is_purchased', false).limit(60);
      return { wishlist_items: items.data ?? [] };
    }
    case 'home': {
      const [assets, tasks] = await Promise.all([
        eq(sb, 'home_assets', familyId).limit(40),
        sb.from('maintenance_tasks').select('*').eq('family_id', familyId).neq('status', 'done').order('due_at', { ascending: true, nullsFirst: false }).limit(40),
      ]);
      return { home_assets: assets.data ?? [], maintenance_tasks: tasks.data ?? [] };
    }
    case 'notifications': {
      const n = await eq(sb, 'notifications', familyId).lte('send_at', nowIso).order('send_at', { ascending: false }).limit(60);
      return { notifications: n.data ?? [] };
    }
    case 'messages': {
      let query = sb.from('family_messages').select('*').eq('family_id', familyId).is('deleted_at', null);
      if (typeof params.conversationId === 'string' && params.conversationId) query = query.eq('conversation_id', params.conversationId);
      const msgs = await query.order('created_at', { ascending: false }).limit(40);
      return { family_messages: (msgs.data ?? []).reverse() };
    }
    case 'weather': {
      const locs = await eq(sb, 'weather_locations', familyId).order('sort_order').limit(10);
      return { weather_locations: locs.data ?? [] };
    }
    case 'settings': {
      const [ev, todos, chores, meals, docs] = await Promise.all([
        eq(sb, 'calendar_events', familyId).gte('starts_at', nowIso).limit(50),
        eq(sb, 'todo_items', familyId).limit(50),
        eq(sb, 'chores', familyId).limit(50),
        sb.from('meals').select('id').eq('family_id', familyId).limit(50),
        sb.from('documents').select('id').eq('family_id', familyId).limit(50),
      ]);
      return {
        calendar_events: ev.data ?? [], todo_items: todos.data ?? [], chores: chores.data ?? [],
        meals: meals.data ?? [], documents: docs.data ?? [],
      };
    }
    case 'meals': {
      const [plans, mealRows] = await Promise.all([
        sb.from('meal_plans').select('*').eq('family_id', familyId).gte('plan_date', since(7)).order('plan_date').limit(30),
        sb.from('meals').select('id, name, meal_type, servings').eq('family_id', familyId).order('created_at', { ascending: false }).limit(20),
      ]);
      return { meal_plans: plans.data ?? [], meals: mealRows.data ?? [] };
    }
    case 'reminders': {
      const r = await eq(sb, 'family_reminders', familyId).order('due_at', { ascending: true, nullsFirst: false }).limit(30);
      return { family_reminders: r.data ?? [] };
    }
    case 'notes': {
      const n = await eq(sb, 'notes', familyId).order('updated_at', { ascending: false }).limit(15);
      return { notes: n.data ?? [] };
    }
    case 'recipes': {
      const [recipes, pantry] = await Promise.all([
        eq(sb, 'recipes', familyId).order('created_at', { ascending: false }).limit(15),
        eq(sb, 'pantry_items', familyId).eq('is_out_of_stock', false).limit(20),
      ]);
      return { recipes: recipes.data ?? [], pantry_items: pantry.data ?? [] };
    }
    case 'documents': {
      const docs = await eq(sb, 'documents', familyId).order('created_at', { ascending: false }).limit(20);
      return { documents: docs.data ?? [] };
    }
    case 'care': {
      const logs = await eq(sb, 'care_logs', familyId).order('occurred_at', { ascending: false, nullsFirst: false }).limit(20);
      return { care_logs: logs.data ?? [] };
    }
    case 'contacts': {
      const contacts = await eq(sb, 'contacts', familyId).order('name').limit(30);
      return { contacts: contacts.data ?? [] };
    }
    case 'billing': {
      const [subs, expenses] = await Promise.all([
        eq(sb, 'subscriptions_tracked', familyId).limit(30),
        eq(sb, 'expense_splits', familyId).gte('spent_on', since(30).slice(0, 10)).order('spent_on', { ascending: false }).limit(40),
      ]);
      return { subscriptions: subs.data ?? [], expenses: expenses.data ?? [] };
    }
    case 'goals': {
      const goals = await eq(sb, 'family_goals', familyId).neq('status', 'completed').order('created_at', { ascending: false }).limit(15);
      return { family_goals: goals.data ?? [] };
    }
    case 'pets': {
      const pets = await eq(sb, 'pets', familyId).eq('is_active', true).limit(10);
      return { pets: pets.data ?? [] };
    }
    case 'renewals': {
      const renewals = await eq(sb, 'renewals', familyId).order('renewal_date', { ascending: true, nullsFirst: false }).limit(20);
      return { renewals: renewals.data ?? [] };
    }
    case 'school': {
      const [hw, grades] = await Promise.all([
        eq(sb, 'homework_assignments', familyId).neq('status', 'done').order('due_at', { ascending: true, nullsFirst: false }).limit(20),
        eq(sb, 'grades', familyId).order('created_at', { ascending: false }).limit(15),
      ]);
      return { homework_assignments: hw.data ?? [], grades: grades.data ?? [] };
    }
    case 'sports': {
      const [events, teams] = await Promise.all([
        eq(sb, 'sports_events', familyId).order('starts_at', { ascending: true, nullsFirst: false }).limit(15),
        eq(sb, 'sports_teams', familyId).limit(10),
      ]);
      return { sports_events: events.data ?? [], sports_teams: teams.data ?? [] };
    }
    case 'pantry': {
      const items = await eq(sb, 'pantry_items', familyId).limit(40);
      return { pantry_items: items.data ?? [] };
    }
    case 'announcements': {
      const posts = await eq(sb, 'announcements', familyId).order('created_at', { ascending: false }).limit(10);
      return { announcements: posts.data ?? [] };
    }
    case 'medical': {
      const [records, appointments] = await Promise.all([
        eq(sb, 'medical_records', familyId).order('date', { ascending: false, nullsFirst: false }).limit(15),
        eq(sb, 'appointments', familyId).gte('appointment_date', nowIso.slice(0, 10)).order('appointment_date').limit(10),
      ]);
      return { medical_records: records.data ?? [], appointments: appointments.data ?? [] };
    }
    case 'insurance': {
      const policies = await eq(sb, 'insurance_policies', familyId).order('renewal_date', { ascending: true, nullsFirst: false }).limit(15);
      return { insurance_policies: policies.data ?? [] };
    }
    case 'rewards': {
      const [asg, redemptions] = await Promise.all([
        eq(sb, 'chore_assignments', familyId).limit(40),
        eq(sb, 'reward_redemptions', familyId).order('created_at', { ascending: false }).limit(15),
      ]);
      return { chore_assignments: asg.data ?? [], reward_redemptions: redemptions.data ?? [] };
    }
    case 'photos': {
      const [photos, albums] = await Promise.all([
        eq(sb, 'photos', familyId).order('created_at', { ascending: false }).limit(20),
        eq(sb, 'photo_albums', familyId).order('created_at', { ascending: false }).limit(10),
      ]);
      return { photos: photos.data ?? [], photo_albums: albums.data ?? [] };
    }
    case 'celebrations': {
      const dates = await eq(sb, 'family_dates', familyId).order('date').limit(30);
      return { family_dates: dates.data ?? [] };
    }
    case 'signups': {
      const opps = await eq(sb, 'opportunities', familyId).order('deadline', { ascending: true, nullsFirst: false }).limit(40);
      return { opportunities: opps.data ?? [] };
    }
    case 'behavior': {
      const logs = await eq(sb, 'behavior_logs', familyId).order('occurred_at', { ascending: false }).limit(30);
      return { behavior_logs: logs.data ?? [] };
    }
    case 'screen_time': {
      const [entries, limits] = await Promise.all([
        eq(sb, 'screen_time_entries', familyId).order('entry_date', { ascending: false }).limit(20),
        eq(sb, 'screen_time_limits', familyId).limit(10),
      ]);
      return { screen_time_entries: entries.data ?? [], screen_time_limits: limits.data ?? [] };
    }
    case 'binder': {
      const items = await eq(sb, 'household_info', familyId).order('category').order('sort').limit(50);
      return { household_info: items.data ?? [] };
    }
    case 'memories': {
      const [memories, trips] = await Promise.all([
        eq(sb, 'trip_memories', familyId).order('memory_date', { ascending: false }).limit(20),
        eq(sb, 'vacations', familyId).order('created_at', { ascending: false }).limit(10),
      ]);
      return { trip_memories: memories.data ?? [], vacations: trips.data ?? [] };
    }
    case 'timetable': {
      const classes = await eq(sb, 'school_classes', familyId).order('time_slot').limit(40);
      return { school_classes: classes.data ?? [] };
    }
    case 'tax': {
      const docs = await eq(sb, 'tax_documents', familyId).order('tax_year', { ascending: false }).order('created_at', { ascending: false }).limit(40);
      return { tax_documents: docs.data ?? [] };
    }
    case 'utilities': {
      const bills = await eq(sb, 'utility_bills', familyId).order('period_month', { ascending: false }).limit(24);
      return { utility_bills: bills.data ?? [] };
    }
    case 'rides': {
      const rides = await eq(sb, 'rides', familyId).order('ride_date').order('pickup_time', { nullsFirst: false }).limit(30);
      return { rides: rides.data ?? [] };
    }
    case 'votes': {
      const [polls, options, votes] = await Promise.all([
        eq(sb, 'family_polls', familyId).order('created_at', { ascending: false }).limit(15),
        eq(sb, 'family_poll_options', familyId).limit(60),
        eq(sb, 'family_poll_votes', familyId).limit(60),
      ]);
      return { family_polls: polls.data ?? [], family_poll_options: options.data ?? [], family_poll_votes: votes.data ?? [] };
    }
    default:
      return {};
  }
}
