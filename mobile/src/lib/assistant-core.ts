// Pure request/response logic for the /api/ai JSON transport (unit-tested from
// the repo root). The screen + api.ts only add fetch and state on top.
//
// Cards: the JSON reply carries the same `cards[]` the web streams as `card`
// events (see lib/ai/result-cards.ts at the repo root). The phone has no zod
// and no card components, so it validates the shape structurally and renders
// every kind as a simple section — a title, a subtitle, and a few lines —
// which is all a card needs to read as an outcome rather than a chat bubble.

export type AssistantAction = { name: string; ok: boolean; summary: string };
/** A card as the phone sees it: a kind, a title, and whatever else the kind carries. */
export type AssistantCard = { kind: string; title: string } & Record<string, unknown>;
export type AssistantReply = {
  conversationId: string;
  content: string;
  actions: AssistantAction[];
  /** Present only when the turn produced cards / touched runs, so a plain reply stays a plain reply. */
  cards?: AssistantCard[];
  runIds?: string[];
  persisted: boolean;
  model?: string;
};

export type AssistantFailure = { ok: false; error: string; code?: string; status: number };
export type AssistantParse = { ok: true; reply: AssistantReply } | AssistantFailure;

export function buildAssistantRequest(args: { apiUrl: string; token: string; conversationId: string; message: string }): { url: string; init: RequestInit } {
  return {
    url: `${args.apiUrl.replace(/\/+$/, '')}/api/ai?mode=json`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${args.token}`,
      },
      body: JSON.stringify({ conversationId: args.conversationId, message: args.message, stream: false }),
    },
  };
}

const FRIENDLY: Record<string, string> = {
  invalid_token: 'Your session expired. Sign in again to keep chatting.',
  signed_out: 'Sign in to use the assistant.',
  needs_family: 'Finish setting up your family on the web app first.',
  not_configured: 'The assistant isn’t switched on for this workspace yet.',
  message_too_long: 'That message is a little long — try a shorter one.',
};

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Every well-formed card in a reply; anything without a string kind and title is dropped. */
export function parseCards(value: unknown): AssistantCard[] {
  if (!Array.isArray(value)) return [];
  return value.filter((c): c is AssistantCard => isRecord(c) && typeof c.kind === 'string' && c.kind.length > 0 && typeof c.title === 'string' && c.title.length > 0);
}

export function parseAssistantResponse(status: number, body: unknown): AssistantParse {
  const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (status >= 200 && status < 300 && typeof obj.content === 'string') {
    const actions = Array.isArray(obj.actions)
      ? obj.actions
          .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object')
          .map((a) => ({ name: String(a.name ?? ''), ok: a.ok !== false, summary: String(a.summary ?? '') }))
      : [];
    const cards = parseCards(obj.cards);
    const runIds = Array.isArray(obj.runIds) ? obj.runIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
    return {
      ok: true,
      reply: {
        conversationId: String(obj.conversationId ?? ''),
        content: obj.content,
        actions,
        ...(cards.length ? { cards } : {}),
        ...(runIds.length ? { runIds } : {}),
        persisted: obj.persisted !== false,
        ...(typeof obj.model === 'string' ? { model: obj.model } : {}),
      },
    };
  }
  const code = typeof obj.code === 'string' ? obj.code : undefined;
  const serverError = typeof obj.error === 'string' ? obj.error : undefined;
  if (status === 429) return { ok: false, status, code: 'rate_limited', error: 'You’re sending messages quickly — give it a moment.' };
  const error = (code && FRIENDLY[code]) ?? serverError ?? (status >= 500 ? 'Bubaly hit a snag. Try again in a moment.' : 'Something went wrong.');
  return { ok: false, status, error, ...(code ? { code } : {}) };
}

// ─── Cards → sections ───────────────────────────────────────────────────────

export type SectionTone = 'brand' | 'success' | 'warning' | 'danger' | 'muted';

/** What the phone renders for one card: a heading, an optional subheading, a handful of lines. */
export type CardSection = {
  kind: string;
  title: string;
  subtitle: string | null;
  lines: string[];
  /** Lines beyond `lines` that were cut — "+3 more". */
  more: number;
  tone: SectionTone;
  /** A path on the web app this card opens (a run, a trip). */
  href: string | null;
};

const MAX_LINES = 6;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

function money(dollars: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: Number.isInteger(dollars) ? 0 : 2 }).format(dollars);
  } catch {
    return `$${dollars.toFixed(2)}`;
  }
}

function cap(lines: string[]): { lines: string[]; more: number } {
  return { lines: lines.slice(0, MAX_LINES), more: Math.max(0, lines.length - MAX_LINES) };
}

/**
 * Flatten a card into lines. Each kind picks the lines a person would want
 * on a phone; an unknown kind still renders its title and any string facts,
 * so a card the app predates is never a blank.
 */
export function cardSections(card: AssistantCard): CardSection {
  const base = { kind: card.kind, title: card.title, subtitle: str(card.subtitle), href: str(card.href) };
  switch (card.kind) {
    case 'meal_plan': {
      const lines = list(card.days).map((d) => {
        const meals = list(d.meals).map((m) => str(m.name) ?? 'open');
        return `${str(d.label) ?? str(d.date) ?? ''}: ${meals.join(', ')}`;
      });
      return { ...base, ...cap(lines), tone: 'brand' };
    }
    case 'calendar_conflict': {
      const conflicts = list(card.conflicts);
      const lines = conflicts.map((c) => `${strings(c.titles).join(' and ')} overlap ${str(c.when) ?? ''}${str(c.member) ? ` · ${str(c.member)}` : ''}`.trim());
      return { ...base, subtitle: base.subtitle ?? (conflicts.length ? null : 'No overlaps found'), ...cap(lines.length ? lines : ['Nobody is double-booked.']), tone: conflicts.length ? 'warning' : 'success' };
    }
    case 'budget_analysis': {
      const currency = str(card.currency) ?? 'USD';
      const total = num(card.total_spent);
      const limit = num(card.total_limit);
      const head = total !== null ? `${money(total, currency)}${limit !== null ? ` of ${money(limit, currency)}` : ''}` : null;
      const rows = list(card.rows).map((r) => {
        const spent = num(r.spent);
        const rowLimit = num(r.limit);
        return `${str(r.label) ?? ''}: ${spent !== null ? money(spent, currency) : ''}${rowLimit !== null ? ` / ${money(rowLimit, currency)}` : ''}${r.over === true ? ' · over' : ''}`;
      });
      const lines = [...(head ? [head] : []), ...rows, ...(str(card.insight) ? [str(card.insight) as string] : [])];
      return { ...base, subtitle: base.subtitle ?? str(card.period), ...cap(lines), tone: limit !== null && total !== null && total > limit ? 'danger' : 'brand' };
    }
    case 'vacation_prep': {
      const items = list(card.items).map((i) => `${i.done === true ? '✓' : '○'} ${str(i.label) ?? ''}${str(i.detail) ? ` — ${str(i.detail)}` : ''}`);
      const next = strings(card.next_steps).map((s) => `Next: ${s}`);
      return { ...base, subtitle: base.subtitle ?? ([str(card.destination), str(card.dates)].filter(Boolean).join(' · ') || null), ...cap([...items, ...next]), tone: 'brand' };
    }
    case 'task_group': {
      const tasks = list(card.tasks);
      const lines = tasks.map((t) => `${t.done === true ? '✓' : '○'} ${str(t.title) ?? ''}${[str(t.assignee), str(t.due)].filter(Boolean).length ? ` · ${[str(t.assignee), str(t.due)].filter(Boolean).join(' · ')}` : ''}`);
      const done = tasks.filter((t) => t.done === true).length;
      return { ...base, subtitle: base.subtitle ?? (tasks.length ? `${done} of ${tasks.length} done` : null), ...cap(lines), tone: 'brand' };
    }
    case 'grocery_list': {
      const items = list(card.items).map((i) => `${i.checked === true ? '✓' : '○'} ${str(i.name) ?? ''}${str(i.quantity) ? ` · ${str(i.quantity)}` : ''}`);
      const skipped = strings(card.skipped).length;
      const pantry = strings(card.in_pantry).length;
      const notes = [skipped ? `${skipped} already on the list` : null, pantry ? `${pantry} in the pantry` : null].filter((n): n is string => n !== null);
      return { ...base, subtitle: base.subtitle ?? (items.length ? `${items.length} ${items.length === 1 ? 'item' : 'items'}` : null), ...cap([...items, ...notes]), tone: 'brand' };
    }
    case 'readiness': {
      const score = num(card.score) ?? 0;
      const days = num(card.days_until);
      const lines = [
        ...list(card.risks).map((r) => `⚠ ${str(r.title) ?? ''}`),
        ...strings(card.recommendations).map((r, i) => `${i + 1}. ${r}`),
      ];
      return {
        ...base,
        title: `${card.title} · ${Math.round(score)}/100`,
        subtitle: base.subtitle ?? ([str(card.level), days !== null ? `${days} ${days === 1 ? 'day' : 'days'} to go` : null].filter(Boolean).join(' · ') || null),
        ...cap(lines),
        tone: score >= 80 ? 'success' : score >= 50 ? 'warning' : 'danger',
      };
    }
    case 'summary': {
      const facts = list(card.facts).map((f) => `${str(f.label) ?? ''}: ${str(f.value) ?? ''}`);
      const items = strings(card.items);
      const note = str(card.note);
      return { ...base, ...cap([...facts, ...items, ...(note ? [note] : [])]), tone: 'brand' };
    }
    case 'approval': {
      const approval = isRecord(card.approval) ? card.approval : {};
      const lines = [...(str(approval.summary) ? [str(approval.summary) as string] : []), ...strings(approval.consequences)];
      return { ...base, subtitle: base.subtitle ?? 'Approve it on the web app or in Home', ...cap(lines.length ? lines : ['Bubaly is waiting for a parent to say yes.']), tone: 'warning' };
    }
    case 'run_status': {
      const status = str(card.status) ?? 'queued';
      const done = num(card.steps_done);
      const total = num(card.steps_total);
      const lines = [...(str(card.summary) ? [str(card.summary) as string] : []), ...(total ? [`${done ?? 0} of ${total} steps`] : [])];
      const tone: SectionTone = status === 'completed' ? 'success' : status === 'failed' || status === 'cancelled' ? 'danger'
        : ['awaiting_approval', 'awaiting_context', 'blocked', 'paused', 'partially_completed'].includes(status) ? 'warning' : 'brand';
      return { ...base, subtitle: base.subtitle ?? status.replace(/_/g, ' '), ...cap(lines), tone, href: str(card.href) };
    }
    default: {
      const lines = Object.entries(card)
        .filter(([k, v]) => !['kind', 'title', 'subtitle', 'href'].includes(k) && typeof v === 'string' && v.length > 0)
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${String(v)}`);
      return { ...base, ...cap(lines), tone: 'muted' };
    }
  }
}
