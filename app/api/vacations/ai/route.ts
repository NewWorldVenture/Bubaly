import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { resolveProvider } from '@/lib/ai/provider';
import { summarizeBudget } from '@/lib/vacations/budget';
import { detectConflicts, type ItemLike } from '@/lib/vacations/conflicts';
import { tripWeatherAdvice, type WeatherDayLike } from '@/lib/vacations/weather';
import { suggestPacking } from '@/lib/vacations/packing';
import { tripNights, dateRange } from '@/lib/vacations/dates';

export const runtime = 'nodejs';

type Body = { action: 'concierge' | 'build' | 'recommendations'; vacationId: string; conversationId?: string; message?: string; prompt?: string };

export async function POST(req: NextRequest) {
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-vacations:${ctx.user.id}`, { limit: 20 });
  if (!limited.ok) return NextResponse.json(
    { error: 'Too many trip AI requests. Please try again shortly.' },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const body = await req.json().catch(() => ({})) as Body;
  const { action, vacationId } = body;
  if (!vacationId) return NextResponse.json({ error: 'Missing vacationId' }, { status: 400 });

  const familyId = ctx.active.familyId;
  const { data: trip } = await supabase.from('vacations').select('*').eq('id', vacationId).maybeSingle();
  if (!trip) return NextResponse.json({ error: 'Trip not found' }, { status: 404 });

  // Gather trip context (all RLS-scoped).
  const [members, lodging, flights, transport, activities, reservations, budgets, expenses, packing, docs, emergency, days, items, weather] = await Promise.all([
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
    await supabase.from('vacation_ai_recommendations').delete().eq('vacation_id', vacationId).eq('source', 'rules').eq('status', 'open');
    if (recos.length) {
      await supabase.from('vacation_ai_recommendations').insert(recos.map((x) => ({ family_id: familyId, vacation_id: vacationId, kind: x.kind as never, title: x.title, detail: x.detail, severity: x.severity, source: 'rules', created_by: ctx!.user.id })));
    }
    return NextResponse.json({ count: recos.length });
  }

  // ---------- BUILD (AI vacation builder) ----------
  if (action === 'build') {
    const system = `You are an expert family travel agent. Produce a realistic, family-friendly plan as STRICT JSON only (no prose, no markdown). Schema:
{"activities":[{"name":string,"category":string,"location":string,"family_friendly":boolean,"cost":number}],
"itinerary":[{"day":number,"day_part":"morning"|"afternoon"|"evening","title":string,"kind":"activity"|"meal"|"travel"|"reservation"|"free_time"}],
"budget":[{"category":"flights"|"lodging"|"transportation"|"activities"|"food"|"shopping"|"insurance"|"fees"|"misc","planned":number}]}
Costs/planned are whole US dollars. Keep itinerary within the trip's day count. Balance activities with downtime for kids.`;
    const user = `Trip: ${trip.title}. Destination: ${trip.destination ?? 'unspecified'}. Type: ${trip.kind}. Nights: ${nights}. Travelers: ${m.length} (${hasChildren ? 'includes children' : 'adults'}). Budget: ${trip.budget_cents ? `$${trip.budget_cents / 100}` : 'flexible'}. ${body.prompt ? `Preferences: ${body.prompt}` : ''}`;

    let plan: { activities?: { name: string; category?: string; location?: string; family_friendly?: boolean; cost?: number }[]; itinerary?: { day: number; day_part: string; title: string; kind: string }[]; budget?: { category: string; planned: number }[] };
    try {
      const provider = await resolveProvider();
      const completion = await provider.complete({ system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 2000 });
      const jsonText = completion.text.slice(completion.text.indexOf('{'), completion.text.lastIndexOf('}') + 1);
      plan = JSON.parse(jsonText);
    } catch (err) {
      console.error('Vacation build error:', err);
      return NextResponse.json({ error: 'AI builder is temporarily unavailable.' }, { status: 502 });
    }

    let added = { activities: 0, items: 0, budget: 0, packing: 0 };
    // activities
    if (Array.isArray(plan.activities) && plan.activities.length) {
      const rows = plan.activities.slice(0, 30).map((x) => ({ family_id: familyId, vacation_id: vacationId, name: String(x.name).slice(0, 200), category: x.category ?? null, location: x.location ?? null, family_friendly: x.family_friendly ?? true, cost_cents: x.cost ? Math.round(x.cost * 100) : null, created_by: ctx!.user.id }));
      await supabase.from('vacation_activities').insert(rows);
      added.activities = rows.length;
    }
    // itinerary — ensure days exist, map day number -> day_id
    if (Array.isArray(plan.itinerary) && plan.itinerary.length && trip.start_date && trip.end_date) {
      const range = dateRange(trip.start_date, trip.end_date);
      const existing = new Map((days.data ?? []).map((d) => [d.day_date, d.id]));
      const toCreate = range.filter((d) => !existing.has(d)).map((d) => ({ family_id: familyId, vacation_id: vacationId, day_date: d, created_by: ctx!.user.id }));
      if (toCreate.length) {
        const { data: created } = await supabase.from('vacation_itinerary_days').insert(toCreate).select('id, day_date');
        for (const d of created ?? []) existing.set(d.day_date, d.id);
      }
      const dayIds = range.map((d) => existing.get(d)).filter(Boolean) as string[];
      const validParts = new Set(['morning', 'afternoon', 'evening', 'all_day']);
      const validKinds = new Set(['activity', 'meal', 'travel', 'reservation', 'free_time', 'note', 'reminder']);
      const rows = plan.itinerary.slice(0, 60).map((x) => ({
        family_id: familyId, vacation_id: vacationId,
        day_id: dayIds[Math.max(0, Math.min(dayIds.length - 1, (x.day || 1) - 1))] ?? null,
        day_part: (validParts.has(x.day_part) ? x.day_part : 'morning') as never,
        kind: (validKinds.has(x.kind) ? x.kind : 'activity') as never,
        title: String(x.title).slice(0, 200), created_by: ctx!.user.id,
      })).filter((x) => x.day_id);
      if (rows.length) { await supabase.from('vacation_itinerary_items').insert(rows); added.items = rows.length; }
    }
    // budget
    if (Array.isArray(plan.budget) && plan.budget.length) {
      const validCats = new Set(['flights', 'lodging', 'transportation', 'activities', 'food', 'shopping', 'insurance', 'fees', 'misc']);
      const rows = plan.budget.filter((x) => validCats.has(x.category)).map((x) => ({ family_id: familyId, vacation_id: vacationId, category: x.category as never, planned_cents: Math.max(0, Math.round((x.planned || 0) * 100)), created_by: ctx!.user.id }));
      if (rows.length) { await supabase.from('vacation_budgets').upsert(rows, { onConflict: 'vacation_id,category' }); added.budget = rows.length; }
    }
    // packing (rule-based, always solid)
    const master = (packing.data ?? []).length ? null : await supabase.from('vacation_packing_lists').insert({ family_id: familyId, vacation_id: vacationId, name: 'Master list', is_master: true, created_by: ctx!.user.id }).select('id').single();
    const listId = master?.data?.id;
    if (listId) {
      const sugg = suggestPacking({ kind: trip.kind, nights: nights || 5, isInternational: trip.is_international, hasChildren, hasBaby: false, activities: a.map((x) => x.name) });
      const rows = sugg.map((s) => ({ family_id: familyId, vacation_id: vacationId, list_id: listId, name: s.name, category: s.category as never, quantity: s.quantity, ai_suggested: true, created_by: ctx!.user.id }));
      if (rows.length) { await supabase.from('vacation_packing_items').insert(rows); added.packing = rows.length; }
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
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      conversationId = convo.id;
    }
    await supabase.from('vacation_ai_messages').insert({ family_id: familyId, conversation_id: conversationId, role: 'user', content: message, created_by: ctx.user.id });

    const { data: history } = await supabase.from('vacation_ai_messages').select('role, content').eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(20);

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
      const provider = await resolveProvider();
      const completion = await provider.complete({
        system,
        messages: (history ?? []).filter((h) => h.role === 'user' || h.role === 'assistant').map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
        tools: [], maxTokens: 1000,
      });
      reply = completion.text || 'Sorry, I could not generate a reply.';
    } catch (err) {
      console.error('Concierge error:', err);
      return NextResponse.json({ error: 'AI is temporarily unavailable.' }, { status: 502 });
    }

    await supabase.from('vacation_ai_messages').insert({ family_id: familyId, conversation_id: conversationId, role: 'assistant', content: reply, created_by: ctx.user.id });
    return NextResponse.json({ conversationId, reply });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
