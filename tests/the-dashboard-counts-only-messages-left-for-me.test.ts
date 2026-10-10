// The family dashboard's "Unread messages" counts only messages waiting for me.
//
// THE DEFECT. `FamilyDashboard` counted `family_messages` of the family that
// the reader's id was not in `read_by`, and nothing else. Two kinds of message
// matched that are not unread messages:
//
//   * a message its sender DELETED (`deleted_at` set). The chat shows it as
//     "message deleted"; the dashboard still said it was waiting to be read;
//   * a message the reader SENT. A sender is not added to `read_by`, so every
//     message a parent wrote counted as one they had not read.
//
// The sidebar badge on the same screen (components/app/app-frame.tsx,
// components/app/free-tier-sidebar.tsx) already applies both filters, so the
// card and the badge disagreed, and the "You have N unread messages"
// suggestion pointed at messages that were not there.
//
// The PostgREST double below evaluates the filters the way Postgres does
// (`neq` never matches a NULL, `cs` takes an array literal), and refuses any
// operator it does not know, so a filter cannot pass by being ignored.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Database } from '@/lib/database.types';
import type { UserContext } from '@/lib/supabase/auth';
import { getMessages } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { localeOrDefault } from '@/lib/i18n/locales';

const h = vi.hoisted(() => ({ db: null as SupabaseClient<Database> | null }));
// The calendar half is covered by tests/family-dashboard-calendar-boundary.test.ts.
vi.mock('@/lib/calendar/source-capability', () => ({ CALENDAR_SOURCE_ARCHIVE_ENABLED: true }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) =>
    translate(getMessages('en-US'), key, params),
  getLocaleContext: async () => ({ locale: localeOrDefault('en-US') }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('@/components/dashboard/dashboard-weather', () => ({ DashboardWeather: () => null }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
import { FamilyDashboard } from '@/components/dashboard/family-dashboard';

const t = (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params);

const FAMILY = '10000000-0000-4000-8000-000000000001';
const OTHER_FAMILY = '10000000-0000-4000-8000-000000000002';
const ME = '30000000-0000-4000-8000-000000000001';
const SIBLING = '30000000-0000-4000-8000-000000000002';

type Message = { id: string; family_id: string; sender_id: string | null; read_by: string[]; deleted_at: string | null };

function message(id: string, patch: Partial<Message>): Message {
  return { id, family_id: FAMILY, sender_id: SIBLING, read_by: [], deleted_at: null, ...patch };
}

/** One PostgREST filter, `column=[not.]op.value`, evaluated as Postgres would. */
function holds(row: Record<string, unknown>, column: string, raw: string): boolean {
  const negated = raw.startsWith('not.');
  const body = negated ? raw.slice(4) : raw;
  const dot = body.indexOf('.');
  const op = body.slice(0, dot);
  const arg = body.slice(dot + 1);
  const cell = row[column] ?? null;
  let result: boolean;
  switch (op) {
    case 'eq': result = cell !== null && String(cell) === arg; break;
    // `x <> y` is NULL, never true, when x is NULL.
    case 'neq': result = cell !== null && String(cell) !== arg; break;
    case 'is':
      if (arg !== 'null') throw new Error(`unsupported is.${arg}`);
      result = cell === null;
      break;
    case 'cs': {
      const wanted = arg.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
      result = Array.isArray(cell) && wanted.every((value) => cell.includes(value));
      break;
    }
    default: throw new Error(`[test double] unsupported filter ${column}=${raw}`);
  }
  return negated ? !result : result;
}

let messages: Message[] = [];
let messageReads: URL[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
  messageReads = [];
  h.db = createClient<Database>('https://family-dashboard.synthetic.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const empty = { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' };
        if (!url.pathname.endsWith('/family_messages')) {
          return new Response(init?.method === 'HEAD' ? null : '[]', { headers: empty });
        }
        messageReads.push(url);
        let rows: Record<string, unknown>[] = messages;
        for (const [column, raw] of url.searchParams) {
          if (['select', 'order', 'offset', 'limit'].includes(column)) continue;
          rows = rows.filter((row) => holds(row, column, raw));
        }
        return new Response(init?.method === 'HEAD' ? null : JSON.stringify(rows), {
          headers: { 'Content-Type': 'application/json', 'Content-Range': `*/${rows.length}` },
        });
      },
    },
  });
});
afterEach(() => vi.useRealTimers());

async function unreadCard(): Promise<{ count: number; html: string }> {
  const ctx = {
    user: { id: ME, email: null },
    memberships: [],
    active: {
      familyId: FAMILY,
      family: { id: FAMILY, timezone: 'America/New_York' },
      role: 'parent',
      member: { id: '20000000-0000-4000-8000-000000000001', user_id: ME, display_name: 'Synthetic' },
    },
  };
  const html = renderToStaticMarkup(await FamilyDashboard({ ctx: ctx as unknown as UserContext }));
  const label = t('familyDashboard.unreadMessages').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const card = new RegExp(`text-2xl font-bold leading-none">(\\d+)</p><p class="mt-0.5 text-xs text-muted">${label}</p>`).exec(html);
  expect(card, 'the Unread Messages card').not.toBeNull();
  expect(messageReads).toHaveLength(1);
  return { count: Number(card![1]), html };
}

it('counts a message someone else sent me that I have not read', async () => {
  messages = [message('m-unread', {}), message('m-read', { read_by: [ME] })];
  expect((await unreadCard()).count).toBe(1);
});

it('does not count a message its sender deleted', async () => {
  messages = [message('m-unread', {}), message('m-deleted', { deleted_at: '2026-10-05T09:00:00Z' })];
  expect((await unreadCard()).count).toBe(1);
});

it('does not count a message I sent', async () => {
  messages = [message('m-unread', {}), message('m-mine', { sender_id: ME })];
  expect((await unreadCard()).count).toBe(1);
});

it('does not count another family’s messages', async () => {
  messages = [message('m-unread', {}), message('m-theirs', { family_id: OTHER_FAMILY })];
  expect((await unreadCard()).count).toBe(1);
});

it('says nothing is waiting when only deleted and my own messages are unread', async () => {
  messages = [message('m-deleted', { deleted_at: '2026-10-05T09:00:00Z' }), message('m-mine', { sender_id: ME })];
  const { count, html } = await unreadCard();
  expect(count).toBe(0);
  expect(html).not.toContain(t('familyDashboard.unreadMessagesOne'));
  expect(html).not.toContain(t('familyDashboard.unreadMessagesMany', { n: 2 }));
});
