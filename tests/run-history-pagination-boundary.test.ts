import { createClient } from '@supabase/supabase-js';
import { cloneElement, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RunHistoryPage from '@/app/(app)/dashboard/concierge/runs/page';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault } from '@/lib/i18n/locales';
import { listRuns } from '@/lib/ai/runs/store';
import { orderRunHistoryRows, parseRunHistoryCursor, type RunHistoryFilter } from '@/lib/ai/runs/history';
import { scopeForSystem } from '@/lib/services/scope';

const mocks = vi.hoisted(() => ({ server: vi.fn(), feature: vi.fn(), access: vi.fn(), translations: vi.fn(), locale: vi.fn(), forbidden: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.server, createServiceClient: mocks.forbidden }));
vi.mock('@/lib/supabase/auth', () => ({ requireFeature: mocks.feature }));
vi.mock('@/lib/server/ai-access', () => ({ assertAIAccess: mocks.access }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: mocks.translations, getLocaleContext: mocks.locale }));

const FAMILY = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const CLOCK = '2026-10-16T10:00:00.123456Z';
const messages = getMessages('en-US');
const locale = localeOrDefault('en-US');
const t = (key: string) => translate(messages, key);
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const tuple = (at: string, id: string) => `v1|${at}|${id}`;
type Row = { id: string; family_id: string; created_at: string; [key: string]: unknown };
function row(n: number, created_at = CLOCK, over: Partial<Row> = {}): Row {
  return { id: uuid(n), family_id: FAMILY, state: 'completed', status: 'executed', summary: `Synthetic run ${n}`,
    created_at, updated_at: created_at, completed_at: null, request_id: null, run_type: 'concierge', plan_id: null,
    progress: {}, error: null, result: { secret: 'PRIVATE_RESULT' }, metadata: { secret: 'PRIVATE_METADATA' }, lease_token: 'PRIVATE_LEASE', ...over };
}

// Independent integer-microsecond model of the SQL predicates, not Date-based
// timestamp ordering. The real installed Supabase/PostgREST SDK constructs all
// requests. This local transport is NOT PostgreSQL, live Auth or RLS evidence.
function micros(value: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error(`Unsupported model timestamp: ${value}`);
  return BigInt(Date.parse(`${match[1]}${match[3]}`)) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}
function exactOrder(a: Row, b: Row) {
  const difference = micros(b.created_at) - micros(a.created_at);
  return difference < 0n ? -1 : difference > 0n ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
type Fault = 'runs' | 'legacy' | 'evidence' | 'transport';
function fixture(rows: Row[], fault?: Fault) {
  const requests: URL[] = [], modelErrors: string[] = [];
  const transportFailure = new TypeError('Synthetic transport interruption');
  const db = createClient('https://run-history-pagination.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    accessToken: async () => 'synthetic-caller-token',
    global: { fetch: async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      requests.push(url);
      try {
        expect(request.method).toBe('GET');
        expect(url.origin).toBe('https://run-history-pagination.invalid');
        expect(request.headers.get('authorization')).toBe('Bearer synthetic-caller-token');
        expect(url.searchParams.get('family_id')).toBe(`eq.${FAMILY}`);
        const table = url.pathname.split('/').at(-1);
        expect(['family_automation_runs', 'ai_tool_calls']).toContain(table);
        if (fault === 'transport') throw transportFailure;
        if (fault === 'runs' && table === 'family_automation_runs'
          || fault === 'legacy' && url.searchParams.get('state') === 'in.(queued)'
          || fault === 'evidence' && table === 'ai_tool_calls') {
          return new Response(JSON.stringify({ code: '42501', message: 'Synthetic denied read' }), { status: 403, headers: { 'content-type': 'application/json' } });
        }
        if (table === 'ai_tool_calls') return new Response('[]', { headers: { 'content-type': 'application/json' } });
        const matching = rows.filter(item => [...url.searchParams].every(([key, predicate]) => {
          if (['select', 'order', 'limit'].includes(key)) return true;
          if (key === 'or') {
            const cursor = /^\(created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.gt\.([0-9a-f-]+)\)\)$/.exec(predicate);
            if (!cursor || micros(cursor[1]) !== micros(cursor[2])) throw new Error('Unsupported model tuple predicate');
            return micros(item.created_at) < micros(cursor[1]) || micros(item.created_at) === micros(cursor[1]) && item.id > cursor[3];
          }
          if (predicate.startsWith('not.in.(')) return !predicate.slice(8, -1).split(',').includes(String(item[key]));
          if (predicate.startsWith('in.(')) return predicate.slice(4, -1).split(',').includes(String(item[key]));
          if (predicate.startsWith('eq.')) return item[key] === predicate.slice(3);
          if (key === 'created_at' && predicate.startsWith('lt.')) return micros(item.created_at) < micros(predicate.slice(3));
          throw new Error(`Unsupported model predicate: ${key}=${predicate}`);
        }));
        const ordering = (url.searchParams.get('order') ?? '').split(',');
        matching.sort((a, b) => {
          for (const part of ordering) {
            if (part === 'created_at.desc') {
              const difference = micros(b.created_at) - micros(a.created_at);
              if (difference) return difference < 0n ? -1 : 1;
            } else if (part === 'id.asc') {
              if (a.id !== b.id) return a.id < b.id ? -1 : 1;
            } else throw new Error(`Unsupported model order: ${part}`);
          }
          return 0;
        });
        return new Response(JSON.stringify(matching.slice(0, Number(url.searchParams.get('limit') ?? 1000))), { headers: { 'content-type': 'application/json' } });
      } catch (cause) {
        if (cause !== transportFailure) modelErrors.push(String(cause));
        throw cause;
      }
    } },
  });
  mocks.server.mockResolvedValue(db);
  return { db, requests, modelErrors };
}
async function resolveServerChildren(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServerChildren));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (typeof node.type === 'function' && node.type.constructor.name === 'AsyncFunction') {
    return resolveServerChildren(await (node.type as (props: unknown) => Promise<ReactNode>)(node.props));
  }
  return Object.prototype.hasOwnProperty.call(node.props, 'children')
    ? cloneElement(node, {}, await resolveServerChildren(node.props.children)) : node;
}
async function open(search: { state?: string; before?: string } = {}) {
  const tree = await resolveServerChildren(await RunHistoryPage({ searchParams: Promise.resolve(search) }));
  const html = renderToStaticMarkup(createElement(LocaleProvider, { locale, source: 'cookie', messages } as Parameters<typeof LocaleProvider>[0], tree));
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map(match => ({
    href: match[1].replace(/&amp;/g, '&'), text: match[2].replace(/<[^>]*>/g, '').trim(),
  }));
  return { html, ids: links.flatMap(link => /^\/dashboard\/concierge\/runs\/[0-9a-f-]+$/.test(link.href) ? [link.href.split('/').at(-1)!] : []),
    older: links.find(link => link.text === t('runHistory.older'))?.href,
    retry: links.find(link => link.text === t('states.tryAgain'))?.href, links };
}
async function traverse(state: RunHistoryFilter = 'all') {
  const ids: string[] = [], pages: Awaited<ReturnType<typeof open>>[] = [];
  let before: string | undefined;
  for (let index = 0; index < 6; index++) {
    const page = await open({ state, before }); pages.push(page); ids.push(...page.ids);
    if (!page.older) return { ids, pages };
    const older = new URL(page.older, 'https://synthetic.invalid');
    expect(older.pathname).toBe('/dashboard/concierge/runs');
    expect(older.searchParams.get('state')).toBe(state === 'all' ? null : state);
    before = older.searchParams.get('before') ?? undefined;
    expect(before).toBeTruthy();
  }
  throw new Error('Pagination did not terminate within the fixture bound');
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.forbidden.mockImplementation(() => { throw new Error('Unexpected global network or service-role client'); });
  vi.stubGlobal('fetch', mocks.forbidden);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.feature.mockResolvedValue({ user: { id: 'synthetic-user' }, active: { familyId: FAMILY, family: { timezone: 'Asia/Tokyo' }, member: { id: 'synthetic-member' }, role: 'parent' } });
  mocks.access.mockResolvedValue({ ok: true });
  mocks.translations.mockResolvedValue(t);
  mocks.locale.mockResolvedValue({ locale });
});
afterEach(() => {
  try { expect(mocks.forbidden).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe('rendered run-history pagination over real SDK requests', () => {
  it.each<RunHistoryFilter>(['all', 'active', 'waiting', 'done', 'problems'])('walks every tied row once across the %s vocabulary merge', async state => {
    const vocabulary = { all: ['completed', 'executed'], active: ['executing', 'future_status'], waiting: ['awaiting_approval', 'pending'], done: ['completed', 'executed'], problems: ['failed', 'failed'] }[state];
    const eligible = Array.from({ length: 67 }, (_, index) => row(index + 1, CLOCK, index % 2
      ? { state: 'queued', status: vocabulary[1] } : { state: vocabulary[0], status: vocabulary[1] }));
    const noise = [row(800, CLOCK, { family_id: FOREIGN }), ...(state === 'all' ? [] : [row(801, CLOCK, { state: state === 'done' ? 'executing' : 'completed', status: 'executed' })])];
    const f = fixture([...eligible].reverse().concat(noise));
    const result = await traverse(state);
    expect(f.modelErrors).toEqual([]);
    expect(result.ids).toEqual([...eligible].sort(exactOrder).map(item => item.id));
    expect(new Set(result.ids).size).toBe(67);
    expect(result.pages.map(page => page.ids.length)).toEqual([30, 30, 7]);
    expect(result.pages.at(-1)?.older).toBeUndefined();
    expect(result.pages.every(page => !/PRIVATE_(?:RESULT|METADATA|LEASE)/.test(page.html))).toBe(true);
    const reads = f.requests.filter(url => url.pathname.endsWith('/family_automation_runs'));
    expect(reads).toHaveLength(state === 'all' ? 3 : 6);
    for (const url of reads) {
      expect(url.searchParams.get('order')).toBe('created_at.desc,id.asc');
      expect(url.searchParams.get('limit')).toBe('31');
    }
    expect(mocks.feature).toHaveBeenCalledWith('/dashboard/concierge/runs');
    expect(mocks.access.mock.calls.every(call => call[1].db === f.db)).toBe(true);
    expect(result.pages[1].links.find(link => link.text === t('runHistory.newest'))?.href).toBe(state === 'all' ? '/dashboard/concierge/runs' : `/dashboard/concierge/runs?state=${state}`);
  });

  it('keeps distinct microseconds in newest-first order and in the emitted next-page cursor', async () => {
    const rows = Array.from({ length: 65 }, (_, index) => row(index + 1, `2026-10-16T10:00:00.${123001 + index}Z`));
    const f = fixture(rows);
    const result = await traverse();
    expect(f.modelErrors).toEqual([]);
    expect(result.ids).toEqual([...rows].sort(exactOrder).map(item => item.id));
    expect(result.pages.map(page => page.ids.length)).toEqual([30, 30, 5]);
    const encoded = new URL(result.pages[0].older!, 'https://synthetic.invalid').searchParams.get('before');
    expect(encoded).toBe(tuple('2026-10-16T10:00:00.123036Z', uuid(36)));
    expect(f.requests.find(url => url.searchParams.has('or'))?.searchParams.get('or')).toContain('created_at.lt.2026-10-16T10:00:00.123036Z');
  });

  it('sorts exact offset-equivalent instants by ID only when their instants are equal', () => {
    const rows = [row(9, '2026-10-16T12:00:00.123457+02:00'), row(1, CLOCK), row(2, '2026-10-16T12:00:00.123456+02:00')];
    expect(orderRunHistoryRows(rows).map(item => item.id)).toEqual([uuid(9), uuid(1), uuid(2)]);
    expect(orderRunHistoryRows([...rows].reverse()).map(item => item.id)).toEqual([uuid(9), uuid(1), uuid(2)]);
  });

  it('keeps the legacy strict-before bookmark and preserves its microsecond cutoff', async () => {
    const f = fixture([row(1, '2026-10-16T10:00:00.123455Z'), row(2, CLOCK), row(3, '2026-10-16T10:00:00.123457Z')]);
    const page = await open({ before: CLOCK });
    expect(f.modelErrors).toEqual([]);
    expect(page.ids).toEqual([uuid(1)]);
    expect(f.requests[0].searchParams.get('created_at')).toBe(`lt.${CLOCK}`);
    expect(f.requests[0].searchParams.has('or')).toBe(false);
  });

  it('renders genuine empty and terminal pages without inventing an Older link', async () => {
    const f = fixture([]);
    const first = await open();
    expect(first.html).toContain(t('runHistory.nothingYetTheFirstThing'));
    const last = await open({ before: tuple(CLOCK, uuid(1)) });
    expect(last.html).toContain(t('runHistory.noOlderRunsHere'));
    expect(first.ids).toEqual([]); expect(last.ids).toEqual([]);
    expect(first.older).toBeUndefined(); expect(last.older).toBeUndefined();
    expect(f.modelErrors).toEqual([]);
  });

  it.each<Fault>(['runs', 'legacy', 'evidence', 'transport'])('keeps %s failure distinct from an empty family and preserves the exact retry cursor', async fault => {
    const cursor = tuple(CLOCK, uuid(1));
    const f = fixture([row(2), row(3, CLOCK, { state: 'queued', status: 'executed' })], fault);
    const page = await open({ state: 'done', before: cursor });
    expect(f.modelErrors).toEqual([]);
    expect(page.retry).toBeTruthy();
    const retry = new URL(page.retry!, 'https://synthetic.invalid');
    expect(retry.searchParams.get('before')).toBe(cursor);
    expect(retry.searchParams.get('state')).toBe('done');
    expect(page.ids).toEqual([]); expect(page.older).toBeUndefined();
    expect(page.html).not.toContain(t('runHistory.nothingYetTheFirstThing'));
    expect(page.html).not.toContain(t('runHistory.noOlderRunsHere'));
  });

  it.each([404, 503])('does not list runs when the AI access boundary returns %i', async status => {
    const f = fixture([row(1)]);
    mocks.access.mockResolvedValue({ ok: false, status, error: 'Synthetic access unavailable' });
    const page = await open();
    expect(page.ids).toEqual([]); expect(f.requests).toEqual([]);
    expect(page.html).toContain(status === 404 ? t('appNotFound.title').replace(/'/g, '&#x27;') : 'Synthetic access unavailable');
  });

  it('preserves a feature-gate redirect before selecting a client or listing rows', async () => {
    const f = fixture([row(1)]), redirect = new Error('SYNTHETIC_FEATURE_REDIRECT');
    mocks.feature.mockRejectedValue(redirect);
    await expect(open()).rejects.toBe(redirect);
    expect(mocks.server).not.toHaveBeenCalled(); expect(mocks.access).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
  });
});

describe('bounded run-history cursor admission', () => {
  it.each([
    [tuple(CLOCK, uuid(11)), tuple(CLOCK, uuid(11))],
    [tuple('2026-10-16T12:00:00.123456+02:00', uuid(11).toUpperCase()), tuple(CLOCK, uuid(11))],
    [tuple('2026-10-16T10:00:00Z', uuid(11)), tuple('2026-10-16T10:00:00.000Z', uuid(11))],
    [tuple('2026-10-16T10:00:00.123456000Z', uuid(11)), tuple(CLOCK, uuid(11))],
    [tuple('2024-02-29T10:00:00.999999Z', '00000000-0000-0000-0000-000000000000'), tuple('2024-02-29T10:00:00.999999Z', '00000000-0000-0000-0000-000000000000')],
    [CLOCK, CLOCK],
    ['2026-10-16T12:00:00.123456+02:00', CLOCK],
    ['2026-10-16T10:00:00Z', '2026-10-16T10:00:00.000Z'],
  ])('normalizes %s without losing its represented microsecond', (raw, wanted) => {
    expect(parseRunHistoryCursor(raw)).toBe(wanted);
  });

  const invalid = [
    'not-a-date', tuple('2026-02-30T10:00:00Z', uuid(1)), tuple('2026-10-16T25:00:00Z', uuid(1)),
    tuple('2026-10-16T10:00:00', uuid(1)), tuple('2026-10-16T10:00:00.123456001Z', uuid(1)),
    tuple(CLOCK, 'not-a-uuid'), tuple(CLOCK, `${uuid(1)},id.gt.0`), tuple(CLOCK, uuid(1)) + '|extra',
    'v2|' + CLOCK + '|' + uuid(1), `v1|${CLOCK},created_at.gt.1900-01-01|${uuid(1)}`,
    tuple(CLOCK, uuid(1)) + '\n', 'x'.repeat(200), '2026-02-30T10:00:00Z', '2026-10-16T10:00:00.123456001Z',
  ];
  it.each(invalid)('drops invalid URL cursor %s before it becomes a query predicate', async raw => {
    expect(parseRunHistoryCursor(raw)).toBeNull();
    const f = fixture([row(1)]);
    const page = await open({ before: raw });
    expect(page.ids).toEqual([uuid(1)]);
    expect(f.modelErrors).toEqual([]);
    expect(f.requests[0].searchParams.has('or')).toBe(false);
    expect(f.requests[0].searchParams.has('created_at')).toBe(false);
  });

  it.each(invalid)('refuses direct listRuns cursor %s before any request', async before => {
    const f = fixture([]);
    const result = await listRuns(scopeForSystem(f.db, { id: FAMILY }), { before });
    expect(f.requests).toEqual([]);
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(f.modelErrors).toEqual([]);
  });

  it('keeps the direct-store limit clamp and the caller client for healthy reads', async () => {
    const rows = Array.from({ length: 210 }, (_, index) => row(index + 1));
    const f = fixture([...rows].reverse());
    const scope = scopeForSystem(f.db, { id: FAMILY });
    const capped = await listRuns(scope, { limit: 1000 });
    expect(capped.ok && capped.data.map(item => item.id)).toEqual(rows.slice(0, 200).map(item => item.id));
    const one = await listRuns(scope, { limit: 0 });
    expect(one.ok && one.data.map(item => item.id)).toEqual([uuid(1)]);
    expect(f.requests.map(url => url.searchParams.get('limit'))).toEqual(['200', '1']);
    expect(f.modelErrors).toEqual([]);
  });
});
