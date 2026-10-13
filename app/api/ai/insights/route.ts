import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { settle, settleAll, describeReadError } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { dayKeyIn } from '@/lib/time/zoned';
import { isWithheldFromGuest } from '@/lib/auth/guest-scope';
import { resolveProvider, isAIConfigured, describeAIError } from '@/lib/ai/provider';
import { INSIGHTS, isInsightKind, MANAGER_ONLY_INSIGHTS, type InsightData, type InsightKind } from '@/lib/ai/insights';
import { insightReadRefused } from '@/lib/ai/insight-read-domains';
import { isManager } from '@/lib/constants/roles';
import { isExpiredFact, isSensitiveMemory } from '@/lib/services/memory';
import { loadAISettingsFor } from '@/lib/services/ai-settings';
import { readOnOpenGroceryLists } from '@/lib/services/groceries';
import type { ServiceScope } from '@/lib/services/types';
import { fenceUntrustedBlock, UNTRUSTED_CONTENT_RULE } from '@/lib/ai/safety/untrusted';
import type { SupabaseClient } from '@supabase/supabase-js';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { refuseIfLocked, refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { insightFeatureHrefs } from '@/lib/ai/insight-features';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';
import { readAll, readAllByIdAsQuery } from '@/lib/supabase/read-all';

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
  const t = await getTranslations();
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: t('insights.unauthorized') }, { status: 401 }); }

  if (!(await isAIConfigured())) {
    return NextResponse.json({ error: t('insights.theAiEngineIsnT') }, { status: 503 });
  }

  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: t('insights.requestBodyIsTooLarge') }, { status: 400 });
  const body = (boundedBody.value ?? {}) as Record<string, unknown>;
  const kind = body.kind as string;
  if (!isInsightKind(kind)) return NextResponse.json({ error: t('insights.unknownInsightKind') }, { status: 400 });

  // The route had no role check at all: `requireUserContext()` plus RLS was the
  // whole guard, and RLS on medications, family_messages, documents and the
  // finance tables is family-wide. So a child's session could ask a model to
  // summarise the household's prescriptions, private messages and documents —
  // the very areas the trust engine treats as sensitive for their role — and
  // get a helpful answer.
  if (MANAGER_ONLY_INSIGHTS.has(kind) && !isManager(ctx.active.role)) {
    return NextResponse.json({ error: t('insights.thatSummaryIsForThe') }, { status: 403 });
  }
  // A summary of school, sports, trips, homework or the timetable answers to
  // the same view rule as the assistant's read tools for that domain
  // (INSIGHT_READ_DOMAINS in lib/ai/insight-read-domains.ts, which the
  // screens' buttons read too): a guest is refused all five, a child the trips
  // one.
  if (insightReadRefused(kind, ctx.active.role)) {
    return NextResponse.json({ error: t('insights.thatSummaryIsForThe') }, { status: 403 });
  }
  // A guest is sent away from the pages over the household's money, medical
  // and insurance records (lib/auth/guest-scope.ts), and a summary of the same
  // rows answers to the same rule: the utilities page let a guest in and both
  // of its AI answers summarised every bill for them.
  if (ctx.active.role === 'guest' && (insightFeatureHrefs(kind) ?? []).some(isWithheldFromGuest)) {
    return NextResponse.json({ error: t('insights.thatSummaryIsForThe') }, { status: 403 });
  }

  const question = typeof body.question === 'string' ? body.question.slice(0, 1000) : undefined;
  const params = { ...(body.params ?? {}), ...(question ? { question } : {}) };

  const supabase = await createServer();

  // Role was checked above; PLAN was not. Each kind is reached from an AI
  // Assist button on one `requireFeature`-gated module page, and twenty-five of
  // them belong to a paid feature — so POSTing the kind name was the bypass,
  // on the surface that costs money per request. Gated per kind rather than on
  // the whole set, because `refuseUnlessEntitled` admits a caller entitled to
  // ANY href it is handed and every family is entitled to something.
  //
  // An alias (`grocery` for `shopping`) answers to its kind's gate, and a kind
  // no gated page renders still answers to the family's lock: a trial that
  // ended unpaid or a closed account is refused every model call, which
  // `refuseUnlessEntitled` says for the mapped kinds and nothing said for the
  // others.
  const gatedHrefs = insightFeatureHrefs(kind);
  const refused = gatedHrefs
    ? await refuseUnlessEntitled(supabase, ctx.active.familyId, gatedHrefs)
    : await refuseIfLocked(supabase, ctx.active.familyId);
  if (refused) return refused;

  const limited = await enforceAIRateLimit(supabase, `ai-insights:${ctx.user.id}`, { limit: 20 });
  if (!limited.ok) return NextResponse.json(
    { error: t('insights.tooManyAiInsightRequests') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );
  const familyId = ctx.active.familyId;
  const tz = ctx.active.family.timezone || 'America/New_York';
  // The family's day, for the kinds that ask "what is still ahead" of a DATE
  // column (rides, celebrations). Greenwich's day is a different one for hours
  // of every evening west of it and every morning east of it.
  const todayKey = dayKeyIn(new Date(), tz);

  // The roster read directly beside this one — `fetchRows` — fails the request
  // with a 500 when a read it checks with `required()` fails (every household
  // module kind and purchase_advisor; see the note above `required`). This one
  // dropped its error and fed
  // an empty member list into the same prompt, so the insight was generated for
  // a family the model was told has no members: every name, every per-child
  // observation, silently absent from an answer that still reads as complete.
  // Matched to the convention its own neighbour sets. Audit C1-S9-40.
  const { data: members, error: membersError } = await supabase
    .from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true);

  if (membersError) {
    console.error('[ai/insights] member read failed', { familyId, error: describeReadError(membersError) });
    return NextResponse.json({ error: t('insights.couldNotLoadDataFor') }, { status: 500 });
  }

  let rows: Rows = {};
  try {
    rows = await fetchRows(kind, supabase, familyId, params, {
      role: ctx.active.role,
      memberId: ctx.active.member.id,
      userId: ctx.user.id,
      todayKey,
    });
  } catch (err) {
    console.error('AI insights data load failed:', err);
    return NextResponse.json({ error: t('insights.couldNotLoadDataFor') }, { status: 500 });
  }

  const now = (() => {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date()); }
    catch { return new Date().toISOString(); }
  })();

  const data: InsightData = {
    familyName: ctx.active.family.name ?? 'Your family',
    now,
    todayKey,
    timeZone: tz,
    members: (members ?? []).map((m) => ({ id: m.id as string, name: m.display_name as string })),
    rows,
    params,
  };

  const def = INSIGHTS[kind];
  try {
    const text = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: `insights.${kind}`, text: 'Insights' },
      async (obs) => {
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
        obs.used(completion.model ?? 'unknown', completion.usage);
        const answer = completion.text.trim();
        if (!answer) obs.failed(new Error('The insight response was empty.'));
        return answer;
      },
    );
    if (!text) return NextResponse.json({ error: t('insights.noSuggestionsJustNowPlease') }, { status: 502 });
    return NextResponse.json({ text });
  } catch (err) {
    console.error('AI insights error:', err);
    return NextResponse.json({ error: describeAIError(err).message }, { status: 503 });
  }
}

const eq = (sb: SupabaseClient, table: string, familyId: string) => sb.from(table).select('*').eq('family_id', familyId);

/**
 * Fail closed on a read the prompt would otherwise describe as an empty, healthy
 * state. The route catches this and answers "could not load data" — a refused
 * query must never reach a model as "nothing found".
 *
 * supabase-js resolves EVERY failure — a PostgREST error and a transport one
 * alike — as `{ data: null, error }` rather than throwing, so the route's
 * try/catch never sees a read that `x.data ?? []` swallowed. For thirteen
 * household kinds that is exactly what happened: a failed inventory read
 * became "Nothing catalogued yet.", a failed `moves` read became "No move
 * planned yet.", and the answer came back at HTTP 200. Each of those kinds now
 * passes every read through here, parent reads before the ids derived from
 * them. (RLS filtering is not an error and still reads as fewer rows.)
 */
function required(reads: [string, { message?: string } | null | undefined][]): void {
  const failed = reads.find(([, error]) => Boolean(error));
  if (failed) throw new Error(`${failed[0]} read failed: ${failed[1]?.message ?? 'unknown error'}`);
}

/**
 * Who is asking, and on which family day. `purchase_advisor` and `wishlists`
 * need the member (gift state is hidden from the person a wish belongs to);
 * `rides` needs the day.
 */
type Viewer = { role: string; memberId: string | null; userId: string; todayKey: string };

async function fetchRows(
  kind: InsightKind,
  sb: SupabaseClient,
  familyId: string,
  params: Record<string, unknown>,
  viewer: Viewer,
): Promise<Rows> {
  const nowIso = new Date().toISOString();
  const since = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

  switch (kind) {
    case 'chores': {
      const [chores, asg] = await Promise.all([
        eq(sb, 'chores', familyId).eq('is_active', true).limit(40),
        sb.from('chore_assignments').select('*').eq('family_id', familyId).in('status', ['todo', 'in_progress', 'submitted']).limit(60),
  ]);
      required([['chores', chores.error], ['chore_assignments', asg.error]]);
      return { chores: chores.data ?? [], chore_assignments: asg.data ?? [] };
    }
    case 'closet': {
      const [items, logs] = await Promise.all([
        eq(sb, 'wardrobe_items', familyId).in('status', ['active', 'laundry', 'outgrown']).order('member_id').limit(160),
        eq(sb, 'outfit_logs', familyId).gte('worn_on', since(30).slice(0, 10)).order('worn_on', { ascending: false }).limit(60),
      ]);
      required([['wardrobe_items', items.error], ['outfit_logs', logs.error]]);
      return { wardrobe_items: items.data ?? [], outfit_logs: logs.data ?? [] };
    }
    case 'watchlist': {
      const [titles, votes, sessions] = await Promise.all([
        eq(sb, 'watchlist_titles', familyId).in('status', ['want', 'watching']).order('priority').limit(120),
        eq(sb, 'watchlist_votes', familyId).limit(300),
        eq(sb, 'watch_sessions', familyId).order('watched_on', { ascending: false }).limit(30),
      ]);
      required([['watchlist_titles', titles.error], ['watchlist_votes', votes.error], ['watch_sessions', sessions.error]]);
      return { watchlist_titles: titles.data ?? [], watchlist_votes: votes.data ?? [], watch_sessions: sessions.data ?? [] };
    }
    case 'inventory': {
      const [locations, items, moves] = await Promise.all([
        eq(sb, 'home_locations', familyId).limit(200),
        eq(sb, 'inventory_items', familyId).neq('status', 'disposed').order('updated_at', { ascending: false }).limit(200),
        eq(sb, 'inventory_moves', familyId).order('moved_at', { ascending: false }).limit(20),
      ]);
      required([['home_locations', locations.error], ['inventory_items', items.error], ['inventory_moves', moves.error]]);
      return { home_locations: locations.data ?? [], inventory_items: items.data ?? [], inventory_moves: moves.data ?? [] };
    }
    case 'sleep': {
      const [logs, routines, checkins] = await Promise.all([
        eq(sb, 'sleep_logs', familyId).gte('sleep_date', since(21).slice(0, 10)).order('sleep_date', { ascending: false }).limit(120),
        eq(sb, 'bedtime_routines', familyId).eq('is_active', true).limit(30),
        eq(sb, 'sleep_checkins', familyId).gte('checkin_date', since(21).slice(0, 10)).order('checkin_date', { ascending: false }).limit(80),
      ]);
      required([['sleep_logs', logs.error], ['bedtime_routines', routines.error], ['sleep_checkins', checkins.error]]);
      return { sleep_logs: logs.data ?? [], bedtime_routines: routines.data ?? [], sleep_checkins: checkins.data ?? [] };
    }
    case 'declutter': {
      const [zones, missions, sessions] = await Promise.all([
        eq(sb, 'declutter_zones', familyId).order('clutter_score', { ascending: false }).limit(60),
        eq(sb, 'declutter_missions', familyId).order('scheduled_for', { ascending: false, nullsFirst: false }).limit(60),
        eq(sb, 'declutter_sessions', familyId).order('started_at', { ascending: false }).limit(20),
      ]);
      required([['declutter_zones', zones.error], ['declutter_missions', missions.error], ['declutter_sessions', sessions.error]]);
      return { declutter_zones: zones.data ?? [], declutter_missions: missions.data ?? [], declutter_sessions: sessions.data ?? [] };
    }
    case 'moving': {
      const live = await eq(sb, 'moves', familyId).neq('status', 'cancelled').order('move_date', { ascending: false }).limit(1);
      // Checked before `mv` is derived: a failed read is not "No move planned yet."
      required([['moves', live.error]]);
      const mv = live.data?.[0];
      if (!mv) return { moves: [], move_tasks: [], move_boxes: [] };
      const [tasks, boxes] = await Promise.all([
        eq(sb, 'move_tasks', familyId).eq('move_id', mv.id).order('due_date', { ascending: true, nullsFirst: false }).limit(80),
        eq(sb, 'move_boxes', familyId).eq('move_id', mv.id).order('box_number').limit(80),
      ]);
      required([['move_tasks', tasks.error], ['move_boxes', boxes.error]]);
      return { moves: [mv], move_tasks: tasks.data ?? [], move_boxes: boxes.data ?? [] };
    }
    case 'projects': {
      const live = await eq(sb, 'home_projects', familyId).not('status', 'in', '("done","cancelled")').order('priority').order('updated_at', { ascending: false }).limit(12);
      required([['home_projects', live.error]]);
      const ids = (live.data ?? []).map((p) => p.id);
      if (!ids.length) return { home_projects: [], project_materials: [], project_quotes: [] };
      const [materials, quotes] = await Promise.all([
        eq(sb, 'project_materials', familyId).in('project_id', ids).limit(120),
        eq(sb, 'project_quotes', familyId).in('project_id', ids).limit(60),
      ]);
      required([['project_materials', materials.error], ['project_quotes', quotes.error]]);
      return { home_projects: live.data ?? [], project_materials: materials.data ?? [], project_quotes: quotes.data ?? [] };
    }
    case 'career': {
      const live = await eq(sb, 'career_profiles', familyId).eq('is_active', true).order('updated_at', { ascending: false }).limit(4);
      required([['career_profiles', live.error]]);
      const ids = (live.data ?? []).map((p) => p.id);
      if (!ids.length) return { career_profiles: [], job_applications: [], resume_versions: [] };
      const [apps, resumes] = await Promise.all([
        eq(sb, 'job_applications', familyId).in('profile_id', ids).order('updated_at', { ascending: false }).limit(60),
        eq(sb, 'resume_versions', familyId).in('profile_id', ids).order('is_primary', { ascending: false }).limit(8),
      ]);
      required([['job_applications', apps.error], ['resume_versions', resumes.error]]);
      return { career_profiles: live.data ?? [], job_applications: apps.data ?? [], resume_versions: resumes.data ?? [] };
    }
    case 'language': {
      const live = await eq(sb, 'language_goals', familyId).eq('is_active', true).order('updated_at', { ascending: false }).limit(4);
      required([['language_goals', live.error]]);
      const ids = (live.data ?? []).map((g) => g.id);
      if (!ids.length) return { language_goals: [], language_sessions: [], vocab_cards: [] };
      const [sessions, cards] = await Promise.all([
        eq(sb, 'language_sessions', familyId).in('goal_id', ids).order('practiced_on', { ascending: false }).limit(60),
        eq(sb, 'vocab_cards', familyId).in('goal_id', ids).order('due_on').limit(300),
      ]);
      required([['language_sessions', sessions.error], ['vocab_cards', cards.error]]);
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
      // A failed read is not "$0.00 across 0 entries" with savings advice built
      // on it.
      required([['expense_splits', ex.error]]);
      return { expense_splits: ex.data ?? [] };
    }
    case 'grocery':
    case 'shopping': {
      // Only lists the family has not archived (readOnOpenGroceryLists).
      const items = await readOnOpenGroceryLists(sb as ServiceScope['db'], familyId, (lists) => eq(sb, 'grocery_items', familyId).in('list_id', lists).eq('is_checked', false).limit(120));
      required([['grocery_items', items.error]]);
      return { grocery_items: items.data ?? [] };
    }
    case 'homework': {
      // Open = still to do (lib/homework/board.ts isOpen): `.neq('done')` listed
      // submitted work under "Open homework".
      const hw = await eq(sb, 'homework_assignments', familyId).in('status', ['assigned', 'in_progress']).order('due_at', { ascending: true, nullsFirst: false }).limit(60);
      required([['homework_assignments', hw.error]]);
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
      required([['subscriptions_tracked', subs.error]]);
      return { subscriptions_tracked: subs.data ?? [] };
    }
    case 'todos': {
      const todos = await eq(sb, 'todo_items', familyId).eq('is_done', false).order('due_date', { ascending: true, nullsFirst: false }).limit(80);
      required([['todo_items', todos.error]]);
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
      // Gift state is hidden from the person a wish belongs to, as in
      // purchase_advisor below. Reading only the unbought wishes left a
      // person's OWN bought ones out of the prompt, so asking for "everything
      // on my list" and comparing the answer with the list on screen told them
      // which presents were already wrapped. Their own rows go in with the gift
      // state stripped; only other members' bought wishes are left out.
      const items = await eq(sb, 'wishlist_items', familyId).order('created_at', { ascending: false }).limit(200);
      required([['wishlist_items', items.error]]);
      const visible = (items.data ?? []).flatMap((w) => {
        if (viewer.memberId && String(w.member_id ?? '') === viewer.memberId) {
          return [{ ...w, is_purchased: false, claimed_by: null, claimed_at: null }];
        }
        return w.is_purchased ? [] : [w];
      });
      return { wishlist_items: visible };
    }
    // "Before you buy" — everything the household already OWNS, plus what it
    // remembers preferring. No budgets or transactions: the money check is the
    // deterministic panel's job (it goes through the finance service's role
    // boundary), so this prompt never carries the family's finances.
    //
    // Every read is CHECKED. `describeAdvice` states "nothing matching in the
    // household inventory, home assets or closet" when a list comes back empty,
    // and an empty list from a refused query would make that a lie told to the
    // model and echoed to the family. A throw here becomes the route's "could
    // not load data" 500, which is the truth.
    case 'purchase_advisor': {
      // "Allow memory" off means remembered facts do not reach the model —
      // the same switch the purchases service and the memory slice honour.
      // Read strictly: a failed read must not be taken for memory ON.
      const settings = await loadAISettingsFor(sb as ServiceScope['db'], familyId);
      if (!settings.ok) throw new Error(`family_ai_settings read failed: ${settings.error}`);
      const memoryEnabled = settings.data.memoryEnabled;
      const [inventory, locations, assets, wardrobe, wishes, facts] = await Promise.all([
        eq(sb, 'inventory_items', familyId).limit(200),
        eq(sb, 'home_locations', familyId).limit(120),
        eq(sb, 'home_assets', familyId).limit(80),
        eq(sb, 'wardrobe_items', familyId).limit(160),
        eq(sb, 'wishlist_items', familyId).limit(60),
        memoryEnabled
          ? eq(sb, 'family_facts', familyId).limit(120)
          : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
      ]);
      required([
        ['inventory_items', inventory.error],
        ['home_locations', locations.error],
        ['home_assets', assets.error],
        ['wardrobe_items', wardrobe.error],
        ['wishlist_items', wishes.error],
        ['family_facts', facts.error],
      ]);
      // The memory service's boundary, applied here because this is the one
      // insight that puts `family_facts` in a prompt: medical and account facts
      // (and sensitive wording in any category) are for the adults who manage
      // the family, and an expired fact is not a current preference. Without
      // this a child could ask about "peanut butter" and have a medical fact
      // read back to them by the model.
      const now = new Date();
      const canSeeSensitive = viewer.role === 'system' || isManager(viewer.role);
      const visibleFacts = (facts.data ?? []).filter((f) => {
        const expiresAt = typeof f.expires_at === 'string' ? f.expires_at : null;
        if (isExpiredFact({ expires_at: expiresAt }, now)) return false;
        if (canSeeSensitive) return true;
        return !isSensitiveMemory({
          category: typeof f.category === 'string' ? f.category : null,
          key: String(f.label ?? ''),
          content: String(f.value ?? ''),
          notes: typeof f.notes === 'string' ? f.notes : null,
        });
      });
      // Gift state is hidden from the person the wish belongs to, so their own
      // rows reach the prompt with it stripped rather than not at all.
      const visibleWishes = (wishes.data ?? []).map((w) =>
        viewer.memberId && String(w.member_id ?? '') === viewer.memberId ? { ...w, is_purchased: false } : w,
      );
      return {
        inventory_items: inventory.data ?? [],
        home_locations: locations.data ?? [],
        home_assets: assets.data ?? [],
        wardrobe_items: wardrobe.data ?? [],
        wishlist_items: visibleWishes,
        family_facts: visibleFacts,
      };
    }
    case 'home': {
      const [assets, tasks] = await Promise.all([
        eq(sb, 'home_assets', familyId).limit(40),
        sb.from('maintenance_tasks').select('*').eq('family_id', familyId).neq('status', 'done').order('due_at', { ascending: true, nullsFirst: false }).limit(40),
  ]);
      // A failed read reached the model as "Home assets: none" and came back a
      // confident "no upkeep due" at 200.
      required([['home_assets', assets.error], ['maintenance_tasks', tasks.error]]);
      return { home_assets: assets.data ?? [], maintenance_tasks: tasks.data ?? [] };
    }
    case 'notifications': {
      const n = await eq(sb, 'notifications', familyId).lte('send_at', nowIso).order('send_at', { ascending: false }).limit(60);
      // A failed read reached the model as "Recent notifications: none", and its
      // "nothing needs your attention" came back at 200.
      required([['notifications', n.error]]);
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
      required([['weather_locations', locs.error]]);
      return { weather_locations: locs.data ?? [] };
    }
    case 'settings': {
      // settleAll: one read that never completes would otherwise reject the
      // batch, and reach the log as a bare transport error naming no read.
      const [ev, todos, chores, meals, docs] = await settleAll([
        eq(sb, 'calendar_events', familyId).gte('starts_at', nowIso).limit(50),
        eq(sb, 'todo_items', familyId).limit(50),
        eq(sb, 'chores', familyId).limit(50),
        sb.from('meals').select('id').eq('family_id', familyId).limit(50),
        sb.from('documents').select('id').eq('family_id', familyId).limit(50),
      ]);
      // Five failed reads were "Activity counts: 0" and a confident "set up your
      // calendar" to a family with a full one.
      required([['calendar_events', ev.error], ['todo_items', todos.error], ['chores', chores.error], ['meals', meals.error], ['documents', docs.error]]);
      return {
        calendar_events: ev.data ?? [], todo_items: todos.data ?? [], chores: chores.data ?? [],
        meals: meals.data ?? [], documents: docs.data ?? [],
      };
    }
    case 'meals': {
      const [plans, mealRows] = await Promise.all([
        settle(sb.from('meal_plans').select('*').eq('family_id', familyId).gte('plan_date', since(7)).order('plan_date').limit(30)),
        settle(sb.from('meals').select('id, name, meal_type, notes').eq('family_id', familyId).order('created_at', { ascending: false }).limit(20)),
      ]);
      required([['meal_plans', plans.error], ['meals', mealRows.error]]);
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
        eq(sb, 'family_recipes', familyId).order('created_at', { ascending: false }).limit(15),
        // In stock = a quantity left. The filter used to name `is_out_of_stock`,
        // a column no migration ever created, so PostgREST refused this read on
        // every call and the recipes prompt always said "Pantry items: none
        // tracked." — now that the read is checked, it has to be a real one.
        eq(sb, 'pantry_items', familyId).gt('quantity', 0).limit(20),
      ]);
      required([['family_recipes', recipes.error], ['pantry_items', pantry.error]]);
      return { family_recipes: recipes.data ?? [], pantry_items: pantry.data ?? [] };
    }
    case 'documents': {
      const stored = await eq(sb, 'documents', familyId).order('created_at', { ascending: false }).limit(20);
      required([['documents', stored.error]]);
      return { documents: stored.data ?? [] };
    }
    case 'care': {
      const logs = await eq(sb, 'care_log', familyId).order('occurred_at', { ascending: false, nullsFirst: false }).limit(20);
      required([['care_log', logs.error]]);
      return { care_log: logs.data ?? [] };
    }
    case 'contacts': {
      const contacts = await eq(sb, 'family_contacts', familyId).order('name').limit(30);
      return { family_contacts: contacts.data ?? [] };
    }
    case 'billing': {
      const [subs, expenses] = await Promise.all([
        eq(sb, 'subscriptions_tracked', familyId).limit(30),
        eq(sb, 'expense_splits', familyId).gte('spent_on', since(30).slice(0, 10)).order('spent_on', { ascending: false }).limit(40),
      ]);
      // A failed read is not "No subscriptions." or "0 items" at HTTP 200.
      required([['subscriptions_tracked', subs.error], ['expense_splits', expenses.error]]);
      return { subscriptions: subs.data ?? [], expenses: expenses.data ?? [] };
    }
    case 'goals': {
      const goals = await eq(sb, 'goals', familyId).eq('is_complete', false).order('created_at', { ascending: false }).limit(15);
      required([['goals', goals.error]]);
      return { goals: goals.data ?? [] };
    }
    case 'pets': {
      // The prompt asks for upcoming care and vet visits, so it is handed the
      // care records that answer it — for the pets still in the household.
      const [pets, care] = await Promise.all([
        eq(sb, 'pets', familyId).eq('is_active', true).limit(10),
        eq(sb, 'pet_care_records', familyId).order('record_date', { ascending: false }).limit(60),
      ]);
      required([['pets', pets.error], ['pet_care_records', care.error]]);
      const petIds = new Set((pets.data ?? []).map((p) => String(p.id)));
      return { pets: pets.data ?? [], pet_care_records: (care.data ?? []).filter((c) => petIds.has(String(c.pet_id))) };
    }
    case 'renewals': {
      const renewals = await eq(sb, 'renewals', familyId).order('renewal_date', { ascending: true, nullsFirst: false }).limit(20);
      return { renewals: renewals.data ?? [] };
    }
    case 'school': {
      const [hw, grades] = await Promise.all([
        eq(sb, 'homework_assignments', familyId).in('status', ['assigned', 'in_progress']).order('due_at', { ascending: true, nullsFirst: false }).limit(20),
        eq(sb, 'grades', familyId).order('created_at', { ascending: false }).limit(15),
      ]);
      return { homework_assignments: hw.data ?? [], grades: grades.data ?? [] };
    }
    case 'sports': {
      const [events, teams] = await Promise.all([
        eq(sb, 'sports_events', familyId).order('starts_at', { ascending: true, nullsFirst: false }).limit(15),
        eq(sb, 'teams', familyId).eq('is_active', true).limit(10),
      ]);
      return { sports_events: events.data ?? [], teams: teams.data ?? [] };
    }
    case 'pantry': {
      const items = await eq(sb, 'pantry_items', familyId).limit(40);
      required([['pantry_items', items.error]]);
      return { pantry_items: items.data ?? [] };
    }
    case 'announcements': {
      const posts = await eq(sb, 'family_announcements', familyId).order('created_at', { ascending: false }).limit(10);
      required([['family_announcements', posts.error]]);
      return { family_announcements: posts.data ?? [] };
    }
    case 'medical': {
      // A visit is a parent's or adult's to read, or the member's own, or one
      // the asker recorded (the held 0506, lib/health/record-scope.ts) — the
      // rows the Medical and Dental pages show this asker. Released, 0481 still
      // hands a teen or child the household's, so the summary is narrowed here
      // rather than left to RLS, before the limit.
      const visits = eq(sb, 'health_visits', familyId);
      const ownOrAuthored = [viewer.memberId ? `member_id.eq.${viewer.memberId}` : null, `created_by.eq.${viewer.userId}`]
        .filter(Boolean).join(',');
      const [records, appointments] = await settleAll([
        (isManager(viewer.role) ? visits : visits.or(ownOrAuthored))
          .order('visit_date', { ascending: false, nullsFirst: false }).limit(15),
        eq(sb, 'appointments', familyId).gte('starts_at', nowIso).order('starts_at').limit(10),
      ]);
      required([['health_visits', records.error], ['appointments', appointments.error]]);
      return { health_visits: records.data ?? [], appointments: appointments.data ?? [] };
    }
    case 'insurance': {
      // The Insurance Hub's own table. `insurance_policies` is the medical-card
      // table (0009): it has no renewal_date, so ordering by it failed every
      // call, and the failure reached the model as "No policies tracked."
      const policies = await eq(sb, 'family_insurance_policies', familyId).eq('is_active', true).order('renewal_date', { ascending: true, nullsFirst: false }).limit(15);
      required([['family_insurance_policies', policies.error]]);
      return { family_insurance_policies: policies.data ?? [] };
    }
    case 'rewards': {
      // The ledger, whole: every APPROVED assignment and every redemption, the
      // set 0439's guard and the rewards page's computeBalances sum. Forty
      // unordered rows of any status, 20 of them summed, was a sample presented
      // as "Total points earned". Past the ceiling readAll answers an error and
      // the route says it could not load, rather than handing over a prefix.
      const [asg, redemptions, pending] = await settleAll([
        // Paged on the id (readAllById): an offset read repeats a row written
        // between its pages, and these rows are summed.
        readAllByIdAsQuery<{ id: string } & Record<string, unknown>>((after, limit) => {
          let q = sb.from('chore_assignments')
            .select('id, member_id, status, points_awarded').eq('family_id', familyId).eq('status', 'approved');
          if (after) q = q.gt('id', after);
          return q.order('id').limit(limit);
        }, { max: 50_000 }),
        readAllByIdAsQuery<{ id: string } & Record<string, unknown>>((after, limit) => {
          let q = sb.from('reward_redemptions')
            .select('id, member_id, cost_points, status, created_at').eq('family_id', familyId);
          if (after) q = q.gt('id', after);
          return q.order('id').limit(limit);
        }, { max: 50_000 }),
        sb.from('chore_assignments').select('id', { count: 'exact', head: true })
          .eq('family_id', familyId).in('status', ['todo', 'in_progress', 'submitted']),
      ]);
      required([['chore_assignments', asg.error], ['reward_redemptions', redemptions.error], ['chore_assignments', pending.error]]);
      return { chore_assignments: asg.data ?? [], reward_redemptions: redemptions.data ?? [], pending_chores: [{ count: pending.count ?? 0 }] };
    }
    case 'photos': {
      const [photos, albums] = await Promise.all([
        eq(sb, 'family_photos', familyId).order('created_at', { ascending: false }).limit(20),
        eq(sb, 'family_albums', familyId).order('created_at', { ascending: false }).limit(10),
      ]);
      return { family_photos: photos.data ?? [], family_albums: albums.data ?? [] };
    }
    case 'celebrations': {
      // `event_date`, not `date`: the column 0048 created. Ordering by a column
      // that does not exist failed every call, and the empty result read as
      // "none found". The module also lists the members' own birthdays, so the
      // prompt is given those too.
      const [dates, people] = await Promise.all([
        eq(sb, 'family_dates', familyId).order('event_date').limit(60),
        sb.from('family_members').select('id, display_name, birthday').eq('family_id', familyId).eq('is_active', true).not('birthday', 'is', null).limit(50),
      ]);
      required([['family_dates', dates.error], ['family_members', people.error]]);
      return { family_dates: dates.data ?? [], family_members: people.data ?? [] };
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
      required([['screen_time_entries', entries.error], ['screen_time_limits', limits.error]]);
      return { screen_time_entries: entries.data ?? [], screen_time_limits: limits.data ?? [] };
    }
    case 'binder': {
      const items = await eq(sb, 'household_info', familyId).order('category').order('sort').limit(50);
      required([['household_info', items.error]]);
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
      required([['school_classes', classes.error]]);
      return { school_classes: classes.data ?? [] };
    }
    case 'tax': {
      const docs = await eq(sb, 'tax_documents', familyId).order('tax_year', { ascending: false }).order('created_at', { ascending: false }).limit(40);
      required([['tax_documents', docs.error]]);
      return { tax_documents: docs.data ?? [] };
    }
    case 'utilities': {
      const bills = await eq(sb, 'utility_bills', familyId).order('period_month', { ascending: false }).limit(24);
      required([['utility_bills', bills.error]]);
      return { utility_bills: bills.data ?? [] };
    }
    case 'rides': {
      // From the family's today: oldest-first with no date bound, a family with
      // thirty past rides was handed only past ones and told it had none ahead.
      // And only rides still to happen ('planned' or 'confirmed', 0027's
      // ride_status), every one of them (readAll): a cap taken before the
      // cancelled and completed rows were dropped let thirty of those hide a
      // planned ride, and the prompt's counts are only true if nothing is cut.
      const rides = await readAll<Record<string, unknown>>((from, to) => sb.from('rides').select('*').eq('family_id', familyId)
        .gte('ride_date', viewer.todayKey).in('status', ['planned', 'confirmed'])
        .order('ride_date').order('pickup_time', { nullsFirst: false }).order('id').range(from, to));
      required([['rides', rides.error]]);
      return { rides: rides.rows };
    }
    case 'votes': {
      // The options and votes OF the polls listed. Read as the family's first
      // sixty of each, in no order and for any poll, a family whose older polls
      // held sixty votes was told its newest poll had none.
      const polls = await eq(sb, 'family_polls', familyId).order('created_at', { ascending: false }).limit(15);
      required([['family_polls', polls.error]]);
      // Every row of those polls (readAll), so no cap can cut one short.
      const pollIds = (polls.data ?? []).map((p) => p.id as string);
      // settleAll: a read that never completes comes back as an error, which
      // required() refuses, instead of taking the other read down with it.
      const [options, votes] = await settleAll([
        readAll<Record<string, unknown>>((from, to) => sb.from('family_poll_options').select('*').eq('family_id', familyId).in('poll_id', pollIds).order('id').range(from, to)),
        readAll<Record<string, unknown>>((from, to) => sb.from('family_poll_votes').select('*').eq('family_id', familyId).in('poll_id', pollIds).order('id').range(from, to)),
      ]);
      required([['family_poll_options', options.error], ['family_poll_votes', votes.error]]);
      return {
        family_polls: polls.data ?? [],
        family_poll_options: 'rows' in options ? options.rows : [],
        family_poll_votes: 'rows' in votes ? votes.rows : [],
      };
    }
    default:
      return {};
  }
}
