import { NextRequest, NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider } from '@/lib/ai/provider';
import { AI_TOOLS, runAction } from '@/lib/ai/actions';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';

export const runtime = 'nodejs';

type Item = { name: string; args: Record<string, unknown>; summary: string };

function fmtWhen(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return ` (${value})`;
  const hasTime = value.includes('T') && !value.endsWith('T00:00:00.000Z');
  return ` (${d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    ...(hasTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  })})`;
}

/** Human-readable summary for a proposed action, shown before the user confirms. */
function summarize(name: string, a: Record<string, unknown>): string {
  switch (name) {
    case 'create_calendar_event': return `📅 Event: “${a.title}”${fmtWhen(a.starts_at)}`;
    case 'create_chore': return `✅ Chore: “${a.title}”${a.due_at ? fmtWhen(a.due_at) : ''}`;
    case 'create_reminder': return `⏰ Reminder: “${a.title}”${fmtWhen(a.remind_at)}`;
    case 'add_grocery_item': return `🛒 Grocery: ${a.name}${a.quantity ? ` × ${a.quantity}` : ''}`;
    case 'create_meal_plan_entry': return `🍽️ Meal: ${a.meal_name}${fmtWhen(a.plan_date)}`;
    default: return name;
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const userId = ctx.user.id;
    const supabase = await createServer();

    const ip = clientIp(req.headers);
    const limit = rateLimit(`import:${userId || ip}`, { limit: 20, windowMs: 60_000 });
    if (!limit.ok) {
      return NextResponse.json({ error: 'Slow down a moment and try again.' }, { status: 429 });
    }

    const body = (await req.json()) as { text?: string; confirm?: Item[] };

    // ── Phase 2: execute the items the user confirmed ──────────────────────
    if (Array.isArray(body.confirm)) {
      const results = await Promise.all(
        body.confirm.map(async (item) => {
          const res = await runAction({ supabase, familyId, userId }, { name: item.name, args: item.args });
          return { summary: item.summary, ok: res.ok, error: res.error };
        }),
      );
      const created = results.filter((r) => r.ok).length;
      return NextResponse.json({ created, results });
    }

    // ── Phase 1: parse pasted text into proposed actions ───────────────────
    const text = (body.text ?? '').trim();
    if (!text) return NextResponse.json({ error: 'Paste something to import.' }, { status: 400 });
    if (text.length > 8000) return NextResponse.json({ error: 'That text is too long (8,000 char max).' }, { status: 400 });

    const now = new Date();
    const system = `You are Bubaly's Magic Import assistant. The user pastes raw text — forwarded emails, school notices, texts, flyers, or notes — and you extract EVERY actionable item.

Today is ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} (${now.toISOString().slice(0, 10)}). The family is "${ctx.active.family.name}".

Use the provided tools to capture: calendar events, chores, reminders, grocery items, and planned meals. Rules:
- Resolve relative dates ("next Friday", "tomorrow", "the 14th") to absolute ISO 8601 using today's date. Assume the current or next occurrence.
- Prefer create_calendar_event for anything with a date/time; use create_reminder for to-dos with a deadline but no fixed time.
- Extract multiple items if present. Do not invent details that aren't in the text.
- If nothing is actionable, make no tool calls.
Respond only with tool calls (no prose).`;

    const completion = await (await resolveProvider()).complete({
      system,
      messages: [{ role: 'user', content: text }],
      tools: AI_TOOLS,
    });

    const items: Item[] = completion.toolCalls.map((c) => ({
      name: c.name,
      args: c.args,
      summary: summarize(c.name, c.args),
    }));

    return NextResponse.json({ items, note: completion.text || null });
  } catch (err) {
    console.error('Import error:', err);
    return NextResponse.json({ error: 'Could not process that import.' }, { status: 500 });
  }
}
