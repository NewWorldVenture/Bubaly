import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { describeReadError, settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { addDaysToDayKey, scopeFromUserContext, todayKeyFor, hourInTz } from '@/lib/services/scope';
import { isMissingTableError } from '@/lib/supabase/errors';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';
import { instantCalendarBounds } from '@/lib/briefing/calendar-window';
import { readCalendarOccurrences } from '@/lib/calendar/occurrences';
import { foodProfile } from '@/lib/services/meals';
import {
  buildChefSystem, buildChefUser, parseChefReply, fallbackChefReply, screenChefReply, type ChefContext,
} from '@/lib/food/chef';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

/**
 * AI Family Chef — a conversational chef grounded in the family's REAL context:
 * calendar busy-nights, pantry + expiring items, logged leftovers, dietary
 * rules, budget, and their own recipe library. Returns a typed plan + grocery
 * adds + tips. Deterministic, never-fabricated fallback when AI is unconfigured.
 */
export async function POST(req: Request) {
  const t = await getTranslations();
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: t('chef.unauthorized') }, { status: 401 }); }

  const familyId = ctx.active.familyId;
  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_PROVIDER_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: t('chef.requestBodyIsTooLarge') }, { status: 400 });
  const body = (boundedBody.value ?? {}) as Record<string, unknown>;
  const request = String(body.request ?? '').slice(0, 500).trim();
  if (!request) return NextResponse.json({ error: t('chef.tellTheChefWhatYou') }, { status: 400 });

  const dietary = (Array.isArray(body.dietary) ? body.dietary : []).map((s: unknown) => String(s)).slice(0, 12);
  const weeklyBudget = typeof body.weeklyBudget === 'number' && body.weeklyBudget > 0 ? Math.round(body.weeklyBudget) : null;

  const supabase = await createServer();
  // The page in front of this is feature-gated; this endpoint was not, and it
  // calls a model. Same resolver, so the two cannot disagree.
  const refused = await refuseUnlessEntitled(supabase, ctx.active.familyId, ['/dashboard/kitchen']);
  if (refused) return refused;
  const limited = await enforceAIRateLimit(supabase, `ai-chef:${ctx.user.id}`, { limit: 15 });
  if (!limited.ok) return NextResponse.json(
    { error: t('chef.tooManyChefRequestsPlease') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );
  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 86400000).toISOString();
  const chefTimezone = ctx.active.family.timezone || 'UTC';
  // The family's day, not the host's: "expiring within a week" computed
  // against a UTC midnight shifted the whole window a day for the last seven
  // hours of every Californian day, so the chef urged using food that was
  // fine and stayed quiet about food that was not.
  const todayKey = todayKeyFor(ctx);

  // The household's recorded allergies, diets and dislikes. The only caller
  // sends `{ request }`, so `body.dietary` was always empty and a family with
  // a peanut allergy on file was planned a week with no constraint. Read
  // alongside the kitchen reads below.
  // A transport rejection is a failed read like any other (see settleAll).
  const profileRead = foodProfile(scopeFromUserContext(ctx, supabase))
    .catch((cause: unknown) => ({ ok: false as const, error: cause instanceof Error ? cause.message : 'The food profile read failed.', code: undefined }));

  // Gather real family context in parallel.
  const [recipesRes, pantryRes, expiringRes, eventsRes, leftoverRes] = await settleAll([
    supabase.from('family_recipes').select('name').eq('family_id', familyId).order('is_favorite', { ascending: false }).limit(40),
    supabase.from('pantry_items').select('name, expires_at').eq('family_id', familyId).limit(200),
    // What is about to turn, asked for directly and soonest first. Taken from
    // the unordered 200-row sample above, food expiring this week fell out of
    // the prompt whenever the family had more rows than that. Still good from
    // today on: an item past its date is not something to cook with.
    supabase.from('pantry_items').select('name, expires_at').eq('family_id', familyId)
      .gte('expires_at', todayKey).lte('expires_at', addDaysToDayKey(todayKey, 7))
      .order('expires_at', { ascending: true }).order('id').limit(15),
    // Series included, so the week's recurring commitments shape the plan
    // (lib/calendar/occurrences.ts). Read WHOLE: a 40-row cap cut the week to
    // its earliest occurrences of any hour, so a family with a full school and
    // work week lost every Thursday-to-Sunday practice before the evening
    // filter below ever saw it.
    readCalendarOccurrences(supabase, familyId, instantCalendarBounds(now.toISOString(), weekAhead, chefTimezone), chefTimezone, { columns: ['title', 'starts_at', 'category', 'all_day'] }),
    // Fresh leftovers still inside their use-by (or undated). Nothing moves a
    // leftover out of 'fresh' when its date passes, so the status alone handed
    // the chef food the kitchen card tells the family to toss.
    supabase.from('leftover_inventory').select('name, source_meal, use_by').eq('family_id', familyId).eq('status', 'fresh')
      .or(`use_by.is.null,use_by.gte.${todayKey}`)
      .order('use_by', { ascending: true, nullsFirst: false }).order('id').limit(20),
  ]);
  const profile = await profileRead;

  // A failed read is not an empty kitchen. Each of these used to become `[]`,
  // so a refused pantry read was "nothing expiring", a failed calendar read was
  // "no busy nights", and the chef planned a two-hour braise for the night of
  // the away game — at HTTP 200. /api/ai/meals/plan fails closed on exactly
  // this; so does this route now. Only a leftovers table that is not migrated
  // yet is a genuine absence.
  const readFailures = ([
    ['family_recipes', recipesRes.error],
    ['pantry_items', pantryRes.error ?? expiringRes.error],
    ['calendar', eventsRes.error],
    ['leftover_inventory', isMissingTableError(leftoverRes.error) ? null : leftoverRes.error],
    // Fail closed, as /api/ai/pantry-chef does: an allergy list that could not
    // be read is not a household without allergies.
    ['food_profile', profile.ok ? null : { message: profile.error, code: profile.code ?? null }],
  ] as const).filter(([, error]) => Boolean(error));
  if (readFailures.length > 0) {
    console.error('[ai/chef] context read failed', {
      familyId, reads: readFailures.map(([read, error]) => ({ read, detail: describeReadError(error) })),
    });
    return NextResponse.json({ error: t('chef.kitchenDataIsTemporarilyUnavailable') }, { status: 503 });
  }

  const recipeNames = (recipesRes.data ?? []).map((r) => r.name);
  const pantry = pantryRes.data ?? [];
  const pantryItems = pantry.map((p) => p.name);
  const expiringItems = (expiringRes.data ?? []).map((p) => p.name).slice(0, 15);
  const household = profile.ok ? profile.data.household : { allergies: [], diet: [], dislikes: [] };

  // Busy evenings (events after 4pm) become "keep it quick" signals — on the
  // FAMILY's clock. `getHours()` is the host's hour, so on a UTC server a 6pm
  // Californian practice read as 1am and was never a busy night, and its
  // weekday was tomorrow's.
  const tz = ctx.active.family.timezone || 'UTC';
  const dayShort = (iso: string) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', timeZone: tz });
  // Timed events only: an all-day row is a UTC midnight, which read as about
  // 5pm the day before anywhere west of Greenwich and invented a busy night.
  const busyNights = (eventsRes.data ?? [])
    .filter((e) => !e.all_day && hourInTz(new Date(e.starts_at), tz) >= 16)
    .map((e) => `${dayShort(e.starts_at)}: ${e.title}`)
    .slice(0, 10);

  // Leftovers (table may not be migrated yet → empty).
  const leftovers = isMissingTableError(leftoverRes.error)
    ? []
    : (leftoverRes.data ?? []).map((l) => l.source_meal || l.name);

  const chefCtx: ChefContext = {
    request, dietary, weeklyBudget, recipeNames, pantryItems, expiringItems, leftovers, busyNights,
    allergies: household.allergies, diet: household.diet, dislikes: household.dislikes,
    window: 'this week (next 7 days)',
  };

  // Deterministic fallback first, upgraded by AI when configured.
  //
  // `source` says which of three things happened, because the screen tells
  // the family different things for each: 'fallback' is "no AI provider is
  // configured", 'unavailable' is "the provider was asked and did not give a
  // usable answer". Both used to read 'fallback', so every provider error was
  // shown as "AI isn't configured — connect a provider" to a family whose AI
  // was configured.
  const aiConfigured = await isAIConfigured();
  let reply = fallbackChefReply(chefCtx, { aiConfigured });
  let source: 'ai' | 'fallback' | 'unavailable' = 'fallback';

  if (aiConfigured) {
    source = 'unavailable';
    try {
      // Two ways this surface disappoints a family and they look identical from
      // the outside: the provider throws, or it answers something
      // `parseChefReply` cannot read. Both end at `source: 'fallback'`, which is
      // also what "no API key" looks like. The wrapper sits inside the swallow
      // so the row can tell the three apart.
      const parsed = await withAiRequest(
        scopeFromUserContext(ctx, supabase),
        { feature: 'meals.chef', text: 'Recipe from the AI chef' },
        async (obs) => {
          const completion = await (await resolveProvider()).complete({
            system: buildChefSystem(),
            messages: [{ role: 'user', content: buildChefUser(chefCtx) }],
            tools: [], maxTokens: 1800,
          });
          obs.used(completion.model ?? 'unknown', completion.usage);
          const out = parseChefReply(completion.text || '');
          if (!out) obs.failed(new Error('The chef reply did not parse; fell back to the deterministic plan.'));
          return out;
        },
      );
      if (parsed) { reply = parsed; source = 'ai'; }
    } catch (error) {
      // Keep the deterministic plan, and say the AI was unavailable rather
      // than unconfigured.
      console.error('[ai/chef] provider request failed', describeReadError(error));
    }
  }

  // The prompt asks the model to honour the allergies; this checks that it
  // did. A dish or a grocery add that runs into a recorded allergy is left
  // out (an ingredient with a safe swap is swapped), whichever plan this is —
  // the deterministic one replays the family's own recipe names, and those
  // can carry an allergen too.
  const screened = screenChefReply(reply, household.allergies);
  reply = screened.reply;
  if (screened.removed > 0) reply = { ...reply, tips: [...reply.tips, t('chef.someSuggestionsLeftOutForAllergies')] };

  return NextResponse.json({
    reply,
    source,
    context: { busyNights, expiringItems, leftovers, recipeCount: recipeNames.length },
  });
}
