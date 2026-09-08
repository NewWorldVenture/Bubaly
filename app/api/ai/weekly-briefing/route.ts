import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { requireUserContext, effectivePlanLevel } from '@/lib/supabase/auth';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { weekWindow, weekRangeLabel, choreCompletionRate, bucketByDay, dayLoad } from '@/lib/ai/weekly';
import { resolveProvider } from '@/lib/ai/provider';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';

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

    // Plus-only — guard here too (the page already gates, but the endpoint is
    // independently reachable). Return 402 so the client can prompt an upgrade.
    if ((await effectivePlanLevel(await resolveFamilyPlanLevel(supabase, familyId))) < 2) {
      return NextResponse.json({ error: t('weeklyBriefing.weeklyAiBriefingIsA') }, { status: 402 });
    }
    const limited = await enforceAIRateLimit(supabase, `ai-weekly-briefing:${ctx.user.id}`, { limit: 5 });
    if (!limited.ok) return NextResponse.json(
      { error: t('weeklyBriefing.tooManyWeeklyBriefingRequests') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: t('weeklyBriefing.requestBodyIsTooLarge') }, { status: 400 });

    const now = new Date();
    const w = weekWindow(now);

    const [
      { data: members },
      { data: aheadEvents },
      { data: schoolEvents },
      { data: sportsEvents },
      { data: appointments },
      { data: choresDueAhead },
      { data: mealPlans },
      { data: groceryItems },
      { data: reminders },
      { data: recapChores },
      { data: recapEvents },
    ] = await settleAll([
      supabase.from('family_members').select('id, display_name, role').eq('family_id', familyId).eq('is_active', true),
      supabase.from('calendar_events').select('title, starts_at, ends_at, location, category, assignee_id').eq('family_id', familyId).gte('starts_at', w.aheadStart).lte('starts_at', w.aheadEnd).order('starts_at').limit(60),
      supabase.from('school_events').select('title, starts_at, event_type, notes, member_id').eq('family_id', familyId).gte('starts_at', w.aheadStart).lte('starts_at', w.aheadEnd).order('starts_at').limit(20),
      supabase.from('sports_events').select('title, starts_at, sport, team, location, member_id').eq('family_id', familyId).gte('starts_at', w.aheadStart).lte('starts_at', w.aheadEnd).order('starts_at').limit(20),
      supabase.from('appointments').select('title, starts_at, provider, location, member_id').eq('family_id', familyId).gte('starts_at', w.aheadStart).lte('starts_at', w.aheadEnd).order('starts_at').limit(15),
      supabase.from('chore_assignments').select('status, due_at, member_id').eq('family_id', familyId).gte('due_at', w.aheadStart).lte('due_at', w.aheadEnd),
      supabase.from('meal_plans').select('plan_date, meal_type, meals(name)').eq('family_id', familyId).gte('plan_date', w.days[0]).lte('plan_date', w.days[w.days.length - 1]).order('plan_date').limit(21),
      supabase.from('grocery_items').select('name, category').eq('family_id', familyId).eq('is_checked', false).limit(20),
      supabase.from('reminders').select('title, notes, remind_at').eq('family_id', familyId).eq('is_done', false).lte('remind_at', w.aheadEnd).order('remind_at').limit(12),
      supabase.from('chore_assignments').select('status, due_at, member_id').eq('family_id', familyId).gte('due_at', w.recapStart).lte('due_at', w.recapEnd),
      supabase.from('calendar_events').select('title, starts_at, category').eq('family_id', familyId).gte('starts_at', w.recapStart).lte('starts_at', w.recapEnd).order('starts_at').limit(40),
    ]);

    const memberMap = new Map((members ?? []).map((m) => [m.id, m]));
    const firstName = ctx.active.member?.display_name?.split(' ')[0] ?? 'there';
    const memberName = (id: string | null) => (id ? memberMap.get(id)?.display_name ?? null : null);

    // Per-day look-ahead buckets so the prompt can present a true week grid.
    const eventsByDay = bucketByDay(aheadEvents ?? [], (e) => e.starts_at, w.days);
    const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
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
WEEK OF: ${weekRangeLabel(w)} (generated ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })})
FAMILY: ${ctx.active.family.name}
MEMBERS: ${(members ?? []).map((m) => `${m.display_name} (${m.role})`).join(', ') || 'none'}
GENERATING FOR: ${ctx.active.member?.display_name ?? 'family'}

═══ LAST WEEK RECAP (the 7 days just ended) ═══
CHORE COMPLETION LAST WEEK: ${recapRate}% (${(recapChores ?? []).length} assignments)
EVENTS THAT HAPPENED (${(recapEvents ?? []).length}):
${(recapEvents ?? []).map((e) => `- ${e.starts_at.slice(0, 10)} ${e.title} (${e.category})`).join('\n') || '- none logged'}

═══ THE WEEK AHEAD (next 7 days) ═══
CHORES DUE THIS WEEK: ${(choresDueAhead ?? []).length} (currently ${aheadRate}% done)
DAY-BY-DAY CALENDAR:
${dayGrid}

SCHOOL THIS WEEK:
${(schoolEvents ?? []).map((e) => `- ${e.starts_at.slice(0, 10)} ${e.title} (${e.event_type})${memberName(e.member_id) ? ` [${memberName(e.member_id)}]` : ''}${e.notes ? ': ' + e.notes : ''}`).join('\n') || '- none'}

SPORTS THIS WEEK:
${(sportsEvents ?? []).map((e) => `- ${e.starts_at.slice(0, 10)} ${fmtTime(e.starts_at)} ${e.title} (${e.sport})${memberName(e.member_id) ? ` [${memberName(e.member_id)}]` : ''}${e.location ? ` @ ${e.location}` : ''}`).join('\n') || '- none'}

MEDICAL APPOINTMENTS THIS WEEK:
${(appointments ?? []).map((a) => `- ${a.starts_at.slice(0, 10)} ${fmtTime(a.starts_at)} ${a.title}${a.provider ? ` with ${a.provider}` : ''}${memberName(a.member_id) ? ` [${memberName(a.member_id)}]` : ''}`).join('\n') || '- none'}

MEAL PLANS THIS WEEK:
${(mealPlans ?? []).map((m) => {
  const meal = m as unknown as { plan_date: string; meal_type: string; meals: { name: string } | null };
  return `- ${meal.plan_date} ${meal.meal_type}: ${meal.meals?.name ?? 'TBD'}`;
}).join('\n') || '- none planned'}

GROCERIES STILL NEEDED (${(groceryItems ?? []).length}):
${(groceryItems ?? []).map((g) => `- ${g.name}${g.category ? ` (${g.category})` : ''}`).join('\n') || '- none'}

UPCOMING REMINDERS:
${(reminders ?? []).map((r) => `- ${r.remind_at?.slice(0, 10) ?? 'soon'}: ${r.title}`).join('\n') || '- none'}
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

    let briefing = await withAiRequest(
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
        const text = completion.text || '{}';
        try {
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          return JSON.parse(jsonMatch?.[0] ?? '{}') as Record<string, unknown>;
        } catch {
          obs.failed(new Error('The weekly briefing did not parse as JSON; used the deterministic fallback.'));
          return null;
        }
      },
    );

    if (briefing === null) {
      // Deterministic fallback built from the same data, so the page is never empty.
      briefing = {
        weekRange: weekRangeLabel(w),
        headline: `Here’s your week, ${firstName}.`,
        summary: ['Your weekly briefing is being processed — refresh in a moment.'],
        recap: { choreCompletion: recapRate, wins: [], misses: [], note: 'Keep it up!' },
        dayByDay: w.days.map((key) => ({
          day: dayName(key),
          date: new Date(`${key}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
          emoji: '📅',
          load: dayLoad((eventsByDay[key] ?? []).length),
          events: (eventsByDay[key] ?? []).map((e) => ({ time: fmtTime(e.starts_at), title: e.title, member: memberName(e.assignee_id) ?? '' })),
        })),
        highlights: [],
        conflicts: [],
        prepChecklist: [],
        weeklyScore: { overall: 75, categories: [], stressLevel: 'low', stressReason: null, focus: 'Have a great week!' },
        focusOfTheWeek: 'Have a great week!',
      };
    }

    return NextResponse.json({ briefing, generatedAt: new Date().toISOString(), weekKey: w.days[0] });
  } catch (err) {
    console.error('Weekly briefing error:', err);
    return NextResponse.json({ error: t('weeklyBriefing.failedToGenerateWeeklyBriefing') }, { status: 500 });
  }
}
