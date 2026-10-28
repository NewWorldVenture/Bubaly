// UNEXECUTED DRAFT: modeled component callbacks, not DOM, native Auth or RLS.
// Root must admit the complete module closure and install pre-evaluation guards.
import type { ReactElement } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Element = ReactElement<Record<string, unknown>>;
type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const h = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, dirty: false,
  effects: [] as (() => void)[], cleanups: new Map<number, () => void>(),
  requests: [] as { url: string; method: string; body: unknown }[],
  unexpected: [] as string[], pathname: '/blog/family-day', push: vi.fn(),
  replies: [] as (() => Promise<Reply>)[],
  forbiddenImports: [] as string[], defaultFetchCalls: 0,
}));
type SharedGuard = { snapshot: () => { forbiddenImports: string[]; fetchCalls: number }; recordForbiddenFetch: (name: string) => never };
const defaultGuard: SharedGuard = {
  snapshot: () => ({ forbiddenImports: [...h.forbiddenImports], fetchCalls: h.defaultFetchCalls }),
  recordForbiddenFetch: (_name: string): never => { h.defaultFetchCalls++; throw new Error('Forbidden blog heart network'); },
};
// Strict local phases require the actual independently admitted external guard.
// Ordinary hosted CI has no task-specific G:/ setup and uses this inline guard.
const sharedGuard = process.env.BUBALY_ADAPTER_PHASE
  ? (globalThis as unknown as Record<symbol, SharedGuard>)[Symbol.for('bubaly.blog.heart.initial-state.guard.v1')]
  : defaultGuard;
if (!sharedGuard || typeof sharedGuard.snapshot !== 'function' || typeof sharedGuard.recordForbiddenFetch !== 'function') throw new Error('Required blog heart boundary is absent');
const importSnapshot = sharedGuard.snapshot();
function boundary() {
  expect(importSnapshot).toEqual({ forbiddenImports: [], fetchCalls: 0 });
  expect(h.forbiddenImports).toEqual([]); expect(h.defaultFetchCalls).toBe(0);
  expect(sharedGuard.snapshot()).toEqual({ forbiddenImports: [], fetchCalls: 0 });
}
boundary();
vi.stubGlobal('fetch', () => sharedGuard.recordForbiddenFetch('component import fetch'));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const memo = (compute: () => unknown, deps?: readonly unknown[]) => {
    const index = h.cursor++;
    const old = h.slots[index] as { deps?: readonly unknown[]; value: unknown } | undefined;
    if (old && same(old.deps, deps)) return old.value;
    const value = compute(); h.slots[index] = { deps, value }; return value;
  };
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.cursor++;
      if (!(index in h.slots)) h.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [h.slots[index], (value: unknown) => {
        const next = typeof value === 'function' ? (value as (old: unknown) => unknown)(h.slots[index]) : value;
        if (!Object.is(h.slots[index], next)) { h.slots[index] = next; h.dirty = true; }
      }];
    },
    useCallback: (fn: unknown, deps?: readonly unknown[]) => memo(() => fn, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = h.cursor++;
      const old = h.slots[index] as { deps?: readonly unknown[] } | undefined;
      if (old && same(old.deps, deps)) return;
      h.slots[index] = { deps };
      h.effects.push(() => { h.cleanups.get(index)?.(); const cleanup = effect(); if (cleanup) h.cleanups.set(index, cleanup); else h.cleanups.delete(index); });
    },
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }), usePathname: () => h.pathname }));
vi.mock('lucide-react', () => ({ Heart: () => null }));
vi.mock('@/lib/utils/cn', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
vi.mock('@/components/i18n/locale-provider', () => ({ useTranslations: () => (key: string) => key }));
// These factories refuse before any implementation is evaluated, including in
// ordinary hosted CI; attempted forbidden imports remain sticky across cases.
vi.mock('@supabase/supabase-js', () => { h.forbiddenImports.push('SDK'); throw new Error('Forbidden implementation'); });
vi.mock('@supabase/ssr', () => { h.forbiddenImports.push('SSR'); throw new Error('Forbidden implementation'); });
vi.mock('@supabase/auth-js', () => { h.forbiddenImports.push('Auth SDK'); throw new Error('Forbidden implementation'); });
vi.mock('@/lib/supabase/server', () => { h.forbiddenImports.push('server'); throw new Error('Forbidden implementation'); });
vi.mock('@/lib/supabase/client', () => { h.forbiddenImports.push('client'); throw new Error('Forbidden implementation'); });
vi.mock('@/lib/supabase/auth', () => { h.forbiddenImports.push('Auth'); throw new Error('Forbidden implementation'); });
vi.mock('@/shared/auth/refresh-fetch', () => { h.forbiddenImports.push('refresh-fetch'); throw new Error('Forbidden implementation'); });
vi.mock('@/lib/auth/cache-session', () => { h.forbiddenImports.push('cache-session'); throw new Error('Forbidden implementation'); });
vi.mock('@/lib/auth/browser-session-storage', () => { h.forbiddenImports.push('session-storage'); throw new Error('Forbidden implementation'); });
vi.mock('@/lib/ai/provider', () => { h.forbiddenImports.push('provider'); throw new Error('Forbidden implementation'); });
vi.mock('@/lib/ai/provider-stub', () => { h.forbiddenImports.push('provider-stub'); throw new Error('Forbidden implementation'); });
vi.mock('next/server', () => { h.forbiddenImports.push('next/server'); throw new Error('Forbidden implementation'); });
vi.mock('next/cache', () => { h.forbiddenImports.push('next/cache'); throw new Error('Forbidden implementation'); });
const { HeartButton } = await import('@/components/blog/heart-button');
boundary();

const reply = (body: unknown, status = 200): Reply => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const healthy = (saved = true, count = 7, authenticated = true) => reply({ saved, count, authenticated });
const pendingReplies: { finish: () => void; promise: Promise<unknown> }[] = [];
const activeActions: Promise<unknown>[] = [];
function deferredReply() {
  let resolve!: (value: Reply) => void;
  const promise = new Promise<Reply>((yes) => { resolve = yes; });
  pendingReplies.push({ finish: () => resolve(reply({}, 503)), promise });
  return { promise, resolve };
}
function queue(value: Reply) { h.replies.push(async () => value); }
let tree: Element;
let slug = 'family-day';
function screen() {
  for (let turn = 0; turn < 20; turn++) {
    h.dirty = false; h.cursor = 0; tree = HeartButton({ slug }) as Element;
    const pending = h.effects.splice(0); for (const effect of pending) effect();
    if (!h.dirty) return tree;
  }
  throw new Error('Synthetic render did not settle');
}
async function settle() { for (let turn = 0; turn < 20; turn++) { await Promise.resolve(); if (h.dirty || h.effects.length) screen(); } return tree; }
const props = () => screen().props;
const postRequests = () => h.requests.filter(x => x.method === 'POST');
// Simulate actual browser disabled-button behavior; direct callback controls
// below also prove that the handler itself refuses an unknown state.
async function click() { const p = props(); if (!p.disabled) await (p.onClick as () => unknown)(); await settle(); }
function startClick() { const action = click(); activeActions.push(action); return action; }
async function callback() { await (props().onClick as () => unknown)(); await settle(); }
function text(value: unknown): string {
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).join('');
  return text((value as Element).props?.children);
}
beforeEach(() => {
  boundary();
  h.slots = []; h.cursor = 0; h.dirty = false; h.effects = []; h.cleanups.clear();
  h.requests = []; h.unexpected = []; h.replies = []; h.pathname = '/blog/family-day'; h.push.mockReset(); slug = 'family-day';
  pendingReplies.length = 0; activeActions.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal('fetch', async (input: unknown, options?: { method?: string; body?: unknown }) => {
    const url = String(input), method = options?.method ?? 'GET';
    if (!((method === 'GET' && url === `/api/blog/save?slug=${encodeURIComponent(slug)}`) || (method === 'POST' && url === '/api/blog/save'))) {
      h.unexpected.push(`${method} ${url}`); return sharedGuard.recordForbiddenFetch(`${method} ${url}`);
    }
    h.requests.push({ url, method, body: options?.body });
    // Extra calls to the allowed local route still receive a literal503 so
    // unchanged-code baseline failures identify the write oracle, not a mock
    // setup exception. They remain visible in h.requests and cannot go native.
    const response = h.replies.shift(); return response ? response() : reply({}, 503);
  });
});
afterEach(async () => {
  // Durable attempted-request assertion is outside component catch paths.
  // First deactivate effects, then settle every literal pending reply/action,
  // including deferred operations skipped by an earlier baseline assertion.
  for (const cleanup of h.cleanups.values()) cleanup(); h.cleanups.clear();
  for (const pending of pendingReplies) pending.finish();
  await Promise.all(pendingReplies.map(x => x.promise));
  await Promise.all(activeActions);
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  try {
    expect(h.unexpected).toEqual([]);
    boundary();
  }
  finally { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});
afterAll(() => boundary());

describe('the blog heart waits for its saved state', () => {
  it('renders a pending read without claiming the article is unsaved', async () => {
    const pending = deferredReply(); h.replies.push(() => pending.promise); screen();
    expect(props()['aria-pressed']).toBeUndefined(); expect(props().disabled).toBe(true);
    expect(props()['aria-busy']).toBe(true); expect(text(tree)).not.toContain('saves');
    pending.resolve(healthy()); await settle(); expect(props()['aria-pressed']).toBe(true);
  });
  it('does not toggle before a delayed initial read completes, even if its handler is invoked', async () => {
    const pending = deferredReply(); h.replies.push(() => pending.promise); screen(); await callback();
    expect(postRequests()).toEqual([]); expect(h.push).not.toHaveBeenCalled();
    pending.resolve(healthy()); await settle(); expect(props()['aria-pressed']).toBe(true);
  });
  it('keeps a returned 503 unknown and offers a read retry rather than save or sign-in', async () => {
    queue(reply({ error: 'synthetic-unavailable' }, 503)); screen(); await settle();
    expect(props()['aria-pressed']).toBeUndefined(); expect(props()['aria-label']).toBe('blogHeartButton.retrySavedState');
    expect(text(tree)).toContain('blogHeartButton.retrySavedState'); expect(postRequests()).toEqual([]); expect(h.push).not.toHaveBeenCalled();
  });
  it('keeps a rejected initial read unknown and offers retry', async () => {
    h.replies.push(async () => { throw new Error('Synthetic read rejection'); }); screen(); await settle();
    expect(props()['aria-pressed']).toBeUndefined(); expect(props()['aria-label']).toBe('blogHeartButton.retrySavedState'); expect(postRequests()).toEqual([]);
  });
  it('retries GET after 503 and learns a saved article without mutating it', async () => {
    queue(reply({}, 503)); screen(); await settle(); queue(healthy(true)); await click();
    expect(h.requests.map(x => x.method)).toEqual(['GET', 'GET']); expect(postRequests()).toEqual([]);
    expect(props()['aria-pressed']).toBe(true); expect(props()['aria-label']).toBe('blogHeartButton.removeFromSaved');
  });
  it('does not issue a write while the retry read is delayed', async () => {
    queue(reply({}, 503)); screen(); await settle(); const pending = deferredReply(); h.replies.push(() => pending.promise); const retry = startClick(); await settle();
    const direct = callback(); activeActions.push(direct); await settle();
    expect(h.requests.map(x => x.method)).toEqual(['GET', 'GET']); expect(props().disabled).toBe(true);
    pending.resolve(healthy(false)); await Promise.all([retry, direct]); await settle(); expect(props()['aria-pressed']).toBe(false);
  });
  it('renders a healthy saved article and its count', async () => {
    queue(healthy(true, 7)); screen(); await settle(); expect(props()['aria-pressed']).toBe(true);
    expect(props()['aria-label']).toBe('blogHeartButton.removeFromSaved'); expect(text(tree)).toContain('7'); expect(postRequests()).toEqual([]);
  });
  it('renders a healthy unsaved article without an automatic write', async () => {
    queue(healthy(false, 0)); screen(); await settle(); expect(props()['aria-pressed']).toBe(false);
    expect(props()['aria-label']).toBe('blogHeartButton.saveThisArticle'); expect(text(tree)).toContain('0'); expect(postRequests()).toEqual([]);
  });
  it('saves after an authoritative unsaved read and reconciles the returned count', async () => {
    queue(healthy(false, 7)); screen(); await settle(); queue(healthy(true, 8)); await click();
    expect(postRequests()).toEqual([{ url: '/api/blog/save', method: 'POST', body: JSON.stringify({ slug }) }]);
    expect(props()['aria-pressed']).toBe(true); expect(text(tree)).toContain('8');
  });
  it('unsaves after an authoritative saved read', async () => {
    queue(healthy(true, 7)); screen(); await settle(); queue(healthy(false, 6)); await click();
    expect(postRequests()).toHaveLength(1); expect(props()['aria-pressed']).toBe(false); expect(text(tree)).toContain('6');
  });
  it('routes confirmed signed-out readers to login without issuing a write', async () => {
    queue(healthy(false, 7, false)); screen(); await settle(); await click();
    expect(h.push).toHaveBeenCalledWith('/login?redirect=%2Fblog%2Ffamily-day'); expect(postRequests()).toEqual([]);
  });
  it('routes a confirmed POST401 to login after restoring the old state', async () => {
    queue(healthy(false, 7)); screen(); await settle(); queue(reply({}, 401)); await click();
    expect(props()['aria-pressed']).toBe(false); expect(text(tree)).toContain('7'); expect(h.push).toHaveBeenCalledWith('/login?redirect=%2Fblog%2Ffamily-day');
  });
  it('retains its last confirmed saved state when POST503 refuses the toggle', async () => {
    queue(healthy(true, 7)); screen(); await settle(); queue(reply({}, 503)); await click();
    expect(props()['aria-pressed']).toBe(true); expect(text(tree)).toContain('7'); expect(h.push).not.toHaveBeenCalled();
  });
  it('keeps the healthy toggle busy until its delayed success arrives', async () => {
    queue(healthy(false, 7)); screen(); await settle(); const pending = deferredReply(); h.replies.push(() => pending.promise);
    const first = callback(); activeActions.push(first); await settle(); expect(props().disabled).toBe(true); await click(); expect(postRequests()).toHaveLength(1);
    pending.resolve(healthy(true, 8)); await first; expect(props()['aria-pressed']).toBe(true); expect(props().disabled).toBe(false);
  });
  it('does not accept malformed successful initial state as a confirmed unsaved article', async () => {
    queue(reply({ count: 7 })); screen(); await settle(); expect(props()['aria-pressed']).toBeUndefined();
    expect(props()['aria-label']).toBe('blogHeartButton.retrySavedState'); expect(postRequests()).toEqual([]);
  });
  it('ignores an initial response after effect cleanup rather than changing an unmounted control', async () => {
    const pending = deferredReply(); h.replies.push(() => pending.promise); screen();
    for (const cleanup of h.cleanups.values()) cleanup(); h.cleanups.clear(); const before = [...h.slots];
    pending.resolve(healthy(true)); for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(h.slots).toEqual(before); expect(postRequests()).toEqual([]); expect(h.push).not.toHaveBeenCalled();
  });
});
