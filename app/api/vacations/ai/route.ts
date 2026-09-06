import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { resolveProvider } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { summarizeBudget } from '@/lib/vacations/budget';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';
import { detectConflicts, type ItemLike } from '@/lib/vacations/conflicts';
import { tripWeatherAdvice, type WeatherDayLike } from '@/lib/vacations/weather';
import { suggestPacking } from '@/lib/vacations/packing';
import { tripNights, dateRange } from '@/lib/vacations/dates';
import { parseVacationAIOutput, type VacationAIPlan } from '@/lib/vacations/ai-output';

export const runtime = 'nodejs';

type Body = { action: 'concierge' | 'build' | 'recommendations'; vacationId: string; conversationId?: string; message?: string; prompt?: string };

const databaseUnavailable = (message: string) => NextResponse.json({ error: message }, { status: 503 });

function logDatabaseFailure(operation: string, error: unknown) {
  console.error(`[vacation-ai] ${operation} failed:`, error);
}

export async function POST(req: NextRequest) {
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-vacations:${ctx.user.id}`, { limit: 20 });
  if (!limited.ok) return NextResponse.json(
    { error: 'Too many trip AI requests. Please try again shortly.' },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: 'Request body is too large.' }, { status: 400 });
  const body = (boundedBody.value ?? {}) as Body;
  const { action, vacationId } = body;
  if (!vacationId) return NextResponse.json({ error: 'Missing vacationId' }, { status: 400 });

  const familyId = ctx.active.familyId;
  const { data: trip, error: tripError } = await supabase.from('vacations').select('*').eq('id', vacationId).eq('family_id', familyId).maybeSingle();
  if (tripError) {
    logDatabaseFailure('trip context read', tripError);
    return databaseUnavailable('Trip data is temporarily unavailable.');
  }
  if (!trip) return NextResponse.json({ error: 'Trip not found' }, { status: 404 });

  // Gather trip context (all RLS-scoped).
  const contextResults = await Promise.all([
    supabase.from('vacation_members').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_lodging').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_flights').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_transportation').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_activities').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_reservations').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_budgets').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_expenses').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_packing_items').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_documents').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_emergency_contacts').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_itinerary_days').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_itinerary_items').select('*').eq('vacation_id', vacationId),
    supabase.from('vacation_weather_snapshots').select('*').eq('vacation_id', vacationId),
  ]);
  const contextError = contextResults.find((result) => result.error)?.error;
  if (contextError) {
    logDatabaseFailure('trip context read', contextError);
    return databaseUnavailable('Trip data is temporarily unavailable.');
  }
  const [members, lodging, flights, transport, activities, reservations, budgets, expenses, packing, docs, emergency, days, items, weather] = contextResults;

  const m = members.data ?? [], a = activities.data ?? [], r = reservations.data ?? [];
  const hasChildren = m.some((x) => x.role === 'child');
  const nights = tripNights(trip.start_date, trip.end_date) ?? 0;

  // ---------- RECOMMENDATIONS (rule-based, reliable) ----------
  if (action === 'recommendations') {
    const recos: { kind: string; title: string; detail: string; severity: number }[] = [];
    if ((lodging.data ?? []).length === 0) recos.push({ kind: 'missing_reservation', title: 'No lodging booked', detail: 'Add where your family is staying.', severity: 3 });
    if ((flights.data ?? []).length === 0 && (transport.data ?? []).length === 0) recos.push({ kind: 'missing_reservation', title: 'No transportation', detail: 'Add flights or how you will get around.', severity: 2 });
    const unbookedRes = r.filter((x) => !x.booked).length;
    if (unbookedRes > 0) recos.push({ kind: 'missing_reservation', title: `${unbookedRes} reservation(s) not confirmed`, detail: 'Confirm dining and activity reservations.', severity: 1 });
    if (trip.is_international && (docs.data ?? []).filter((d) => d.kind === 'passport').length < m.length) recos.push({ kind: 'document_missing', title: 'Passports missing', detail: 'Upload a passport for each traveler.', severity: 3 });
    if ((emergency.data ?? []).length < 2) recos.push({ kind: 'suggestion', title: 'Add emergency contacts', detail: 'Store a doctor, insurance, and local emergency number.', severity: 1 });

    const budgetSummary = summarizeBudget(budgets.data ?? [], expenses.data ?? []);
    for (const over of budgetSummary.categories.filter((c) => c.over)) recos.push({ kind: 'budget_warning', title: `Over budget: ${over.category}`, detail: `Spent ${(over.spent_cents / 100).toFixed(0)} vs planned ${(over.planned_cents / 100).toFixed(0)}.`, severity: 2 });

    const dayById = new Map((days.data ?? []).map((d) => [d.id, d]));
    const conflicts = detectConflicts((items.data ?? []).map((it): ItemLike => ({ id: it.id, day_id: it.day_id, day_date: it.day_id ? dayById.get(it.day_id)?.day_date ?? null : null, kind: it.kind, day_part: it.day_part, title: it.title, start_time: it.start_time, end_time: it.end_time })), { hasYoungChildren: hasChildren });
    for (const c of conflicts.slice(0, 5)) recos.push({ kind: 'travel_conflict', title: c.title, detail: c.detail, severity: c.severity });

    for (const w of tripWeatherAdvice((weather.data ?? []) as WeatherDayLike[])) recos.push({ kind: 'weather_warning', title: 'Weather advisory', detail: w.text, severity: w.severity });

    // Replace prior rule-sourced open recommendations.
    const { error: deleteError } = await supabase.from('vacation_ai_recommendations').delete().eq('vacation_id', vacationId).eq('source', 'rules').eq('status', 'open');
    if (deleteError) {
      logDatabaseFailure('recommendation cleanup', deleteError);
      return databaseUnavailable('Recommendations are temporarily unavailable.');
    }
    if (recos.length) {
      const { error: insertError } = await supabase.from('vacation_ai_recommendations').insert(recos.map((x) => ({ family_id: familyId, vacation_id: vacationId, kind: x.kind as never, title: x.title, detail: x.detail, severity: x.severity, source: 'rules', created_by: ctx!.user.id })));
      if (insertError) {
        logDatabaseFailure('recommendation write', insertError);
        return databaseUnavailable('Recommendations are temporarily unavailable.');
      }
    }
    return NextResponse.json({ count: recos.length });
  }

  // ---------- BUILD (AI vacation builder) ----------
  if (action === 'build') {
    const range = trip.start_date && trip.end_date ? dateRange(trip.start_date, trip.end_date) : [];
    const system = `You are an expert family travel agent. Produce a realistic, family-friendly plan as STRICT JSON only (no prose, no markdown). Schema:
{"activities":[{"name":string,"category":string,"location":string,"family_friendly":boolean,"cost":number}],
"itinerary":[{"day":number,"day_part":"morning"|"afternoon"|"evening","title":string,"kind":"activity"|"meal"|"travel"|"reservation"|"free_time"}],
"budget":[{"category":"flights"|"lodging"|"transportation"|"activities"|"food"|"shopping"|"insurance"|"fees"|"misc","planned":number}]}
Costs/planned are whole US dollars. Keep itinerary day numbers between 1 and ${range.length}; if there are no dated days, return an empty itinerary. Use at most 30 activities, 60 itinerary items, and 9 budget entries. These are suggestions and cost estimates, not verified prices, availability, or bookings. Balance activities with downtime for kids.`;
    const user = `Trip: ${trip.title}. Destination: ${trip.destination ?? 'unspecified'}. Type: ${trip.kind}. Nights: ${nights}. Travelers: ${m.length} (${hasChildren ? 'includes children' : 'adults'}). Budget: ${trip.budget_cents ? `$${trip.budget_cents / 100}` : 'flexible'}. ${body.prompt ? `Preferences: ${body.prompt}` : ''}`;

    let plan: VacationAIPlan;
    try {
      const built = await withAiRequest(
        scopeFromUserContext(ctx, supabase),
        { feature: 'vacations.build', text: `Build a plan for ${nights} nights` },
        async (obs) => {
          const provider = await resolveProvider();
          const completion = await provider.complete({ system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 2000 });
          obs.used(provider.model, completion.usage);
          const validated = parseVacationAIOutput(completion.text, range.length);
          if (!validated) obs.failed(new Error('The trip plan did not validate against the requested day count.'));
          return validated;
        },
      );
      if (!built) return NextResponse.json({ error: 'AI builder returned an invalid trip plan. Please try again.' }, { status: 502 });
      plan = built;
    } catch (err) {
      console.error('Vacation build error:', err);
      return NextResponse.json({ error: 'AI builder is temporarily unavailable.' }, { status: 502 });
    }

    let added = { activities: 0, items: 0, budget: 0, packing: 0 };
    const createdActivityIds: string[] = [];
    const createdDayIds: string[] = [];
    const createdItemIds: string[] = [];
    const createdBudgetIds: string[] = [];
    const changedBudgetCategories: NonNullable<typeof budgets.data>[number]['category'][] = [];
    const createdPackingItemIds: string[] = [];
    let createdPackingListId: string | null = null;
    const originalBudgets = new Map((budgets.data ?? []).map((row) => [row.category, {
      id: row.id,
      planned_cents: row.planned_cents,
      notes: row.notes,
      created_by: row.created_by,
    }]));

    const removeRows = async (
      table: 'vacation_activities' | 'vacation_itinerary_days' | 'vacation_itinerary_items' | 'vacation_budgets' | 'vacation_packing_items' | 'vacation_packing_lists',
      ids: string[],
    ) => {
      if (!ids.length) return;
      const { error } = await supabase.from(table).delete().eq('vacation_id', vacationId).in('id', ids);
      if (error) logDatabaseFailure(`build rollback ${table}`, error);
    };

    const rollbackBuild = async () => {
      await removeRows('vacation_packing_items', createdPackingItemIds);
      if (createdPackingListId) await removeRows('vacation_packing_lists', [createdPackingListId]);
      await removeRows('vacation_itinerary_items', createdItemIds);
      await removeRows('vacation_itinerary_days', createdDayIds);
      await removeRows('vacation_activities', createdActivityIds);
      await removeRows('vacation_budgets', createdBudgetIds);
      for (const category of changedBudgetCategories) {
        const previous = originalBudgets.get(category);
        if (!previous) continue;
        const { error } = await supabase.from('vacation_budgets').update({ planned_cents: previous.planned_cents, notes: previous.notes }).eq('id', previous.id).eq('vacation_id', vacationId);
        if (error) logDatabaseFailure('build rollback vacation_budgets restore', error);
      }
    };

    const buildFailure = async (message: string, error?: unknown) => {
      if (error) logDatabaseFailure('build persistence', error);
      await rollbackBuild();
      return databaseUnavailable(message);
    };

    // activities
    if (plan.activities.length) {
      const rows = plan.activities.map((x) => ({ family_id: familyId, vacation_id: vacationId, name: x.name, category: x.category ?? null, location: x.location ?? null, family_friendly: x.family_friendly ?? true, cost_cents: x.cost == null ? null : Math.round(x.cost * 100), created_by: ctx!.user.id }));
      const { data, error } = await supabase.from('vacation_activities').insert(rows).select('id');
      if (data) createdActivityIds.push(...data.map((row) => row.id));
      if (error || !data || data.length !== rows.length) return buildFailure('Could not save the generated trip plan.', error ?? new Error('Activity insert returned an incomplete result.'));
      added.activities = rows.length;
    }
    // itinerary — ensure days exist, map day number -> day_id
    if (plan.itinerary.length) {
      const existing = new Map((days.data ?? []).map((d) => [d.day_date, d.id]));
      const toCreate = range.filter((d) => !existing.has(d)).map((d) => ({ family_id: familyId, vacation_id: vacationId, day_date: d, created_by: ctx!.user.id }));
      if (toCreate.length) {
        const { data: created, error } = await supabase.from('vacation_itinerary_days').insert(toCreate).select('id, day_date');
        if (created) createdDayIds.push(...created.map((day) => day.id));
        if (error || !created || created.length !== toCreate.length) return buildFailure('Could not save the generated trip plan.', error ?? new Error('Itinerary day insert returned an incomplete result.'));
        for (const d of created) {
          existing.set(d.day_date, d.id);
        }
      }
      const dayIds = range.map((d) => existing.get(d)).filter(Boolean) as string[];
      if (dayIds.length !== range.length) return buildFailure('Could not save the generated trip plan.', new Error('Itinerary days could not be resolved.'));
      const rows = plan.itinerary.map((x) => ({
        family_id: familyId, vacation_id: vacationId,
        day_id: dayIds[x.day - 1],
        day_part: x.day_part,
        kind: x.kind,
        title: x.title, created_by: ctx!.user.id,
      })).filter((x) => x.day_id);
      if (rows.length) {
        const { data, error } = await supabase.from('vacation_itinerary_items').insert(rows).select('id');
        if (data) createdItemIds.push(...data.map((row) => row.id));
        if (error || !data || data.length !== rows.length) return buildFailure('Could not save the generated trip plan.', error ?? new Error('Itinerary item insert returned an incomplete result.'));
        added.items = rows.length;
      }
    }
    // budget
    if (plan.budget.length) {
      const rows = [...new Map(plan.budget.map((x) => [x.category, { family_id: familyId, vacation_id: vacationId, category: x.category, planned_cents: Math.round(x.planned * 100), created_by: ctx!.user.id }])).values()];
      if (rows.length) {
        const { data, error } = await supabase.from('vacation_budgets').upsert(rows, { onConflict: 'vacation_id,category' }).select('id, category');
        for (const row of data ?? []) {
          if (originalBudgets.has(row.category)) changedBudgetCategories.push(row.category);
          else createdBudgetIds.push(row.id);
        }
        if (error || !data || data.length !== rows.length) return buildFailure('Could not save the generated trip plan.', error ?? new Error('Budget upsert returned an incomplete result.'));
        added.budget = rows.length;
      }
    }
    // packing (rule-based, always solid)
    const master = (packing.data ?? []).length ? null : await supabase.from('vacation_packing_lists').insert({ family_id: familyId, vacation_id: vacationId, name: 'Master list', is_master: true, created_by: ctx!.user.id }).select('id').single();
    const listId = master?.data?.id;
    if (listId) createdPackingListId = listId;
    if (master?.error) return buildFailure('Could not save the generated trip plan.', master.error);
    if (listId) {
      const sugg = suggestPacking({ kind: trip.kind, nights: nights || 5, isInternational: trip.is_international, hasChildren, hasBaby: false, activities: a.map((x) => x.name) });
      const rows = sugg.map((s) => ({ family_id: familyId, vacation_id: vacationId, list_id: listId, name: s.name, category: s.category as never, quantity: s.quantity, ai_suggested: true, created_by: ctx!.user.id }));
      if (rows.length) {
        const { data, error } = await supabase.from('vacation_packing_items').insert(rows).select('id');
        if (data) createdPackingItemIds.push(...data.map((row) => row.id));
        if (error || !data || data.length !== rows.length) return buildFailure('Could not save the generated trip plan.', error ?? new Error('Packing insert returned an incomplete result.'));
        added.packing = rows.length;
      }
    }

    return NextResponse.json({ ok: true, added });
  }

  // ---------- CONCIERGE (chat) ----------
  if (action === 'concierge') {
    const message = body.message?.trim();
    if (!message) return NextResponse.json({ error: 'Empty message' }, { status: 400 });

    let conversationId = body.conversationId;
    if (!conversationId) {
      const { data: convo, error } = await supabase.from('vacation_ai_conversations').insert({ family_id: familyId, vacation_id: vacationId, title: message.slice(0, 60), created_by: ctx.user.id }).select('id').single();
      if (error) {
        console.error('Vacation AI conversation write failed:', error);
        return databaseUnavailable('Could not start the trip conversation.');
      }
      conversationId = convo.id;
    } else {
      const { data: conversation, error } = await supabase.from('vacation_ai_conversations').select('id').eq('id', conversationId).eq('family_id', familyId).eq('vacation_id', vacationId).maybeSingle();
      if (error) {
        logDatabaseFailure('conversation ownership read', error);
        return databaseUnavailable('Trip conversation is temporarily unavailable.');
      }
      if (!conversation) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }
    const { error: userMessageError } = await supabase.from('vacation_ai_messages').insert({ family_id: familyId, conversation_id: conversationId, role: 'user', content: message, created_by: ctx.user.id }).select('id').single();
    if (userMessageError) {
      logDatabaseFailure('user message write', userMessageError);
      return databaseUnavailable('Could not save your message.');
    }

    const { data: history, error: historyError } = await supabase.from('vacation_ai_messages').select('role, content').eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(20);
    if (historyError) {
      logDatabaseFailure('conversation history read', historyError);
      return databaseUnavailable('Trip conversation is temporarily unavailable.');
    }

    const budgetSummary = summarizeBudget(budgets.data ?? [], expenses.data ?? []);
    const context = `TRIP CONTEXT
Title: ${trip.title} | Destination: ${trip.destination ?? '—'} | Type: ${trip.kind} | Dates: ${trip.start_date ?? '?'} to ${trip.end_date ?? '?'} (${nights} nights)
Travelers: ${m.length}${hasChildren ? ' (with children)' : ''}
Lodging: ${(lodging.data ?? []).length} | Flights: ${(flights.data ?? []).length} | Ground transport: ${(transport.data ?? []).length}
Activities: ${a.length} | Reservations: ${r.length}
Budget planned: $${(budgetSummary.planned_cents / 100).toFixed(0)} | spent: $${(budgetSummary.spent_cents / 100).toFixed(0)}
Itinerary days planned: ${(days.data ?? []).length} | items: ${(items.data ?? []).length}`;

    const system = `You are Bubaly's friendly, expert family Vacation Concierge. Give concise, practical, family-aware advice for THIS trip using the context. Suggest specific activities, restaurants, packing, budgeting, and routing. When asked to build/plan, give a clear day-by-day outline. Keep replies focused and warm. Use the family's actual trip details.\n\n${context}`;

    let reply: string;
    try {
      reply = await withAiRequest(
        scopeFromUserContext(ctx, supabase),
        { feature: 'vacations.concierge', text: 'Vacation concierge reply' },
        async (obs) => {
          const provider = await resolveProvider();
          const completion = await provider.complete({
            system,
            messages: (history ?? []).filter((h) => h.role === 'user' || h.role === 'assistant').map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
            tools: [], maxTokens: 1000,
          });
          obs.used(provider.model, completion.usage);
          // The apology is persisted to vacation_ai_messages as if it were an
          // answer, so without a row the conversation keeps a polite non-reply
          // and nothing says why.
          if (!completion.text) obs.failed(new Error('The concierge returned no text; the apology was stored instead.'));
          return completion.text || 'Sorry, I could not generate a reply.';
        },
      );
    } catch (err) {
      console.error('Concierge error:', err);
      return NextResponse.json({ error: 'AI is temporarily unavailable.' }, { status: 502 });
    }

    const { error: assistantMessageError } = await supabase.from('vacation_ai_messages').insert({ family_id: familyId, conversation_id: conversationId, role: 'assistant', content: reply, created_by: ctx.user.id }).select('id').single();
    if (assistantMessageError) {
      logDatabaseFailure('assistant message write', assistantMessageError);
      return databaseUnavailable('Could not save the concierge reply.');
    }
    return NextResponse.json({ conversationId, reply });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
