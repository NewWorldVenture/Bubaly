import { NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { resolveProvider, isAIConfigured, describeAIError } from '@/lib/ai/provider';
import { INSIGHTS, isInsightKind, type InsightData, type InsightKind } from '@/lib/ai/insights';
import type { SupabaseClient } from '@supabase/supabase-js';

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

  const body = await req.json().catch(() => ({}));
  const kind = body.kind as string;
  if (!isInsightKind(kind)) return NextResponse.json({ error: 'Unknown insight kind' }, { status: 400 });

  const question = typeof body.question === 'string' ? body.question.slice(0, 1000) : undefined;
  const params = { ...(body.params ?? {}), ...(question ? { question } : {}) };

  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  const tz = ctx.active.family.timezone || 'America/New_York';

  const { data: members } = await supabase
    .from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true);

  let rows: Rows = {};
  try {
    rows = await fetchRows(kind, supabase, familyId, params);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to load data' }, { status: 500 });
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
      system: def.system,
      messages: [{ role: 'user', content: def.buildUser(data) }],
      tools: [],
      maxTokens: def.maxTokens,
    });
    const text = completion.text.trim();
    if (!text) return NextResponse.json({ error: 'No suggestions just now. Please try again.' }, { status: 502 });
    return NextResponse.json({ text });
  } catch (err) {
    console.error('AI insights error:', err);
    const { message, detail } = describeAIError(err);
    return NextResponse.json({ error: message, detail }, { status: 503 });
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
      // A light cross-section so the model can recommend what to set up next.
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
    default:
      return {};
  }
}
