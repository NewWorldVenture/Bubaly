// N15 — the Planning hub's per-card fail-safe kept `{ data, count }` and dropped
// PostgREST's `error`. A read that answered `{ data: null, error }` (a timeout,
// a refused read) was neither caught nor logged, so its card said "No upcoming
// events", "No open tasks", "0 documents" — a claim about the family made from
// a read that never happened.
//
// The real page, rendered inside the real LocaleProvider against the in-memory
// database, with chosen reads answering an error the way supabase-js does.
import { cloneElement, createElement, isValidElement, type ReactNode } from 'react';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { LOCALE_COOKIE, localeOrDefault } from '@/lib/i18n/locales';

const FAMILY = 'fam-plan';
const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'p@example.test' }, memberships: [],
    active: { familyId: 'fam-plan', role: 'parent', member: { id: 'member-1' }, family: { id: 'fam-plan', timezone: 'UTC' } },
  }),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === LOCALE_COOKIE ? { value: 'en-US' } : undefined) }),
  headers: async () => new Headers(),
}));

const { default: PlanningPage } = await import('@/app/(app)/dashboard/planning/page');
const { LocaleProvider } = await import('@/components/i18n/locale-provider');
const { getMessages } = await import('@/lib/i18n/messages');

const COULD_NOT_LOAD = 'This couldn’t be loaded. Refresh to try again.';
let db: InMemorySupabase;
let failing: string[];

/**
 * The page's cards are async server components (each awaits its translator),
 * which a static render cannot await: they are resolved first, as the server
 * would, and the rest is rendered as it is.
 */
async function resolveAsync(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (typeof node.type === 'function' && node.type.constructor.name === 'AsyncFunction') {
    return resolveAsync(await (node.type as (props: unknown) => Promise<ReactNode>)(node.props));
  }
  if (node.props.children === undefined) return node;
  return cloneElement(node, undefined, await resolveAsync(node.props.children));
}

async function open(): Promise<string> {
  const tree = await resolveAsync(await PlanningPage());
  return renderToStaticMarkup(createElement(
    LocaleProvider,
    { locale: localeOrDefault('en-US'), source: 'cookie', messages: getMessages('en-US') } as Parameters<typeof LocaleProvider>[0],
    tree as React.ReactElement,
  )).replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');
}

/** The text of the card titled `title`. */
function card(html: string, title: string): string {
  const at = html.indexOf(`>${title}</h2>`);
  expect(at, `no "${title}" card`).toBeGreaterThan(-1);
  const end = html.indexOf('</section>', at);
  return html.slice(at, end).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  failing = [];
  h.db = withFaults(db as unknown as SupabaseClient<Database>, (table) => (failing.includes(table) ? { message: 'canceling statement due to statement timeout', code: '57014' } : null));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('notes', [{ id: 'n-1', family_id: FAMILY, title: 'Packing list', body: 'Sunscreen', updated_at: '2026-10-10T00:00:00Z' }]);
});

describe('the planning hub', () => {
  it('says a card could not be read, claims no count for it, and logs why', async () => {
    failing = ['calendar_events', 'documents'];
    const html = await open();

    const calendar = card(html, 'Calendar');
    expect(calendar).toContain(COULD_NOT_LOAD);
    expect(calendar).not.toContain('No upcoming events');
    expect(calendar).toContain('— upcoming events');
    expect(calendar).not.toContain('0 upcoming events');

    const documents = card(html, 'Documents');
    expect(documents).toContain(COULD_NOT_LOAD);
    expect(documents).not.toContain('0 documents');

    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(logged).toContain('[planning] calendar read failed');
    expect(logged).toContain('[planning] documents read failed');
  });

  it('every other card reads as it always did', async () => {
    failing = ['calendar_events'];
    const html = await open();
    expect(card(html, 'Notes')).toContain('Packing list');
    expect(card(html, 'Notes')).toContain('1 notes');
    expect(card(html, 'Tasks')).toContain('No open tasks');
    expect(card(html, 'Tasks')).not.toContain(COULD_NOT_LOAD);
  });

  it('an empty family that WAS read is still told it is empty', async () => {
    const html = await open();
    expect(card(html, 'Calendar')).toContain('0 upcoming events');
    expect(html).not.toContain(COULD_NOT_LOAD);
  });
});
