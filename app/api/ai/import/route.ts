import { NextRequest, NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider } from '@/lib/ai/provider';
import { AI_TOOLS, runAction } from '@/lib/ai/actions';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { evaluateTrust, roleOf } from '@/lib/trust/server';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';

// Map a Magic-Import action to a Trust Engine domain so the governance layer can
// allow / block / require-approval before the AI writes anything.
const ACTION_DOMAIN: Record<string, string> = {
  create_calendar_event: 'calendar',
  create_chore: 'chores',
  create_reminder: 'scheduling',
  add_grocery_item: 'shopping',
  create_meal_plan_entry: 'meal_planning',
};

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

    const limited = await enforceAIRateLimit(supabase, `ai-import:${userId}`, { limit: 20 });
    if (!limited.ok) {
      return NextResponse.json(
        { error: 'Too many imports. Please try again shortly.' },
        { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
      );
    }

    const boundedBody = await readBoundedRequestJson(req, MAX_PROVIDER_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Invalid request body' }, { status: 400 });
    const body = (boundedBody.value ?? {}) as { text?: string; confirm?: Item[] };

    // ── Phase 2: execute the items the user confirmed ──────────────────────
    // Every confirmed action is first evaluated by the Trust & Permissions Engine.
    // allow → execute · require_approval → queue (don't execute) · deny → block.
    if (Array.isArray(body.confirm)) {
      const actorRole = roleOf(ctx.active.role);
      const results = await Promise.all(
        body.confirm.slice(0, 50).map(async (item) => {
          const domain = ACTION_DOMAIN[item.name] ?? 'tasks';
          const { decision } = await evaluateTrust(supabase, familyId, {
            actor: { kind: 'ai_agent', id: 'magic_import', role: actorRole },
            domain, capability: 'automate',
            agent: 'Magic Import',
            title: item.summary,
            payload: { name: item.name, args: item.args },
            context: { confidence: 0.9 },
          });

          if (decision.effect === 'deny') {
            return { summary: item.summary, ok: false, blocked: true, error: decision.reason };
          }
          if (decision.effect === 'require_approval') {
            return { summary: item.summary, ok: false, pendingApproval: true, error: decision.reason };
          }
          // Trust was just evaluated for this exact item a few lines up, so the
          // registry does not evaluate it a second time.
          const res = await runAction(
            { supabase, familyId, userId },
            { name: item.name, args: item.args },
            { alreadyAuthorized: true },
          );
          return { summary: item.summary, ok: res.ok, error: res.error };
        }),
      );
      const created = results.filter((r) => r.ok).length;
      const queued = results.filter((r) => 'pendingApproval' in r && r.pendingApproval).length;
      return NextResponse.json({ created, queued, results });
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
