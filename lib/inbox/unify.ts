// lib/inbox/unify.ts — one household inbox out of three persisted sources.
//
// A family's inbound life currently lands in three different tables and three
// different screens: the Contact Center files email/SMS/voice into
// `family_inbox_messages`, paperwork triage files forms and bills into
// `paperwork_items`, and the Communications Hub keeps a hand-written log in
// `family_communications`. Nothing merged them, so "what needs me?" meant
// visiting three places and holding the ranking in your head.
//
// This module does the merge and the ranking, and nothing else: it is pure, it
// takes rows in and returns a list, and it never talks to Supabase. The page
// (`app/(app)/dashboard/inbox/page.tsx`) owns the reads and the fail-closed
// behaviour; the queue component owns the words.
//
// WHY NO ENGLISH LIVES HERE: every string this returns is either copied from a
// row the family wrote (a subject, a title, a summary) or is absent. When a row
// has no usable title the module returns an empty `title` and the component
// renders a catalogue key — a label invented here would be an untranslatable
// string in a lib the i18n scanner does not read.
//
// WHY NON-TELEPHONY SOURCES ARE MERGED AT READ TIME rather than inserted into
// `family_inbox_messages`: that table's `channel` CHECK admits only
// ('email','sms','voice') and its RLS grants members SELECT only. Writing a
// paperwork row or a pasted note into it would need a migration (see the DDL
// noted in the work queue). Merging at read time needs none and loses nothing —
// each source keeps its own table, its own RLS and its own writers.

/** Which table an item came from. Stable, because the UI links per source. */
export type InboxSource = 'contact_center' | 'paperwork' | 'communications';

/** What the item IS, independent of where it is stored. */
export type InboxItemKind = 'message' | 'paperwork' | 'communication';

/**
 * Why an item sits where it does in the queue. The component turns this into a
 * translated badge; keeping it an enum means the reason is testable and the
 * copy is replaceable.
 */
export type InboxReason = 'urgent' | 'soon' | 'unread' | 'recent';

/**
 * WHO closed a row, which is not the same question as whether it is closed.
 *
 *   'bubaly' — `family_inbox_messages.ai_handled`: an `ai_requests` row exists
 *              for this message. That is ALL it proves. The run may still be
 *              queued, parked waiting for a parent's answer, or failed, so the
 *              only honest word for it is "filed with Bubaly" — never "handled".
 *   'family' — a person moved the row to a terminal status (paperwork done or
 *              archived, a communication replied to or archived).
 *
 * The component picks its wording from this; a single "Handled" badge across
 * both would claim Bubaly finished work a person actually did, and claim
 * completion for a run that has not run.
 */
export type InboxHandledBy = 'bubaly' | 'family';

export type UnifiedInboxItem = {
  kind: InboxItemKind;
  /** Unique across sources: `<source>:<row id>`, so React keys and form values never collide. */
  id: string;
  /** The row's own id, for the server action that has to find it again. */
  rowId: string;
  /** Copied from the row. Empty when the row carries no usable title. */
  title: string;
  /** One line of the body/summary, already collapsed and capped. */
  snippet: string;
  /** ISO instant this happened, for display and for the recency tiebreak. */
  occurredAt: string;
  source: InboxSource;
  /**
   * TRUE ONLY WHEN A ROW SAYS SO — `ai_handled` for a contact-center message,
   * a terminal status for paperwork and communications. Never optimistic.
   */
  handled: boolean;
  /** Which of those two facts made `handled` true; null when it is false. */
  handledBy: InboxHandledBy | null;
  reason: InboxReason;
  /** 0 = most urgent. Exposed so a test can pin the ordering contract. */
  rank: number;
  /** The classifier's intent for contact-center rows; null elsewhere. */
  intent: string | null;
  /** The row's channel/category, for the icon. */
  channel: string;
  /** Extracted due date (paperwork), when there is one. */
  dueOn: string | null;
  /** Whether "Handle it" applies: only contact-center rows enter the intake from here. */
  canHandle: boolean;
  /** Where the row's own surface lives, so the queue links out rather than duplicating it. */
  href: string;
};

/** The `family_inbox_messages` columns this module reads (0214). */
export type InboxMessageRow = {
  id: string;
  channel: string;
  direction: string;
  from_addr: string | null;
  subject: string | null;
  body: string | null;
  ai_summary: string | null;
  ai_intent: string | null;
  ai_handled: boolean;
  status: string;
  occurred_at: string;
};

/** The `paperwork_items` columns this module reads (0169). */
export type PaperworkRow = {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  sender: string | null;
  due_on: string | null;
  urgency: string;
  status: string;
  created_at: string;
};

/** The `family_communications` columns this module reads (00900). */
export type CommunicationRow = {
  id: string;
  channel: string;
  subject: string | null;
  body: string | null;
  summary: string | null;
  category: string;
  status: string;
  priority: string;
  received_at: string;
};

export type UnifyInput = {
  messages?: InboxMessageRow[] | null;
  paperwork?: PaperworkRow[] | null;
  communications?: CommunicationRow[] | null;
  now?: Date;
};

const SNIPPET_MAX = 160;

/** Collapse whitespace and cap, the way an inbox preview line reads. */
export function snippetOf(text: string | null | undefined, max = SNIPPET_MAX): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** The first meaningful line of a body, used when a row has no subject of its own. */
function firstLine(text: string | null | undefined): string {
  const line = (text ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return snippetOf(line, 90);
}

/** Whole days from `now` to a `YYYY-MM-DD` date; null when there is no date. */
export function daysUntil(dueOn: string | null | undefined, now: Date): number | null {
  if (!dueOn) return null;
  const due = new Date(`${dueOn}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) return null;
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((due.getTime() - start) / 86_400_000);
}

/**
 * The ranking the strategy asks for, in one place:
 *
 *   0  urgent      — the classifier said urgent, or a deadline is here
 *   1  soon        — an appointment/delivery, or a deadline inside a week
 *   2  unread      — nobody has looked at it yet
 *   3  recent      — everything else, newest first
 *
 * Handled rows keep their reason but sort after every unhandled row, so
 * "already dealt with" never outranks "still needs you".
 */
export function reasonFor(item: {
  intent: string | null;
  urgency?: string | null;
  priority?: string | null;
  dueOn?: string | null;
  unread: boolean;
  now: Date;
}): InboxReason {
  const days = daysUntil(item.dueOn, item.now);
  if (item.intent === 'urgent') return 'urgent';
  if (item.urgency === 'urgent') return 'urgent';
  if (item.priority === 'urgent') return 'urgent';
  if (days !== null && days <= 2) return 'urgent';
  if (item.intent === 'appointment' || item.intent === 'delivery') return 'soon';
  if (item.urgency === 'soon') return 'soon';
  if (item.priority === 'high') return 'soon';
  if (days !== null && days <= 7) return 'soon';
  if (item.unread) return 'unread';
  return 'recent';
}

const REASON_RANK: Record<InboxReason, number> = { urgent: 0, soon: 1, unread: 2, recent: 3 };

export function rankFor(reason: InboxReason): number {
  return REASON_RANK[reason];
}

function messageItem(row: InboxMessageRow, now: Date): UnifiedInboxItem {
  const unread = row.status === 'new';
  const reason = reasonFor({ intent: row.ai_intent, unread, now });
  return {
    kind: 'message',
    id: `contact_center:${row.id}`,
    rowId: row.id,
    title: snippetOf(row.subject, 90) || snippetOf(row.from_addr, 90) || firstLine(row.body),
    snippet: snippetOf(row.ai_summary) || snippetOf(row.body),
    occurredAt: row.occurred_at,
    source: 'contact_center',
    // The row is the only authority: `ai_handled` is set after a request was
    // persisted, never before — and it says the message reached Bubaly, not
    // that Bubaly finished with it.
    handled: row.ai_handled === true,
    handledBy: row.ai_handled === true ? 'bubaly' : null,
    reason,
    rank: rankFor(reason),
    intent: row.ai_intent,
    channel: row.channel,
    dueOn: null,
    // Outbound rows are the concierge's own replies; there is nothing to hand
    // to the planner, and an already-handled row must not be handled twice.
    canHandle: row.direction === 'inbound' && row.ai_handled !== true,
    href: '/dashboard/contact-center',
  };
}

function paperworkItem(row: PaperworkRow, now: Date): UnifiedInboxItem {
  const unread = row.status === 'needs_action';
  const reason = reasonFor({ intent: null, urgency: row.urgency, dueOn: row.due_on, unread, now });
  return {
    kind: 'paperwork',
    id: `paperwork:${row.id}`,
    rowId: row.id,
    title: snippetOf(row.title, 90),
    snippet: snippetOf(row.summary) || snippetOf(row.sender),
    occurredAt: row.created_at,
    source: 'paperwork',
    handled: row.status === 'done' || row.status === 'archived',
    // A person moved it; nothing here is a claim about Bubaly.
    handledBy: row.status === 'done' || row.status === 'archived' ? 'family' : null,
    reason,
    rank: rankFor(reason),
    intent: null,
    channel: row.kind,
    dueOn: row.due_on,
    canHandle: false,
    href: '/dashboard/paperwork',
  };
}

function communicationItem(row: CommunicationRow, now: Date): UnifiedInboxItem {
  const unread = row.status === 'unread';
  const reason = reasonFor({ intent: null, priority: row.priority, unread, now });
  return {
    kind: 'communication',
    id: `communications:${row.id}`,
    rowId: row.id,
    title: snippetOf(row.subject, 90) || firstLine(row.body),
    snippet: snippetOf(row.summary) || snippetOf(row.body),
    occurredAt: row.received_at,
    source: 'communications',
    handled: row.status === 'replied' || row.status === 'archived',
    handledBy: row.status === 'replied' || row.status === 'archived' ? 'family' : null,
    reason,
    rank: rankFor(reason),
    intent: null,
    channel: row.channel,
    dueOn: null,
    canHandle: false,
    href: '/dashboard/inbox',
  };
}

function timeOf(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Merge the three sources into one ranked queue.
 *
 * Sort order: unhandled before handled, then rank, then newest first. The sort
 * is total (id breaks the final tie) so the same rows always produce the same
 * order — a queue that reshuffles between renders is a queue nobody trusts.
 */
export function unifyInbox(input: UnifyInput): UnifiedInboxItem[] {
  const now = input.now ?? new Date();
  const items: UnifiedInboxItem[] = [
    ...(input.messages ?? []).map((row) => messageItem(row, now)),
    ...(input.paperwork ?? []).map((row) => paperworkItem(row, now)),
    ...(input.communications ?? []).map((row) => communicationItem(row, now)),
  ];
  return items.sort((a, b) => {
    if (a.handled !== b.handled) return a.handled ? 1 : -1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    const t = timeOf(b.occurredAt) - timeOf(a.occurredAt);
    if (t !== 0) return t;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** How many rows still need a human — what the page badges. */
export function countNeedsYou(items: UnifiedInboxItem[]): number {
  return items.filter((i) => !i.handled).length;
}
