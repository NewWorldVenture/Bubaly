import { NextRequest, NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { buildConciergeDigest, digestToPromptLines, type ConciergeSnapshot } from '@/lib/concierge/digest';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';
import { BRIEFING_RESPONSE_LIMITS, parseBriefingResponse } from '@/lib/briefing/response-schema';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const { familyId } = ctx.active;
    const supabase = await createServer();
    const limited = await enforceAIRateLimit(supabase, `ai-briefing:${ctx.user.id}`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: 'Too many briefing requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: 'Request body is too large.' }, { status: 400 });
    const { type = 'morning' } = (boundedBody.value ?? {}) as { type?: string };

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const todayStart = `${today}T00:00:00.000Z`;
    const todayEnd   = `${today}T23:59:59.999Z`;
    const weekEnd    = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + 'T23:59:59.999Z';

    // Window for the cross-domain concierge digest (bills, maintenance, trips,
    // pantry, warranties) — look a little further ahead so nothing is missed.
    const horizon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const todayDow = now.getUTCDay(); // 0=Sun, matches medication_schedules.days_of_week

    const [
      { data: members },
      { data: todayEvents },
      { data: tomorrowEvents },
      { data: choresDue },
      { data: schoolEvents },
      { data: sportsEvents },
      { data: groceryItems },
      { data: reminders },
      { data: mealPlans },
      { data: appointments },
      { data: bills },
      { data: medSchedules },
      { data: maintenance },
      { data: warranties },
      { data: trips },
      { data: pantry },
    ] = await Promise.all([
      supabase.from('family_members').select('id, display_name, role').eq('family_id', familyId).eq('is_active', true),
      supabase.from('calendar_events').select('title, starts_at, ends_at, location, category, assignee_id').eq('family_id', familyId).gte('starts_at', todayStart).lte('starts_at', todayEnd).order('starts_at'),
      supabase.from('calendar_events').select('title, starts_at, category').eq('family_id', familyId).gt('starts_at', todayEnd).lte('starts_at', weekEnd).order('starts_at').limit(8),
      supabase.from('chore_assignments').select('status, due_at, member_id').eq('family_id', familyId).in('status', ['todo', 'in_progress']).lte('due_at', todayEnd),
      supabase.from('school_events').select('title, starts_at, event_type, notes, member_id').eq('family_id', familyId).gte('starts_at', todayStart).lte('starts_at', weekEnd).order('starts_at').limit(10),
      supabase.from('sports_events').select('title, starts_at, sport, team, location, member_id').eq('family_id', familyId).gte('starts_at', todayStart).lte('starts_at', weekEnd).order('starts_at').limit(10),
      supabase.from('grocery_items').select('name, category').eq('family_id', familyId).eq('is_checked', false).limit(15),
      supabase.from('reminders').select('title, notes, remind_at').eq('family_id', familyId).eq('is_done', false).lte('remind_at', weekEnd).order('remind_at').limit(8),
      supabase.from('meal_plans').select('plan_date, meal_type, meals(name)').eq('family_id', familyId).gte('plan_date', today).lte('plan_date', weekEnd.slice(0, 10)).order('plan_date').limit(14),
      supabase.from('appointments').select('title, starts_at, provider, location, member_id').eq('family_id', familyId).gte('starts_at', todayStart).lte('starts_at', weekEnd).order('starts_at').limit(6),
      // ── Cross-domain concierge signals (previously invisible to the briefing) ──
      supabase.from('bills').select('name, amount, due_date, status').eq('family_id', familyId).neq('status', 'paid').lte('due_date', horizon).order('due_date').limit(20),
      supabase.from('medication_schedules').select('time_of_day, days_of_week, starts_on, ends_on, medications(name, member_id, is_active)').eq('family_id', familyId).lte('starts_on', today).limit(40),
      supabase.from('maintenance_tasks').select('title, due_at, status, completed_at').eq('family_id', familyId).in('status', ['todo', 'in_progress']).is('completed_at', null).not('due_at', 'is', null).lte('due_at', `${horizon}T23:59:59.999Z`).order('due_at').limit(20),
      supabase.from('home_warranties').select('name, expires_on').eq('family_id', familyId).not('expires_on', 'is', null).lte('expires_on', horizon).order('expires_on').limit(20),
      supabase.from('vacations').select('title, destination, start_date, end_date, status').eq('family_id', familyId).not('status', 'in', '("completed","cancelled")').not('start_date', 'is', null).limit(20),
      supabase.from('pantry_items').select('name, expires_at').eq('family_id', familyId).not('expires_at', 'is', null).lte('expires_at', horizon).order('expires_at').limit(25),
    ]);

    const memberMap = new Map((members ?? []).map(m => [m.id, m]));
    const firstName = ctx.active.member?.display_name?.split(' ')[0] ?? 'there';

    const fmt = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const fmtDate = (iso: string) => iso.slice(0, 10);

    // ── Build the deterministic cross-domain concierge digest ─────────────────
    const fmtTimeOfDay = (t: string | null) => {
      if (!t) return null;
      const [h, m] = t.split(':');
      const hour = Number(h);
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const h12 = hour % 12 === 0 ? 12 : hour % 12;
      return `${h12}:${m ?? '00'} ${ampm}`;
    };
    const medsDueToday = (medSchedules ?? [])
      .map(s => {
        const sched = s as unknown as {
          time_of_day: string | null; days_of_week: number[] | null; ends_on: string | null;
          medications: { name: string; member_id: string | null; is_active: boolean } | null;
        };
        return sched;
      })
      .filter(s => s.medications?.is_active !== false
        && (s.days_of_week ?? [0, 1, 2, 3, 4, 5, 6]).includes(todayDow)
        && (!s.ends_on || s.ends_on >= today))
      .map(s => ({
        name: s.medications?.name ?? 'Medication',
        member: s.medications?.member_id ? memberMap.get(s.medications.member_id)?.display_name ?? null : null,
        timeOfDay: fmtTimeOfDay(s.time_of_day),
      }));

    const conciergeSnapshot: ConciergeSnapshot = {
      now,
      bills: (bills ?? []).map(b => ({ name: b.name, amount: b.amount, dueDate: b.due_date, status: b.status })),
      medications: medsDueToday,
      maintenance: (maintenance ?? []).map(m => ({ title: m.title, dueAt: m.due_at })),
      warranties: (warranties ?? []).map(w => ({ name: w.name, expiresOn: w.expires_on })),
      trips: (trips ?? []).map(t => ({ title: t.title, startDate: t.start_date, endDate: t.end_date, destination: t.destination })),
      pantry: (pantry ?? []).map(p => ({ name: p.name, expiresAt: p.expires_at })),
    };
    const digest = buildConciergeDigest(conciergeSnapshot);

    const context = `
TODAY: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} at ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
FAMILY NAME: ${ctx.active.family.name}
MEMBERS: ${(members ?? []).map(m => `${m.display_name} (${m.role})`).join(', ')}
GENERATING FOR: ${ctx.active.member?.display_name ?? 'family'}

TODAY'S CALENDAR EVENTS (${(todayEvents ?? []).length}):
${(todayEvents ?? []).map(e => {
  const assignee = e.assignee_id ? memberMap.get(e.assignee_id)?.display_name : null;
  return `- ${fmt(e.starts_at)} ${e.title}${assignee ? ` [${assignee}]` : ''}${e.location ? ` @ ${e.location}` : ''}${e.ends_at ? ` until ${fmt(e.ends_at)}` : ''}`;
}).join('\n') || '- No events today'}

TOMORROW/THIS WEEK EVENTS:
${(tomorrowEvents ?? []).map(e => `- ${fmtDate(e.starts_at)} ${fmt(e.starts_at)} ${e.title}`).join('\n') || '- None'}

CHORES DUE TODAY (${(choresDue ?? []).length}):
${(choresDue ?? []).map(c => {
  const member = c.member_id ? memberMap.get(c.member_id)?.display_name : 'unassigned';
  return `- ${c.status} [${member}]`;
}).join('\n') || '- None overdue'}

SCHOOL EVENTS THIS WEEK:
${(schoolEvents ?? []).map(e => {
  const member = e.member_id ? memberMap.get(e.member_id)?.display_name : null;
  return `- ${fmtDate(e.starts_at)} ${e.title} (${e.event_type})${member ? ` [${member}]` : ''}${e.notes ? ': ' + e.notes : ''}`;
}).join('\n') || '- None'}

SPORTS THIS WEEK:
${(sportsEvents ?? []).map(e => {
  const member = e.member_id ? memberMap.get(e.member_id)?.display_name : null;
  return `- ${fmtDate(e.starts_at)} ${fmt(e.starts_at)} ${e.title} (${e.sport})${member ? ` [${member}]` : ''}${e.location ? ` @ ${e.location}` : ''}`;
}).join('\n') || '- None'}

GROCERIES STILL NEEDED (${(groceryItems ?? []).length} items):
${(groceryItems ?? []).map(g => `- ${g.name}${g.category ? ` (${g.category})` : ''}`).join('\n') || '- None'}

UPCOMING REMINDERS:
${(reminders ?? []).map(r => `- ${r.remind_at?.slice(0, 10) ?? 'soon'}: ${r.title}${r.notes ? ': ' + r.notes : ''}`).join('\n') || '- None'}

MEAL PLANS THIS WEEK:
${(mealPlans ?? []).map(m => {
  const meal = m as unknown as { plan_date: string; meal_type: string; meals: { name: string } | null };
  return `- ${meal.plan_date} ${meal.meal_type}: ${meal.meals?.name ?? 'TBD'}`;
}).join('\n') || '- No meals planned'}

MEDICAL APPOINTMENTS THIS WEEK:
${(appointments ?? []).map(a => {
  const member = a.member_id ? memberMap.get(a.member_id)?.display_name : null;
  return `- ${fmtDate(a.starts_at)} ${fmt(a.starts_at)} ${a.title}${a.provider ? ` with ${a.provider}` : ''}${a.location ? ` @ ${a.location}` : ''}${member ? ` [${member}]` : ''}`;
}).join('\n') || '- None'}

CROSS-DOMAIN ACTION ITEMS (bills, medications, home maintenance, warranties, trips, pantry — ${digest.headline}):
${digestToPromptLines(digest)}
    `.trim();

    const systemPrompt = `You are the Bubaly AI Chief of Staff. Generate a ${type} family briefing as structured JSON.
    
IMPORTANT: Return ONLY valid JSON. No markdown, no code blocks, no explanation. Start with { and end with }.

Use this exact JSON structure:
{
  "greeting": "warm greeting using first name",
  "subtitle": "day and date string",
  "familySummary": ["bullet 1", "bullet 2", "bullet 3", "bullet 4"],
  "schedule": [{"time": "3:00 PM", "title": "Soccer Practice", "member": "Jackson", "emoji": "⚽", "color": "emerald"}],
  "conflicts": [{"description": "Event A overlaps with Event B", "suggestion": "Specific actionable solution"}],
  "kidsNeeds": [{"name": "ChildName", "age": 10, "items": ["Item 1", "Item 2"]}],
  "meals": [{"meal": "Dinner", "name": "Chicken Tacos", "status": "planned", "missing": ["Tortillas", "Lettuce"]}],
  "reminders": [{"text": "Insurance renewal due tomorrow", "urgency": "high"}],
  "operationsScore": {
    "overall": 88,
    "categories": [
      {"label": "Schedule", "score": 85, "icon": "📅"},
      {"label": "School", "score": 95, "icon": "📚"},
      {"label": "Meals", "score": 70, "icon": "🍽️"},
      {"label": "Tasks", "score": 80, "icon": "✅"},
      {"label": "Health", "score": 100, "icon": "❤️"}
    ],
    "stressLevel": "moderate",
    "stressReason": "Two events overlap on Thursday afternoon",
    "recommendation": "Specific one-sentence action you recommend"
  },
  "completed": ["Completed thing 1"],
  "outstanding": [{"text": "Outstanding item", "urgency": "high"}],
  "tomorrowPreview": {"events": 3, "notes": ["Soccer game at 2pm", "Dentist at 9am"]},
  "weeklyHighlights": [{"category": "School", "emoji": "📚", "items": ["item 1", "item 2"]}],
  "weeklyConflicts": [{"description": "conflict", "suggestion": "resolution"}]
}

Rules:
- Be warm, specific, and actionable
- Detect real time conflicts (overlapping events, travel time issues)
- Score categories 0-100 honestly based on the data
- Use appropriate emojis for schedule items (🏥 medical, ⚽ sports, 📚 school, ✈️ travel, 🍽️ dinner, 💼 work, 🎂 birthday)
- Color choices for schedule: blue, purple, rose, emerald, amber, cyan, indigo
- Reminder urgency: high, medium, low. Outstanding urgency: high, medium. Stress level: low, moderate, high.
- Keep lists to ${BRIEFING_RESPONSE_LIMITS.listItems} entries, nested items/missing/notes to ${BRIEFING_RESPONSE_LIMITS.nestedItems}, and score categories to ${BRIEFING_RESPONSE_LIMITS.categories}.
- Keep greeting, subtitle, names, titles, labels, meal/status/category text to ${BRIEFING_RESPONSE_LIMITS.label} characters; other text to ${BRIEFING_RESPONSE_LIMITS.text}, schedule times to ${BRIEFING_RESPONSE_LIMITS.time}, and emoji/icon strings to ${BRIEFING_RESPONSE_LIMITS.icon}.
- If age is known, use a whole number from 0 to ${BRIEFING_RESPONSE_LIMITS.age}; otherwise omit it. Tomorrow's event count must be a whole number from 0 to ${BRIEFING_RESPONSE_LIMITS.eventCount}.
- Kids needs should infer from school events, sports events, and reminders
- For evening briefing, populate completed/outstanding/tomorrowPreview
- For weekly briefing, populate weeklyHighlights and weeklyConflicts
- ALWAYS fold the CROSS-DOMAIN ACTION ITEMS (bills due, medications, home maintenance, expiring warranties, upcoming trips, expiring pantry food) into "reminders" and "outstanding" with honest urgency — overdue→high, today→high, coming up→medium. Never invent amounts or dates; only use what is given.
- If data is sparse, be honest but still encouraging`;

    // The concierge digest is the deterministic backbone: reminders and
    // outstanding items are derived from real data so the briefing answers
    // "what does my family need to do today?" even when AI is unconfigured.
    const digestReminders = digest.items.map(i => ({
      text: `${i.title} — ${i.detail}`,
      urgency: (i.urgency === 'soon' ? 'medium' : 'high') as 'high' | 'medium' | 'low',
    }));
    const subtitle = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    let briefing: Record<string, unknown> | null = null;

    if (await isAIConfigured()) {
      const provider = await resolveProvider();
      const completion = await provider.complete({
        system: systemPrompt,
        messages: [{ role: 'user', content: `Generate ${type} briefing for ${firstName}.\n\nData:\n${context}` }],
        tools: [],
        maxTokens: 2000,
      });
      briefing = parseBriefingResponse(completion.text);
    }

    // Deterministic concierge briefing — used when AI is off or returns junk.
    if (!briefing) {
      briefing = {
        greeting: `Good ${type === 'evening' ? 'evening' : 'morning'}, ${firstName}!`,
        subtitle,
        familySummary: digest.byDomain.length
          ? digest.byDomain.map(d => `${d.count} ${d.domain}${d.count > 1 ? 's' : ''} need attention`)
          : ['Nothing outstanding — enjoy the open day!'],
        schedule: (todayEvents ?? []).map(e => ({
          time: fmt(e.starts_at),
          title: e.title,
          member: e.assignee_id ? memberMap.get(e.assignee_id)?.display_name ?? '' : '',
          emoji: '📅',
          color: 'blue',
        })),
        conflicts: [],
        kidsNeeds: [],
        meals: [],
        reminders: digestReminders,
        operationsScore: {
          overall: digest.counts.overdue > 0 ? 60 : digest.counts.today > 3 ? 75 : 90,
          categories: [],
          stressLevel: (digest.counts.overdue > 0 ? 'high' : digest.counts.today > 3 ? 'moderate' : 'low') as 'low' | 'moderate' | 'high',
          stressReason: digest.counts.total ? digest.headline : null,
          recommendation: digest.items[0]
            ? `Start with: ${digest.items[0].title} — ${digest.items[0].detail}.`
            : 'You are all caught up. Have a great day!',
        },
        outstanding: digestReminders.filter(r => r.urgency === 'high'),
      };
    }

    return NextResponse.json({ briefing, digest, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Briefing error:', err);
    return NextResponse.json({ error: 'Failed to generate briefing' }, { status: 500 });
  }
}
