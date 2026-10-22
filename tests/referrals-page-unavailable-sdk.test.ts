// Operational outages retain no referral claims or invitation controls. The
// actual page and referral reader use the installed SDK against finite REST.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createClient } from '@supabase/supabase-js';
import { notFound, redirect } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mode: 'existing', requests: [] as Array<{ table: string; method: string; query: string }>,
  codeReads: 0, authFailure: null as null | (() => never), factoryFailure: null as null | (() => never),
}));
const familyId = '11111111-1111-4111-8111-111111111111';
const catalogue = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

vi.mock('@/lib/supabase/auth', () => ({
  requireFeature: async (path: string) => {
    expect(path).toBe('/referrals');
    if (state.authFailure) state.authFailure();
    return { user: { id: '22222222-2222-4222-8222-222222222222' }, active: { familyId, family: { name: 'Synthetic' } } };
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => { if (state.factoryFailure) state.factoryFailure(); return client(); },
  createServer: async () => client(),
}));
vi.mock('@/lib/stripe', () => ({ getStripe: () => { throw new Error('No financial provider is permitted in this fixture.'); } }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => catalogue[key] ?? key }));
vi.mock('@/lib/utils/format-server', () => ({ getFormat: async () => ({ fmtMoney: (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100) }) }));
vi.mock('@/components/referrals/referral-panel', () => ({
  ReferralPanel: ({ code, alreadyReferred }: { code: string; alreadyReferred: boolean }) => createElement('article', { 'data-referral-panel': true },
    createElement('span', {}, code), createElement('button', {}, 'Synthetic invite action'),
    createElement('span', {}, alreadyReferred ? 'Referred' : 'Not referred')),
}));

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function client() {
  return createClient('https://synthetic-referrals.example.invalid', 'synthetic-key', {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      const table = url.pathname.split('/').at(-1) ?? '';
      const method = init?.method ?? 'GET';
      state.requests.push({ table, method, query: url.search });
      if (table === 'marketing_settings') return reply([{ value: { enabled: true, rewardLabel: '$10 credit' } }]);
      if (table === 'referral_codes') {
        if (method === 'GET') {
          state.codeReads++;
          expect(url.searchParams.get('family_id')).toBe('eq.' + familyId);
          expect(url.searchParams.get('select')).toBe('code');
          if (state.mode === 'rejected-code') throw new Error('Synthetic upstream transport refused');
          if (state.mode === 'malformed-code') return reply([{ code: { private: 'Synthetic malformed code' } }]);
          if (state.mode === 'new-code' || state.mode === 'upstream-code' || (state.mode === 'race' && state.codeReads === 1)) return reply([]);
          return reply([{ code: 'SYNTH-CODE' }]);
        }
        expect(method).toBe('POST');
        const body = JSON.parse(String(init?.body));
        expect(body.family_id).toBe(familyId);
        if (state.mode === 'upstream-code') return reply({ message: 'An invalid response was received from the upstream server', code: '', details: '', hint: '' }, 502);
        if (state.mode === 'rejected-code') throw new Error('Synthetic upstream transport refused');
        if (state.mode === 'race') return reply({ code: '23505', message: 'Synthetic family uniqueness conflict', details: '', hint: '' }, 409);
        return reply({ code: 'SYNTH-NEW' }, 201);
      }
      if (table === 'referrals') {
        expect(method).toBe('GET');
        if (url.searchParams.has('referrer_family_id')) {
          expect(url.searchParams.get('referrer_family_id')).toBe('eq.' + familyId);
          if (state.mode === 'list-refused') return reply({ message: 'Synthetic list refused', code: '42501' }, 403);
          if (state.mode === 'list-rejected') throw new Error('Synthetic list transport rejected');
          if (state.mode === 'malformed-list') return reply([null]);
          return reply([]);
        }
        expect(url.searchParams.get('referred_family_id')).toBe('eq.' + familyId);
        if (state.mode === 'status-refused') return reply({ message: 'Synthetic status refused', code: '42501' }, 403);
        if (state.mode === 'status-rejected') throw new Error('Synthetic status transport rejected');
        return reply(state.mode === 'already-referred' ? [{ id: '33333333-3333-4333-8333-333333333333' }] : []);
      }
      throw new Error('Unmodeled finite REST request: ' + table);
    } },
  });
}

async function pageHtml() {
  const { default: ReferralsPage } = await import('@/app/(app)/referrals/page');
  return renderToStaticMarkup(await ReferralsPage());
}
function assertUnavailable(html: string) {
  expect(html).toContain('role="alert"');
  expect(html).toContain(catalogue['root.somethingWentWrongLoadingThisSection']);
  expect(html).toContain('href="/referrals"');
  expect(html).toContain(catalogue['root.tryAgain']);
  expect(html).not.toContain('data-referral-panel');
  expect(html).not.toContain('Synthetic invite action');
  expect(html).not.toContain('tileInvited');
  expect(html).not.toContain('SYNTH-CODE');
  expect(html).not.toContain('Synthetic upstream');
  expect(html).not.toContain('private');
}

beforeEach(() => {
  state.mode = 'existing'; state.requests = []; state.codeReads = 0;
  state.authFailure = null; state.factoryFailure = null;
});

describe('referrals retain no actionable claims while page data is unavailable', () => {
  it.each(['upstream-code', 'rejected-code', 'list-refused', 'list-rejected', 'status-refused', 'status-rejected', 'malformed-code', 'malformed-list'])('%s shows an honest retry instead of a rendered referral panel', async (mode) => {
    state.mode = mode;
    assertUnavailable(await pageHtml());
    expect(state.requests.filter(row => row.table === 'referrals' && row.method !== 'GET')).toEqual([]);
  });
  it('an ordinary service factory failure exposes no operational error or referral claims', async () => {
    state.factoryFailure = () => { throw new Error('Synthetic private service credential failure'); };
    assertUnavailable(await pageHtml());
    expect(state.requests).toEqual([]);
  });
  it.each(['existing', 'new-code', 'race', 'already-referred'])('%s retains the genuine healthy panel and family-qualified SDK reads', async (mode) => {
    state.mode = mode;
    const html = await pageHtml();
    expect(html).toContain('data-referral-panel');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain(mode === 'new-code' ? 'SYNTH-NEW' : 'SYNTH-CODE');
    expect(html).toContain(mode === 'already-referred' ? '>Referred<' : '>Not referred<');
    expect(state.requests.some(row => row.table === 'referrals')).toBe(true);
    if (mode === 'race') expect(state.codeReads).toBe(2);
  });
  it.each(['redirect', 'notFound', 'ordinary'])('auth %s remains outside the operational guard and does not read referral data', async (mode) => {
    state.authFailure = mode === 'redirect' ? () => redirect('/login?redirect=%2Freferrals') : mode === 'notFound' ? () => notFound() : () => { throw new Error('Synthetic auth admission unavailable'); };
    await expect(pageHtml()).rejects.toThrow(mode === 'redirect' ? 'NEXT_REDIRECT' : mode === 'notFound' ? 'NEXT_HTTP_ERROR_FALLBACK' : 'Synthetic auth admission unavailable');
    expect(state.requests).toEqual([]);
  });
  it.each(['redirect', 'notFound'])('dependency %s signals are rethrown without an unavailable-data grant', async (mode) => {
    state.factoryFailure = mode === 'redirect' ? () => redirect('/login') : () => notFound();
    await expect(pageHtml()).rejects.toThrow(mode === 'redirect' ? 'NEXT_REDIRECT' : 'NEXT_HTTP_ERROR_FALLBACK');
    expect(state.requests).toEqual([]);
  });
  it('only a new user retry observes recovered data; the failed request does not fabricate a code', async () => {
    state.mode = 'upstream-code';
    assertUnavailable(await pageHtml());
    expect(state.requests.filter(row => row.table === 'referral_codes' && row.method === 'POST')).toHaveLength(1);
    state.mode = 'existing';
    const html = await pageHtml();
    expect(html).toContain('data-referral-panel');
    expect(html).toContain('SYNTH-CODE');
    expect(html).not.toContain('role="alert"');
  });
});
