import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

// Two pages joined the default sidebar before the migrations behind them were
// applied to production, and migrations here are applied by a person, not by
// the deploy. So there is a window — however long an administrator takes — in
// which every member can see "Library" and "Assistants" in their sidebar and
// nothing is behind either one.
//
// What the pages said in that window was "Refresh and try again." That advice
// cannot work: no number of refreshes creates a table. It reads as a transient
// glitch, which is the one thing it certainly is not, and it sends the person
// round a loop with no exit while hiding the single fact that would explain it.
//
// Both pages now separate the two causes, and this renders them to prove it —
// a grep for `isMissingRelationError` would pass whether or not React survives
// the render, and whether or not the branch is reachable.

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  failure: null as { code?: string; message: string } | null,
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));

/** A thenable that chains like a PostgREST builder and settles like one. */
function builder(): Record<string, unknown> {
  const settle = () => Promise.resolve(
    mocks.failure ? { data: null, error: mocks.failure } : { data: [], error: null },
  );
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) => settle().then(resolve, reject),
  };
  for (const method of ['select', 'eq', 'order', 'limit', 'is', 'in', 'not']) {
    chain[method] = () => chain;
  }
  return chain;
}

beforeEach(() => {
  vi.resetModules();
  mocks.failure = null;
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: { familyId: 'family-1', role: 'parent' },
  });
  mocks.createServer.mockResolvedValue({ from: () => builder() });
});

// The success path renders client children (the "new key" form, the player
// controls) that call useToast, so the tree needs the provider the real layout
// gives them. The error paths return before reaching any of it, but wrapping
// unconditionally keeps the three cases comparable.
// ToastProvider is imported HERE, not at the top of the file: `vi.resetModules()`
// runs before each test, so a top-level import would be a different instance of
// the module than the one the page's children resolve — two React contexts that
// look identical and share nothing, so `useContext` hands back undefined and the
// provider appears not to work at all.
const render = async (specifier: string) => {
  const { ToastProvider } = await import('@/components/ui/toast');
  const { default: Page } = await import(specifier);
  return renderToStaticMarkup(createElement(ToastProvider, null, await Page()));
};
const renderLibrary = () => render('@/app/(app)/dashboard/library/page');
const renderAssistants = () => render('@/app/(app)/dashboard/assistants/page');

// PostgREST's answer for a table that is not in the schema cache — which is
// exactly what production returns today for both of these, since the ledger
// there records only 0001-0003.
const MISSING_TABLE = { code: 'PGRST205', message: "Could not find the table 'public.library_items' in the schema cache" };
// A real read failure: the table is there, the database is not answering.
const READ_FAILURE = { code: '57014', message: 'canceling statement due to statement timeout' };

describe('the library page before 0284 is applied', () => {
  it('names the migration instead of telling someone to refresh', async () => {
    mocks.failure = MISSING_TABLE;
    const html = await renderLibrary();
    expect(html).toContain('0284_library_books_podcasts.sql');
    expect(html).toContain("isn&#x27;t switched on yet");
    expect(html).not.toContain('Refresh and try again');
  });

  it('still says "refresh" for a failure that refreshing might actually fix', async () => {
    mocks.failure = READ_FAILURE;
    const html = await renderLibrary();
    expect(html).toContain('Refresh and try again');
    expect(html).not.toContain('0284_library_books_podcasts.sql');
  });

  it('renders the library itself when the tables are there', async () => {
    const html = await renderLibrary();
    expect(html).not.toContain('Refresh and try again');
    expect(html).not.toContain('0284_library_books_podcasts.sql');
  });
});

describe('the assistants page before 0283 is applied', () => {
  it('names the migration instead of telling someone to refresh', async () => {
    mocks.failure = { ...MISSING_TABLE, message: "Could not find the table 'public.assistant_links' in the schema cache" };
    const html = await renderAssistants();
    expect(html).toContain('0283_assistant_links.sql');
    expect(html).toContain("aren&#x27;t switched on yet");
    expect(html).not.toContain('Refresh and try again');
  });

  it('still says "refresh" for a failure that refreshing might actually fix', async () => {
    mocks.failure = READ_FAILURE;
    const html = await renderAssistants();
    expect(html).toContain('Refresh and try again');
    expect(html).not.toContain('0283_assistant_links.sql');
  });

  it('renders the key list when the tables are there', async () => {
    const html = await renderAssistants();
    expect(html).not.toContain('Refresh and try again');
    expect(html).not.toContain('0283_assistant_links.sql');
  });
});
