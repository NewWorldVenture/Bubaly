import { NextRequest, NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { buildConciergeDigest, digestToPromptLines, type ConciergeSnapshot } from '@/lib/concierge/digest';
import { buildBrief, type BriefNotice } from '@/lib/briefing/build';
import { listUnread } from '@/lib/services/notifications';
import type { AiActivityRow, CompletedRunRow } from '@/lib/home/today';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';
import { BRIEFING_RESPONSE_LIMITS, parseBriefingResponse } from '@/lib/briefing/response-schema';
import { fenceUntrustedBlock, UNTRUSTED_CONTENT_RULE } from '@/lib/ai/safety/untrusted';
import { dayKeyInTz, zonedDayBoundsMs, scopeFromUserContext } from '@/lib/services/scope';
import { withAiRequest } from '@/lib/ai/observability';

function normalizeBriefTimezone(candidate: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

export async function POST(req: NextRequest) {
  const tr = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const { familyId } = ctx.active;
    const supabase = await createServer();
    const limited = await enforceAIRateLimit(supabase, `ai-briefing:${ctx.user.id}`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: tr('briefing.tooManyBriefingRequestsPlease') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: tr('briefing.requestBodyIsTooLarge') }, { status: 400 });
    // The caller's `type` is interpolated into the SYSTEM prompt and decides
    // which stored brief this overwrites, so it may only ever be one of these
    // three words. It arrived unchecked: the client's "This Week" tab posts
    // `weekly`, which mapped to `kind: 'daily'` and clobbered the day's brief,
    // and anything else a caller sent went straight into the model's
    // instructions.
    const raw = (boundedBody.value ?? {}) as { type?: unknown };
    const type: 'morning' | 'evening' | 'weekly' =
      raw.type === 'evening' ? 'evening' : raw.type === 'weekly' ? 'weekly' : 'morning';

    const now = new Date();
    // The family's day, not UTC's. `now.toISOString().slice(0, 10)` is the UTC
    // date: for a family in Los Angeles at 5pm it is already tomorrow, so the
    // brief covered the wrong day and `brief.asOfDate` (which IS family-local)
    // disagreed with the events listed beside it. The timezone was four lines
    // away the whole time.
    const tz = normalizeBriefTimezone(ctx.active.family.timezone || 'America/New_York');
    const today = dayKeyInTz(now, tz);
    const bounds = zonedDayBoundsMs(today, tz);
    const todayStart = new Date(bounds.start).toISOString();
    const todayEnd   = new Date(bounds.end - 1).toISOString();
    const weekEndKey = dayKeyInTz(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000), tz);
    const weekEnd    = new Date(zonedDayBoundsMs(weekEndKey, tz).end - 1).toISOString();

    // Window for the cross-domain concierge digest (bills, maintenance, trips,
    // pantry, warranties) — look a little further ahead so nothing is missed.
    const horizon = dayKeyInTz(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), tz);
    // Which day's doses are due is a question about the family's day: at 8pm in
    // Los Angeles `getUTCDay()` has already rolled over to tomorrow, so a
    // family read the wrong day's medication schedule every evening.
    const todayDow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0=Sun, matches medication_schedules.days_of_week

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
      { data: completedRuns },
      { data: agentActivity },
    ] = await Promise.all([
      supabase.from('family_members').select('id, display_name, role').eq('family_id', familyId).eq('is_active', true),
      supabase.from('calendar_events').select('title, starts_at, ends_at, location, category, assignee_id').eq('family_id', familyId).gte('starts_at', todayStart).lte('starts_at', todayEnd).order('starts_at'),
      supabase.from('calendar_events').select('title, starts_at, category').eq('family_id', familyId).gt('starts_at', todayEnd).lte('starts_at', weekEnd).order('starts_at').limit(8),
      supabase.from('chore_assignments').select('status, due_at, member_id').eq('family_id', familyId).in('status', ['todo', 'in_progress']).lte('due_at', todayEnd),
      supabase.from('school_events').select('title, starts_at, event_type, notes, member_id').eq('family_id', familyId).gte('starts_at', todayStart).lte('starts_at', weekEnd).order('starts_at').limit(10),
      supabase.from('sports_events').select('title, starts_at, sport, team, location, member_id').eq('family_id', familyId).gte('starts_at', todayStart).lte('starts_at', weekEnd).order('starts_at').limit(10),
      supabase.from('grocery_items').select('name, category').eq('family_id', familyId).eq('is_checked', false).limit(15),
      supabase.from('reminders').select('title, notes, remind_at').eq('family_id', familyId).eq('is_done', false).lte('remind_at', weekEnd).order('remind_at').limit(8),
      supabase.from('meal_plans').select('plan_date, meal_type, meals(name)').eq('family_id', familyId).gte('plan_date', today).lte('plan_date', weekEndKey).order('plan_date').limit(14),
      supabase.from('appointments').select('title, starts_at, provider, location, member_id').eq('family_id', familyId).gte('starts_at', todayStart).lte('starts_at', weekEnd).order('starts_at').limit(6),
      // ── Cross-domain concierge signals (previously invisible to the briefing) ──
      supabase.from('bills').select('name, amount, due_date, status').eq('family_id', familyId).neq('status', 'paid').lte('due_date', horizon).order('due_date').limit(20),
      supabase.from('medication_schedules').select('time_of_day, days_of_week, starts_on, ends_on, medications(name, member_id, is_active)').eq('family_id', familyId).lte('starts_on', today).limit(40),
      supabase.from('maintenance_tasks').select('title, due_at, status, completed_at').eq('family_id', familyId).in('status', ['todo', 'in_progress']).is('completed_at', null).not('due_at', 'is', null).lte('due_at', `${horizon}T23:59:59.999Z`).order('due_at').limit(20),
      supabase.from('home_warranties').select('name, expires_on').eq('family_id', familyId).not('expires_on', 'is', null).lte('expires_on', horizon).order('expires_on').limit(20),
      supabase.from('vacations').select('title, destination, start_date, end_date, status').eq('family_id', familyId).not('status', 'in', '("completed","cancelled")').not('start_date', 'is', null).limit(20),
      supabase.from('pantry_items').select('name, expires_at').eq('family_id', familyId).not('expires_at', 'is', null).lte('expires_at', horizon).order('expires_at').limit(25),
      // What Bubaly actually finished. Not for the prompt — for the answer:
      // "Completed Today" is evidence, and evidence comes from the run rows.
      supabase.from('family_automation_runs').select('id, summary, state, progress, completed_at, updated_at')
        .eq('family_id', familyId).in('state', ['completed', 'partially_completed'])
        .order('completed_at', { ascending: false, nullsFirst: false }).limit(6),
      supabase.from('agent_activity').select('id, title, detail, href, created_at')
        .eq('family_id', familyId).eq('kind', 'action').eq('status', 'done').gte('created_at', todayStart)
        .order('created_at', { ascending: false }).limit(5),
    ]);

    const memberMap = new Map((members ?? []).map(m => [m.id, m]));
    const firstName = ctx.active.member?.display_name?.split(' ')[0] ?? 'there';

    // Times a parent reads at 7am are their times. Without `timeZone` these
    // rendered in the server's zone, which on Vercel is UTC.
    const fmt = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    const fmtDate = (iso: string) => dayKeyInTz(new Date(iso), tz);

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
TODAY: ${now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} at ${now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })}
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

${UNTRUSTED_CONTENT_RULE}
- If data is sparse, be honest but still encouraging`;

    // The concierge digest is the deterministic backbone: reminders and
    // outstanding items are derived from real data so the briefing answers
    // "what does my family need to do today?" even when AI is unconfigured.
    const digestReminders = digest.items.map(i => ({
      text: `${i.title} — ${i.detail}`,
      urgency: (i.urgency === 'soon' ? 'medium' : 'high') as 'high' | 'medium' | 'low',
    }));
    const subtitle = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' });

    // Built from rows already read, so the deterministic path says as much as
    // it honestly can rather than defaulting to "nothing".
    const fallbackConflicts = todayConflicts(todayEvents ?? [], tz).slice(0, 6);
    const fallbackKidsNeeds = kidsNeedsFrom(
      (schoolEvents ?? []) as { title: string; starts_at: string; member_id: string | null }[],
      (sportsEvents ?? []) as { title: string; starts_at: string; member_id: string | null }[],
      memberMap,
      today,
      tz,
    );
    const fallbackMeals = (mealPlans ?? [])
      .map((m) => m as unknown as { plan_date: string; meal_type: string; meals: { name: string } | null })
      .filter((m) => m.plan_date === today)
      .slice(0, 6)
      .map((m) => ({ meal: m.meal_type, name: m.meals?.name ?? null, status: m.meals?.name ? 'planned' : 'not planned yet' }));

    let briefing: Record<string, unknown> | null = null;

    try {
      if (await isAIConfigured()) {
        // §33: the brief is one of the two surfaces the row names by name, and
        // until now a failure here left nothing behind — the catch below is
        // silent BY DESIGN (a provider error may carry family context), so
        // "Bubaly stopped doing my morning brief" had no evidence anywhere.
        // The wrapper records the model, tokens, latency and error; the fallback
        // behaviour is unchanged.
        briefing = await withAiRequest(
          scopeFromUserContext(ctx, supabase),
          { feature: `briefing.${type}`, text: `Generate ${type} briefing` },
          async (obs) => {
            const provider = await resolveProvider();
            const completion = await provider.complete({
              system: systemPrompt,
              // `context` is the family's own rows — event titles, reminder text,
              // meal names, contractor notes — assembled into one blob. Same §44 rule
              // as the context builder applies to the same strings.
              messages: [{ role: 'user', content: `Generate ${type} briefing for ${firstName}.\n\nData:\n${fenceUntrustedBlock('briefing_data', context, 24_000)}` }],
              tools: [],
              maxTokens: 2000,
            });
            obs.used(completion.model ?? 'unknown', completion.usage);
            const parsed = parseBriefingResponse(completion.text);
            // Unparseable output takes the deterministic fallback below, and the
            // request row must say so rather than reporting a clean completion —
            // "the model answered with junk" is exactly the diagnosis §33 wants.
            if (!parsed) throw new Error('The model returned a briefing that could not be parsed.');
            return parsed;
          },
        );
      }
    } catch {
      // AI is optional enrichment; retain the fresh deterministic fallback.
      // Provider errors may contain sensitive context, so do not log them here.
      briefing = null;
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
        // These three were hardcoded empty while the rows to fill them were
        // fetched in the same `Promise.all` twenty lines up, and the clashes
        // were computed by `buildBrief` moments later. A family whose AI is
        // unconfigured — or whose model returned unparseable JSON, which takes
        // this same path — was told their day was clear when it was not.
        conflicts: fallbackConflicts,
        kidsNeeds: fallbackKidsNeeds,
        meals: fallbackMeals,
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

    // ── "Completed Today" is evidence, not the model's word for it ──────────
    // The system prompt asks the model to populate `completed`, and until now
    // whatever it wrote went straight to the screen. The runs are right here:
    // `buildBrief` carries them through `mergeCompletedByBubaly`, which keeps
    // only the ones that really reached completed / partially_completed. The
    // model may describe the day; it does not get to decide what happened.
    // 0258's unique key is (family_id, as_of_date, kind), so a `weekly` request
    // must not be filed as the day's brief — the "This Week" tab used to
    // overwrite it on every visit.
    // ── "Also today": the quiet notifications, said once ────────────────────
    //
    // The low-priority half of the notification queue (see
    // lib/notifications/priority.ts) does not earn a badge — it earns a line in
    // the brief. This is the only read of the table the brief makes, it goes
    // through the service so the `send_at` deferral is honoured, and it is
    // skipped for the weekly tab, whose whole point is a different window.
    //
    // A FAILED READ IS NOT AN EMPTY DAY. If the queue cannot be read the
    // section is marked unavailable rather than rendered empty: "nothing else
    // today" is a claim, and this is not the moment to make it.
    let notices: BriefNotice[] = [];
    let alsoTodayUnavailable = false;
    if (type !== 'weekly') {
      try {
        const unread = await listUnread(scopeFromUserContext(ctx, supabase), { limit: 100, priority: 'digest' });
        if (unread.ok) {
          notices = unread.data.map(n => ({
            id: n.id,
            type: n.type,
            title: n.title,
            body: n.body,
            createdAt: n.created_at,
            relatedType: n.related_type,
            relatedId: n.related_id,
          }));
        } else {
          console.error('[api/ai/briefing] notification read failed', unread.error);
          alsoTodayUnavailable = true;
        }
      } catch (err) {
        // One section failing must not take the brief with it: the calendar,
        // the digest and "Completed today" are all already computed.
        console.error('[api/ai/briefing] notification read failed', err);
        alsoTodayUnavailable = true;
      }
    }

    const brief = buildBrief({
      kind: type === 'evening' ? 'evening' : 'daily',
      now,
      events: (todayEvents ?? []).map(e => ({ title: e.title, start: e.starts_at, end: e.ends_at, location: e.location })),
      snapshot: { ...conciergeSnapshot, now: undefined } as Omit<ConciergeSnapshot, 'now'>,
      completedRuns: (completedRuns ?? []) as CompletedRunRow[],
      activity: (agentActivity ?? []) as AiActivityRow[],
      notifications: notices,
    }, tz);

    // Read only because it was RENDERED. `foldAlsoToday` drops duplicates and
    // caps the list, so the rows that survived are exactly the ones this
    // response shows — marking the whole unread queue read here would silently
    // swallow notices the family never saw.
    if (brief.alsoToday.length > 0) {
      const { error: markError } = await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('family_id', familyId)
        .in('id', brief.alsoToday.map(item => item.id));
      // A brief that showed the notices is still a correct brief; failing to
      // mark them read only means they appear again tomorrow.
      if (markError) console.error('[api/ai/briefing] mark folded notifications read failed', markError);
    }

    briefing = {
      ...briefing,
      // A partly-finished run says so. Without this a run that did six of eight
      // things reads exactly like one that did all eight (§29).
      completed: brief.handled.map(h => {
        if (!h.partial) return h.detail ? `${h.title} — ${h.detail}` : h.title;
        return h.detail ? `${h.title} — ${h.detail}` : `${h.title} — partly done`;
      }),
    };

    // Saved snapshots are paused until source access can be revalidated (#341's
    // quarantine), so nothing is filed here. The brief is still COMPOSED —
    // `brief.handled` is what makes "Completed Today" evidence rather than the
    // model's word for it, and that is computed, not stored.
    // Return the fresh briefing and completion evidence in the same envelope.
    // `alsoToday` rides beside `briefing` rather than inside it: the briefing
    // object is the MODEL's contract (BriefingResponseSchema, strict), and this
    // list is read from the notifications table, not written by a model.
    return NextResponse.json({
      briefing,
      digest,
      alsoToday: brief.alsoToday,
      alsoTodayUnavailable,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Briefing error:', err);
    return NextResponse.json({ error: tr('briefing.failedToGenerateBriefing') }, { status: 500 });
  }
}

/** Overlapping events on the family's day, described the way the card renders them. */
function todayConflicts(
  events: { title: string; starts_at: string; ends_at: string | null }[],
  tz: string,
): { description: string; suggestion: string }[] {
  const at = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const out: { description: string; suggestion: string }[] = [];
  for (let i = 0; i < events.length; i += 1) {
    for (let j = i + 1; j < events.length; j += 1) {
      const a = events[i];
      const b = events[j];
      const aStart = Date.parse(a.starts_at);
      const bStart = Date.parse(b.starts_at);
      const aEnd = a.ends_at ? Date.parse(a.ends_at) : aStart + 3_600_000;
      const bEnd = b.ends_at ? Date.parse(b.ends_at) : bStart + 3_600_000;
      if (!(aStart < bEnd && bStart < aEnd)) continue;
      out.push({
        description: `${a.title} and ${b.title} overlap at ${at(new Date(Math.max(aStart, bStart)).toISOString())}`,
        suggestion: 'Decide who covers which, or move one.',
      });
    }
  }
  return out;
}

/** What each child has on today, from the school and sports rows already read. */
function kidsNeedsFrom(
  school: { title: string; starts_at: string; member_id: string | null }[],
  sports: { title: string; starts_at: string; member_id: string | null }[],
  members: Map<string, { display_name: string }>,
  dayKey: string,
  tz: string,
): { name: string; items: string[] }[] {
  const byMember = new Map<string, { name: string; items: string[] }>();
  for (const row of [...school, ...sports]) {
    if (!row.member_id) continue;
    if (dayKeyInTz(new Date(row.starts_at), tz) !== dayKey) continue;
    const name = members.get(row.member_id)?.display_name;
    if (!name) continue;
    const needs: { name: string; items: string[] } = byMember.get(row.member_id) ?? { name, items: [] };
    if (needs.items.length < 4) needs.items.push(row.title);
    byMember.set(row.member_id, needs);
  }
  return [...byMember.values()].slice(0, 6);
}
