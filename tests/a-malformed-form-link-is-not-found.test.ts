import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { at } from './helpers/source-order';
import { isUuid } from '@/lib/utils/validation';

// Page audit B12, production re-crawl: /f/no-such-page answered HTTP 500.
// A form id is a uuid; any other string made Postgres refuse the query
// (22P02), and the page rethrows a read error on purpose — a transient failure
// must not 404 a live form — so a mistyped link crashed rather than saying the
// form does not exist. A malformed id is now not found before any read, and a
// real read failure still throws.

const db = vi.hoisted(() => ({ calls: 0, error: null as null | { message: string }, row: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      from: () => chain, select: () => chain, eq: () => chain, is: () => chain,
      maybeSingle: async () => { db.calls += 1; return { data: db.error ? null : db.row, error: db.error }; },
    });
    return chain;
  },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
vi.mock('@/components/marketing/sections', () => ({ Section: () => null, SectionHeading: () => null }));
vi.mock('@/components/marketing/marketing-aeo-section', () => ({ MarketingAeoSection: () => null }));
vi.mock('@/app/(marketing)/f/[id]/form-renderer', () => ({ PublicForm: () => null }));

import PublicFormPage, { generateMetadata } from '@/app/(marketing)/f/[id]/page';

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => { db.calls = 0; db.error = null; db.row = null; });

describe('a malformed form link is not found, not a crash', () => {
  it('answers not-found for an id that is not a uuid, without querying', async () => {
    await expect(PublicFormPage(params('no-such-page'))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(await generateMetadata(params('no-such-page'))).toMatchObject({ title: 'f.notFound' });
    expect(db.calls).toBe(0);
  });

  it('still answers not-found for a well-formed id that names no form', async () => {
    await expect(PublicFormPage(params('00000000-0000-4000-8000-000000000000'))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(db.calls).toBe(1);
  });

  it('still throws on a real read failure, so a live form is never 404ed', async () => {
    db.error = { message: 'statement timeout' };
    await expect(PublicFormPage(params('00000000-0000-4000-8000-000000000000'))).rejects.toThrow('statement timeout');
  });
});

// The same crash, found by probing every signed-in [id] route with a malformed
// id: three pages rethrow a read error (so a transient failure is retryable,
// not a false "gone"), and a non-uuid id is exactly such an error. Each now
// answers not-found before its first read.

describe('signed-in id routes answer a malformed id with not-found', () => {
  it.each([
    ['app/(app)/dashboard/social/posts/[id]/page.tsx', 'if (!isUuid(id))', 'await getPost('],
    ['app/(app)/kids/submit/[assignmentId]/page.tsx', 'if (!isUuid(assignmentId))', ".from('chore_assignments')"],
    ['app/(app)/marketplace/creators/[id]/page.tsx', 'if (!isUuid(id))', ".from('marketplace_stores')"],
  ])('%s checks the id before it reads', (file, guard, firstRead) => {
    const src = readFileSync(file, 'utf8');
    expect(at(src, guard)).toBeLessThan(at(src, firstRead));
    expect(src).toContain(`${guard} return <AppNotFound`);
  });

  it('knows a row id from anything else', () => {
    expect(isUuid('00000000-0000-4000-8000-000000000000')).toBe(true);
    expect(isUuid('A0000000-0000-4000-8000-00000000000C')).toBe(true);
    expect(isUuid('no-such-page')).toBe(false);
    expect(isUuid('00000000-0000-4000-8000-00000000000')).toBe(false);
    expect(isUuid("00000000-0000-4000-8000-000000000000' or 1=1")).toBe(false);
  });
});
