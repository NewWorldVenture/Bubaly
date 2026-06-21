import { NextRequest, NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const { familyId } = ctx.active;
    const supabase = await createServer();

    const { type = 'morning' } = (await req.json()) as { type?: string };

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const todayStart = `${today}T00:00:00.000Z`;
    const todayEnd   = `${today}T23:59:59.999Z`;
    const weekEnd    = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + 'T23:59:59.999Z';

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
    ]);

    const memberMap = new Map((members ?? []).map(m => [m.id, m]));
    const firstName = ctx.active.member?.display_name?.split(' ')[0] ?? 'there';

    const fmt = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const fmtDate = (iso: string) => iso.slice(0, 10);

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
- Kids needs should infer from school events, sports events, and reminders
- For evening briefing, populate completed/outstanding/tomorrowPreview
- For weekly briefing, populate weeklyHighlights and weeklyConflicts
- If data is sparse, be honest but still encouraging`;

    const response = await anthropic.messages.create({
      model: process.env.AI_MODEL ?? 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Generate ${type} briefing for ${firstName}.\n\nData:\n${context}` }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}';

    let briefing: Record<string, unknown>;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      briefing = JSON.parse(jsonMatch?.[0] ?? '{}');
    } catch {
      briefing = {
        greeting: `Good ${type === 'evening' ? 'evening' : 'morning'}, ${firstName}!`,
        subtitle: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
        familySummary: ['Briefing data is being processed.'],
        schedule: [],
        conflicts: [],
        kidsNeeds: [],
        meals: [],
        reminders: [],
        operationsScore: { overall: 75, categories: [], stressLevel: 'low', stressReason: null, recommendation: 'Have a great day!' },
      };
    }

    return NextResponse.json({ briefing, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Briefing error:', err);
    return NextResponse.json({ error: 'Failed to generate briefing' }, { status: 500 });
  }
}
