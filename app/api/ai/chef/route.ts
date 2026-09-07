import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { isMissingTableError } from '@/lib/supabase/errors';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';
import { expiringSoon } from '@/lib/pantry/logic';
import {
  buildChefSystem, buildChefUser, parseChefReply, fallbackChefReply, type ChefContext,
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
  const limited = await enforceAIRateLimit(supabase, `ai-chef:${ctx.user.id}`, { limit: 15 });
  if (!limited.ok) return NextResponse.json(
    { error: t('chef.tooManyChefRequestsPlease') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );
  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 86400000).toISOString();

  // Gather real family context in parallel.
  const [recipesRes, pantryRes, eventsRes, leftoverRes] = await settleAll([
    supabase.from('family_recipes').select('name').eq('family_id', familyId).order('is_favorite', { ascending: false }).limit(40),
    supabase.from('pantry_items').select('name, expires_at').eq('family_id', familyId).limit(200),
    supabase.from('calendar_events').select('title, starts_at, category').eq('family_id', familyId)
      .gte('starts_at', now.toISOString()).lte('starts_at', weekAhead).order('starts_at').limit(40),
    supabase.from('leftover_inventory').select('name, source_meal, use_by').eq('family_id', familyId).eq('status', 'fresh').limit(20),
  ]);

  const recipeNames = (recipesRes.data ?? []).map((r) => r.name);
  const pantry = pantryRes.data ?? [];
  const pantryItems = pantry.map((p) => p.name);
  const expiringItems = expiringSoon(pantry, 7).map((p) => p.name).slice(0, 15);

  // Busy evenings (events after 4pm) become "keep it quick" signals.
  const dayShort = (iso: string) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short' });
  const busyNights = (eventsRes.data ?? [])
    .filter((e) => new Date(e.starts_at).getHours() >= 16)
    .map((e) => `${dayShort(e.starts_at)}: ${e.title}`)
    .slice(0, 10);

  // Leftovers (table may not be migrated yet → empty).
  const leftovers = isMissingTableError(leftoverRes.error)
    ? []
    : (leftoverRes.data ?? []).map((l) => l.source_meal || l.name);

  const chefCtx: ChefContext = {
    request, dietary, weeklyBudget, recipeNames, pantryItems, expiringItems, leftovers, busyNights,
    window: 'this week (next 7 days)',
  };

  // Deterministic fallback first, upgraded by AI when configured.
  let reply = fallbackChefReply(chefCtx);
  let source: 'ai' | 'fallback' = 'fallback';

  if (await isAIConfigured()) {
    try {
      // Two ways this surface disappoints a family and they look identical from
      // the outside: the provider throws, or it answers something
      // `parseChefReply` cannot read. Both end at `source: 'fallback'`, which is
      // also what "no API key" looks like. The wrapper sits inside the swallow
      // so the row can tell the three apart.
      const parsed = await withAiRequest(
        scopeFromUserContext(ctx, supabase),
        { feature: 'meals.chef', text: request.slice(0, 200) },
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
    } catch {
      // keep fallback
    }
  }

  return NextResponse.json({
    reply,
    source,
    context: { busyNights, expiringItems, leftovers, recipeCount: recipeNames.length },
  });
}
