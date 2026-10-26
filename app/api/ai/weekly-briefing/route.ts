import { NextRequest, NextResponse } from 'next/server';
import { refuseOverAIAllowance } from '@/lib/server/ai-access';
import { instantCalendarBounds } from '@/lib/briefing/calendar-window';
import { readCalendarOccurrences } from '@/lib/calendar/occurrences';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { readVisibleReminders, reminderCardsReader } from '@/lib/autopilot/reminder-cards';
import { requireUserContext } from '@/lib/supabase/auth';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { weekWindow, weekRangeLabel, choreCompletionRate, bucketByDay, dayLoad } from '@/lib/ai/weekly';
import { dayKeyInZone } from '@/lib/schedule/zoned';
import { resolveProvider, isAIConfigured, describeAIError } from '@/lib/ai/provider';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';
import { openGroceryListIds } from '@/lib/services/groceries';

/**
 * The model's reply as a briefing, or null when it is not one: no text, no
 * JSON object in it (a fenced object is fine), JSON that does not parse, or an
 * object with neither a headline nor any day of the week.
 */
function usableWeeklyBriefing(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(jsonMatch[0]); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const reply = parsed as Record<string, unknown>;
  const headline = typeof reply.headline === 'string' && reply.headline.trim().length > 0;
  const days = Array.isArray(reply.dayByDay) && reply.dayByDay.length > 0;
  return headline || days ? reply : null;
}

/**
 * Plus-tier Weekly AI Briefing. Distinct from the daily briefing: it reads a
 * full 7-day look-ahead AND a 7-day recap of the week just gone, so the model
 * can both prep the week ahead and reflect on what got done.
 */
export async function POST(req: NextRequest) {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const { familyId } = ctx.active;
    const supabase = await createServer();

    // The page's own gate, here too (the endpoint is independently reachable):
    // the admin-overridable tier the page resolves, its Off switch and a
    // lapsed trial included. A bare "plan level below 2" check let a Family+
    // POST past a feature switched Off, and refused every call a lowered
    // tier's page offered. A plan below the tier stays a 402, so the client
    // can prompt an upgrade.
    const refused = await refuseUnlessEntitled(supabase, familyId, ['/dashboard/weekly-briefing']);
    if (refused) {
      const body = await refused.clone().json().catch(() => null) as { code?: string } | null;
      if (body?.code === 'plan_required') return NextResponse.json({ error: t('weeklyBriefing.weeklyAiBriefingIsA') }, { status: 402 });
      return refused;
    }
    // With no key the provider threw "not configured" and the catch below
    // answered a generic 500; the other AI routes say so with a 503 first.
    if (!(await isAIConfigured())) return NextResponse.json({ error: t('ai.theAiEngineIsnT'), code: 'not_configured' }, { status: 503 });
    const limited = await enforceAIRateLimit(supabase, `ai-weekly-briefing:${ctx.user.id}`, { limit: 5 });
    if (!limited.ok) return NextResponse.json(
      { error: t('weeklyBriefing.tooManyWeeklyBriefingRequests') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: t('weeklyBriefing.requestBodyIsTooLarge') }, { status: 400 });

    const now = new Date();
    // The family's week, not Greenwich's. Until this was passed, a 21:00 Saturday
    // game in Los Angeles (04:00 Sunday UTC) appeared under SUNDAY in the grid,
    // and the week ran 17:00 Sunday to 17:00 Sunday.
    const tz = ctx.active.family.timezone || 'UTC';
    const w = weekWindow(now, tz);

    const [
      { data: members, error: membersError },
      { data: aheadEvents, error: aheadEventsError },
      { data: schoolEvents, error: schoolError },
      { data: sportsEvents, error: sportsError },
      { data: appointments, error: appointmentsError },
      { data: choresDueAhead, error: choresAheadError },
      { data: mealPlans, error: mealPlansError },
      groceryResult,
      { data: reminders, error: remindersError },
      { data: recapChores, error: recapChoresError },
      { data: recapEvents, error: recapEventsError },
    ] = await settleAll([
      supabase.from('family_members').select('id, display_name, role').eq('family_id', familyId).eq('is_active', true),
      // Series included, so the week grid shows every week of a weekly event (lib/calendar/occurrences.ts).
      readCalendarOccurrences(supabase, familyId, instantCalendarBounds(w.aheadStart, w.aheadEnd, tz), tz, { columns: ['title', 'starts_at', 'ends_at', 'location', 'category', 'assignee_id'], limit: 60 }),
      supabase.from('school_events').select('title, starts_at, event_type, notes, member_id').eq('family_id', familyId).gte('starts_at', w.aheadStart).lte('starts_at', w.aheadEnd).order('starts_at').limit(20),
      supabase.from('sports_events').select('title, starts_at, sport, team, location, member_id').eq('family_id', familyId).gte('starts_at', w.aheadStart).lte('starts_at', w.aheadEnd).order('starts_at').limit(20),
      supabase.from('appointments').select('title, starts_at, provider, location, member_id').eq('family_id', familyId).gte('starts_at', w.aheadStart).lte('starts_at', w.aheadEnd).order('starts_at').limit(15),
      supabase.from('chore_assignments').select('status, due_at, member_id').eq('family_id', familyId).gte('due_at', w.aheadStart).lte('due_at', w.aheadEnd),
      supabase.from('meal_plans').select('plan_date, meal_type, meals(name)').eq('family_id', familyId).gte('plan_date', w.days[0]).lte('plan_date', w.days[w.days.length - 1]).order('plan_date').limit(21),
      // Only items on a list the family has not archived (openGroceryListIds).
      (async () => {
        const lists = await openGroceryListIds(supabase, familyId);
        if (!lists.ok) return { data: null, error: lists.error };
        return supabase.from('grocery_items').select('name, category').eq('family_id', familyId).in('list_id', lists.ids).eq('is_checked', false).limit(20);
      })(),
      // Only the reminders this reader may be told (lib/autopilot/reminder-cards.ts):
      // one an Autopilot card made follows the card — "Renew Passport" is not a
      // guest's, a policy's renewal is the managers' and its member's.
      readVisibleReminders((from, to) => supabase.from('reminders').select('id, title, notes, remind_at, related_type, related_id')
        .eq('family_id', familyId).eq('is_done', false).lte('remind_at', w.aheadEnd).order('remind_at').order('id').range(from, to),
      { limit: 12, viewer: { role: ctx.active.role, memberId: ctx.active.member?.id ?? null }, cards: reminderCardsReader(supabase, familyId, {
        onError: (error) => console.error('[weekly-briefing] autopilot reminder cards read failed', error),
      }) }),
      supabase.from('chore_assignments').select('status, due_at, member_id').eq('family_id', familyId).gte('due_at', w.recapStart).lte('due_at', w.recapEnd),
      readCalendarOccurrences(supabase, familyId, instantCalendarBounds(w.recapStart, w.recapEnd, tz), tz, { columns: ['title', 'starts_at', 'category'], limit: 40 }),
    ]);

    // A grocery list that could not be read is unavailable, not "- none" still
    // needed. A returned error and a rejected read (settled above) both arrive
    // here, before any model is asked.
    if (groceryResult.error) {
      console.error('[api/ai/weekly-briefing] grocery read failed', groceryResult.error);
      return NextResponse.json({ error: t('weeklyBriefing.failedToGenerateWeeklyBriefing') }, { status: 503 });
    }
    // The same for the chores: a failed read was "0% completion of 0
    // assignments", which the prompt then ordered the recap to repeat.
    if (choresAheadError || recapChoresError) {
      console.error('[api/ai/weekly-briefing] chore read failed', choresAheadError ?? recapChoresError);
      return NextResponse.json({ error: t('weeklyBriefing.failedToGenerateWeeklyBriefing') }, { status: 503 });
    }
    // And every other read the brief is built from. A calendar, school,
    // sports, appointments, meals, reminders or members read that failed
    // reached the prompt as "nothing scheduled" and "- none", and the model
    // wrote a light, low-stress week at 200 that the page then kept for the
    // day. A week Bubaly could not read is unavailable, never an empty one.
    const failedRead = [
      ['members', membersError], ['calendar ahead', aheadEventsError], ['school', schoolError], ['sports', sportsError],
      ['appointments', appointmentsError], ['meals', mealPlansError], ['reminders', remindersError], ['calendar recap', recapEventsError],
    ].find(([, error]) => error);
    if (failedRead) {
      console.error(`[api/ai/weekly-briefing] ${failedRead[0]} read failed`, failedRead[1]);
      return NextResponse.json({ error: t('weeklyBriefing.failedToGenerateWeeklyBriefing') }, { status: 503 });
    }
    const groceryItems = groceryResult.data;

    const memberMap = new Map((members ?? []).map((m) => [m.id, m]));
    const firstName = ctx.active.member?.display_name?.split(' ')[0] ?? 'there';
    const memberName = (id: string | null) => (id ? memberMap.get(id)?.display_name ?? null : null);

    // Per-day look-ahead buckets so the prompt can present a true week grid.
    const eventsByDay = bucketByDay(aheadEvents ?? [], (e) => e.starts_at, w.days, tz);
    // The date printed beside each line, in the family's zone.
    //
    // These were `e.starts_at.slice(0, 10)`, which is the day at GREENWICH. Binding
    // the clock below without this would have been WORSE than leaving both alone:
    // a 21:00 Saturday game in Los Angeles would have rendered its family-zone
    // clock next to Greenwich's date — "2026-06-21 9:00 PM" — two halves of one
    // line disagreeing with each other. Found by widening the third spelling into
    // tests/family-day-not-greenwich-day.test.ts, which flagged this file after the
    // rest of it had already been fixed.
    const dayOf = (iso: string) => dayKeyInZone(Date.parse(iso), tz) ?? iso.slice(0, 10);
    // The clock on each line is the family's clock. Without `timeZone` this
    // rendered in the RUNTIME's zone, which on Vercel is UTC — so the same 21:00
    // game read "4:00 AM" in a briefing addressed to the family it belongs to.
    const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
    // `dayName` stays UTC deliberately and is NOT the same case: `key` is already
    // a family day key, so it is parsed at UTC midnight purely to name its
    // weekday. Reading it in `tz` would shift a western zone back a day and
    // label Monday "Sunday" — converting a day key is the mirror defect of
    // failing to convert an instant.
    const dayName = (key: string) => new Date(`${key}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

    const dayGrid = w.days.map((key) => {
      const evs = eventsByDay[key] ?? [];
      const lines = evs.map((e) => {
        const who = memberName(e.assignee_id);
        return `    • ${fmtTime(e.starts_at)} ${e.title}${who ? ` [${who}]` : ''}${e.location ? ` @ ${e.location}` : ''}`;
      });
      return `  ${dayName(key)} ${key} (${dayLoad(evs.length)} load):\n${lines.join('\n') || '    • nothing scheduled'}`;
    }).join('\n');

    // Recap of the week just gone.
    const recapRate = choreCompletionRate((recapChores ?? []).map((c) => ({ status: c.status })));
    const aheadRate = choreCompletionRate((choresDueAhead ?? []).map((c) => ({ status: c.status })));

    const context = `
WEEK OF: ${weekRangeLabel(w)} (generated ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz })})
FAMILY: ${ctx.active.family.name}
MEMBERS: ${(members ?? []).map((m) => `${m.display_name} (${m.role})`).join(', ') || 'none'}
GENERATING FOR: ${ctx.active.member?.display_name ?? 'family'}

═══ LAST WEEK RECAP (the 7 days just ended) ═══
CHORE COMPLETION LAST WEEK: ${recapRate}% (${(recapChores ?? []).length} assignments)
EVENTS THAT HAPPENED (${(recapEvents ?? []).length}):
${(recapEvents ?? []).map((e) => `- ${dayOf(e.starts_at)} ${e.title} (${e.category})`).join('\n') || '- none logged'}

═══ THE WEEK AHEAD (next 7 days) ═══
CHORES DUE THIS WEEK: ${(choresDueAhead ?? []).length} (currently ${aheadRate}% done)
DAY-BY-DAY CALENDAR:
${dayGrid}

SCHOOL THIS WEEK:
${(schoolEvents ?? []).map((e) => `- ${dayOf(e.starts_at)} ${e.title} (${e.event_type})${memberName(e.member_id) ? ` [${memberName(e.member_id)}]` : ''}${e.notes ? ': ' + e.notes : ''}`).join('\n') || '- none'}

SPORTS THIS WEEK:
${(sportsEvents ?? []).map((e) => `- ${dayOf(e.starts_at)} ${fmtTime(e.starts_at)} ${e.title} (${e.sport})${memberName(e.member_id) ? ` [${memberName(e.member_id)}]` : ''}${e.location ? ` @ ${e.location}` : ''}`).join('\n') || '- none'}

MEDICAL APPOINTMENTS THIS WEEK:
${(appointments ?? []).map((a) => `- ${dayOf(a.starts_at)} ${fmtTime(a.starts_at)} ${a.title}${a.provider ? ` with ${a.provider}` : ''}${memberName(a.member_id) ? ` [${memberName(a.member_id)}]` : ''}`).join('\n') || '- none'}

MEAL PLANS THIS WEEK:
${(mealPlans ?? []).map((m) => {
  const meal = m as unknown as { plan_date: string; meal_type: string; meals: { name: string } | null };
  return `- ${meal.plan_date} ${meal.meal_type}: ${meal.meals?.name ?? 'TBD'}`;
}).join('\n') || '- none planned'}

GROCERIES STILL NEEDED (${(groceryItems ?? []).length}):
${(groceryItems ?? []).map((g) => `- ${g.name}${g.category ? ` (${g.category})` : ''}`).join('\n') || '- none'}

UPCOMING REMINDERS:
${(reminders ?? []).map((r) => `- ${r.remind_at ? dayOf(r.remind_at) : 'soon'}: ${r.title}`).join('\n') || '- none'}
    `.trim();

    const systemPrompt = `You are the Bubaly AI Chief of Staff producing a WEEKLY family briefing for a Family+ subscriber. Look both backward (recap) and forward (the week ahead).

IMPORTANT: Return ONLY valid JSON. No markdown, no code fences, no prose. Start with { and end with }.

Use this exact structure:
{
  "weekRange": "Jun 20 – Jun 26",
  "headline": "one punchy sentence framing the week",
  "summary": ["3-5 short bullets on what defines this week"],
  "recap": {
    "choreCompletion": 82,
    "wins": ["something that went well last week"],
    "misses": ["something that slipped"],
    "note": "one encouraging, specific sentence"
  },
  "dayByDay": [
    {"day": "Monday", "date": "Jun 23", "emoji": "📅", "load": "light|moderate|heavy", "events": [{"time": "3:00 PM", "title": "Soccer", "member": "Jackson"}]}
  ],
  "highlights": [{"category": "School", "emoji": "📚", "items": ["item 1", "item 2"]}],
  "conflicts": [{"description": "Two events overlap Thursday", "suggestion": "specific fix"}],
  "prepChecklist": [{"text": "Pack cleats", "for": "Tuesday"}],
  "weeklyScore": {
    "overall": 84,
    "categories": [
      {"label": "Schedule", "score": 80, "icon": "📅"},
      {"label": "School", "score": 90, "icon": "📚"},
      {"label": "Meals", "score": 70, "icon": "🍽️"},
      {"label": "Tasks", "score": 75, "icon": "✅"},
      {"label": "Health", "score": 100, "icon": "❤️"}
    ],
    "stressLevel": "low|moderate|high",
    "stressReason": "why",
    "focus": "the single most important thing to get right this week"
  },
  "focusOfTheWeek": "one sentence: where to put energy"
}

Rules:
- Include EVERY one of the 7 upcoming days in dayByDay, in order, even quiet ones (empty events array, load "light").
- recap.choreCompletion MUST equal the LAST WEEK chore completion % from the data.
- Detect genuine conflicts (overlaps, tight turnarounds, double-booked people).
- prepChecklist should be concrete things to do BEFORE a specific day.
- Score categories 0-100 honestly from the data; be encouraging if data is sparse but never invent events.
- Emojis: 🏥 medical, ⚽ sports, 📚 school, ✈️ travel, 🍽️ dinner, 💼 work, 🎂 birthday.`;

    // F19: the monthly AI allowance the plans sell, checked before the model runs.
    const overAllowance = await refuseOverAIAllowance(ctx, supabase);
    if (overAllowance) return overAllowance;
    const briefing = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'briefing.weekly', text: 'Generate the weekly briefing' },
      async (obs) => {
        const provider = await resolveProvider();
        const completion = await provider.complete({
          system: systemPrompt,
          messages: [{ role: 'user', content: `Generate the weekly briefing for ${firstName}.\n\nData:\n${context}` }],
          tools: [],
          maxTokens: 2600,
        });
        obs.used(completion.model ?? 'unknown', completion.usage);
        const parsed = usableWeeklyBriefing(completion.text);
        if (!parsed) {
          // An empty or refused reply, prose with no JSON, or JSON that does
          // not parse is not a briefing. It used to become one — a blank
          // `{}` recorded as a success, or an invented "being processed" week
          // scored 75 and low-stress — at 200, kept for the rest of the day.
          obs.failed(new Error('The weekly briefing reply was empty, unparseable or had neither a headline nor a day-by-day.'));
          return null;
        }
        return parsed;
      },
    );

    if (briefing === null) {
      return NextResponse.json({ error: t('weeklyBriefing.failedToGenerateWeeklyBriefing') }, { status: 502 });
    }

    return NextResponse.json({ briefing, generatedAt: new Date().toISOString(), weekKey: w.days[0] });
  } catch (err) {
    console.error('Weekly briefing error:', err);
    // An engine with no key, no credit or no connection is unavailable, not a
    // server fault behind a 500 (P-25).
    if (describeAIError(err).code !== 'unknown') {
      return NextResponse.json({ error: t('ai.recommendationsAreTemporarilyUnavailable') }, { status: 503 });
    }
    return NextResponse.json({ error: t('weeklyBriefing.failedToGenerateWeeklyBriefing') }, { status: 500 });
  }
}
