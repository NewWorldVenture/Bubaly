import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { cloneElement, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault } from '@/lib/i18n/locales';

const mocks = vi.hoisted(() => ({
  client: vi.fn(), read: vi.fn(), translations: vi.fn(),
  create: vi.fn(), update: vi.fn(), publish: vi.fn(), archive: vi.fn(),
  forbidden: vi.fn(() => { throw new Error('Unexpected network or SDK access'); }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.client }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.forbidden }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.forbidden, createBrowserClient: mocks.forbidden }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: mocks.translations }));
vi.mock('@/app/(app)/admin/marketing/actions', () => ({
  createLandingPage: mocks.create, updateLandingPage: mocks.update,
  setLandingPublished: mocks.publish, archiveLandingPage: mocks.archive,
}));

const messages = getMessages('en-US');
const failureLog = '[admin-marketing-landing-pages] landing page read failed';
const privateDetail = 'SYNTHETIC_PRIVATE_DETAIL https://synthetic.invalid/?token=SYNTHETIC_SECRET';
const queryCalls: unknown[][] = [];
const rows = [false, true].map((published, index) => ({
  id: `synthetic-page-${index}`, title: published ? 'Published landing page' : 'Draft landing page',
  slug: `synthetic-slug-${index}`, headline: `Synthetic headline ${index}`, subhead: null,
  body: 'Synthetic body', metadata: { cta_label: 'Synthetic CTA', cta_href: '/signup' },
  published, views: 12 + index, conversions: 3 + index,
}));

function query() {
  const chain = {
    select(...args: unknown[]) { queryCalls.push(['select', ...args]); return chain; },
    is(...args: unknown[]) { queryCalls.push(['is', ...args]); return chain; },
    order(...args: unknown[]) { queryCalls.push(['order', ...args]); return chain; },
    then(resolve: (value: unknown) => unknown, reject: (cause: unknown) => unknown) {
      return mocks.read().then(resolve, reject);
    },
  };
  return chain;
}

// Resolve the real nested async error component, then render the ordinary UI
// components through React. Neither the page's actions nor SDKs are executed.
async function resolveServerChildren(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) {
    const children = await Promise.all(node.map(resolveServerChildren));
    return children.every((child, index) => child === node[index]) ? node : children;
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (typeof node.type === 'function' && node.type.constructor.name === 'AsyncFunction') {
    const component = node.type as (props: unknown) => Promise<ReactNode>;
    return resolveServerChildren(await component(node.props));
  }
  if (!Object.prototype.hasOwnProperty.call(node.props, 'children')) return node;
  const children = await resolveServerChildren(node.props.children);
  return children === node.props.children ? node : cloneElement(node, {}, children);
}

function forms(node: ReactNode): Array<{ action?: unknown; children?: ReactNode }> {
  if (Array.isArray(node)) return node.flatMap(forms);
  if (!isValidElement<{ action?: unknown; children?: ReactNode }>(node)) return [];
  return [...(node.type === 'form' ? [node.props] : []), ...forms(node.props.children)];
}

async function renderPage() {
  const { default: Page } = await import('@/app/(app)/admin/marketing/landing-pages/page');
  const tree = await resolveServerChildren(await Page());
  const html = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: localeOrDefault('en-US'), source: 'cookie', messages,
  } as Parameters<typeof LocaleProvider>[0], tree));
  expect(mocks.client).toHaveBeenCalledTimes(1);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(queryCalls).toEqual([
    ['from', 'marketing_landing_pages'], ['select', '*'], ['is', 'deleted_at', null],
    ['order', 'created_at', { ascending: false }],
  ]);
  return { tree, html, text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() };
}

function expectReadError(result: Awaited<ReturnType<typeof renderPage>>) {
  expect(result.text).toContain(messages['landingPages.couldNotLoadLandingPages']);
  expect(result.text).toContain(messages['landingPages.refreshLandingPages']);
  expect(result.html).toContain('href="/admin/marketing/landing-pages"');
  expect(result.text).not.toContain(messages['adminMarketingLandingPages.noLandingPagesYet']);
  expect(result.text).not.toContain(messages['adminMarketingLandingPages.newLandingPage']);
  expect(result.text).not.toContain('Synthetic');
  expect(result.html).not.toContain(privateDetail);
  expect(forms(result.tree)).toHaveLength(0);
}

beforeEach(() => {
  vi.resetAllMocks();
  queryCalls.length = 0;
  mocks.forbidden.mockImplementation(() => { throw new Error('Unexpected network or SDK access'); });
  vi.stubGlobal('fetch', mocks.forbidden);
  vi.spyOn(http, 'request').mockImplementation(mocks.forbidden);
  vi.spyOn(http, 'get').mockImplementation(mocks.forbidden);
  vi.spyOn(https, 'request').mockImplementation(mocks.forbidden);
  vi.spyOn(https, 'get').mockImplementation(mocks.forbidden);
  vi.spyOn(net, 'connect').mockImplementation(mocks.forbidden);
  vi.spyOn(net, 'createConnection').mockImplementation(mocks.forbidden);
  vi.spyOn(tls, 'connect').mockImplementation(mocks.forbidden);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.client.mockReturnValue({ from: (table: string) => { queryCalls.push(['from', table]); return query(); } });
  mocks.read.mockResolvedValue({ data: [], error: null });
  mocks.translations.mockResolvedValue((key: string) => translate(messages, key));
});

afterEach(() => {
  try {
    expect(mocks.forbidden).not.toHaveBeenCalled();
    for (const action of [mocks.create, mocks.update, mocks.publish, mocks.archive]) expect(action).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe('admin landing-page read errors', () => {
  it.each([{ label: 'no data', data: null }, { label: 'stale rows', data: rows }])('keeps a returned query error out of the view with $label', async ({ data }) => {
    mocks.read.mockResolvedValue({ data, error: { message: privateDetail, code: 'SYNTHETIC_ERROR' } });
    expectReadError(await renderPage());
  });

  it.each([
    ['Error', new Error(privateDetail)], ['string', privateDetail],
    ['coded object', { message: privateDetail, code: 'SYNTHETIC_ERROR', details: privateDetail }],
    ['null', null], ['undefined', undefined],
  ])('renders the existing retry state when the query rejects with %s', async (_kind, cause) => {
    mocks.read.mockRejectedValue(cause);
    expectReadError(await renderPage());
    expect(console.error).toHaveBeenCalledExactlyOnceWith(failureLog);
  });

  it('keeps raw returned error details out of server diagnostics', async () => {
    mocks.read.mockResolvedValue({ data: null, error: { message: privateDetail, details: privateDetail, hint: privateDetail } });
    expectReadError(await renderPage());
    expect(console.error).toHaveBeenCalledExactlyOnceWith(failureLog);
  });

  it.each([{ label: 'empty array', data: [] }, { label: 'null', data: null }])('preserves the empty success view and its create action with $label data', async ({ data }) => {
    mocks.read.mockResolvedValue({ data, error: null });
    const result = await renderPage();
    expect(result.text).toContain(messages['adminMarketingLandingPages.noLandingPagesYet']);
    expect(result.text).toContain(messages['adminMarketingLandingPages.newLandingPage']);
    expect(forms(result.tree).map(form => form.action)).toEqual([mocks.create]);
    expect(result.html).toContain('name="title"');
    expect(result.text).not.toContain(messages['landingPages.couldNotLoadLandingPages']);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('preserves draft and published rows, edit/publish/archive actions, and the create form', async () => {
    mocks.read.mockResolvedValue({ data: rows, error: null });
    const result = await renderPage();
    expect(result.text).toContain('Draft landing page');
    expect(result.text).toContain('Published landing page');
    expect(result.text).toContain('Synthetic headline 0');
    expect(result.html).toContain('href="/lp/synthetic-slug-1"');
    expect(result.html).not.toContain('href="/lp/synthetic-slug-0"');
    expect(result.html).toContain('name="publish" value="1"');
    expect(result.html).toContain('name="publish" value="0"');
    expect(forms(result.tree).map(form => form.action)).toEqual([
      mocks.update, mocks.publish, mocks.archive, mocks.update, mocks.publish, mocks.archive, mocks.create,
    ]);
    expect(result.text).not.toContain(messages['landingPages.couldNotLoadLandingPages']);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('does not catch an earlier translation failure or start a service read', async () => {
    const failure = new Error('Synthetic translation failure');
    mocks.translations.mockRejectedValue(failure);
    const { default: Page } = await import('@/app/(app)/admin/marketing/landing-pages/page');
    await expect(Page()).rejects.toBe(failure);
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('does not disguise synchronous client construction failure as a query result', async () => {
    const failure = new Error('Synthetic client construction failure');
    mocks.client.mockImplementation(() => { throw failure; });
    const { default: Page } = await import('@/app/(app)/admin/marketing/landing-pages/page');
    await expect(Page()).rejects.toBe(failure);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(queryCalls).toHaveLength(0);
    expect(console.error).not.toHaveBeenCalled();
  });
});
