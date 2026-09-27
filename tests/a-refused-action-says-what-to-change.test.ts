import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  REFUSALS, REFUSAL_DIGEST_PREFIX, refusalError, refusalForError, refusalFromDigest, refuseInput,
} from '@/lib/actions/refusal';
import { SectionError } from '@/components/app/section-error';
import { renderTranslated } from './helpers/render-translated';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/auth', () => ({ getUser: vi.fn(), isSuperAdmin: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }));

// Page audit P-18 (batch B6b). The admin marketing console's actions throw on
// an ordinary refusal — a slug already taken, a date before its start — and a
// plain <form action> turns that into the section's error page. Production
// omits the thrown message there, so the admin read "This page hit a snag"
// and a reference number and was never told what to change. Next keeps an
// error's own digest, so a refusal carries a code in it and the boundary
// says the reason in the reader's language.
describe('a refused action says what to change', () => {
  it('reads a write failure as the refusal it is', () => {
    expect(refusalForError({ code: '23505', message: 'duplicate key' })).toBe('duplicate');
    expect(refusalForError({ code: '23503' })).toBe('inUse');
    expect(refusalForError({ code: '42501' })).toBe('notAllowed');
    expect(refusalForError({ code: '23514' })).toBe('invalid');
    expect(refusalForError({ code: 'PGRST116' })).toBe('notSaved');
    expect(refusalForError(new Error('The SEO intent is invalid.'))).toBe('invalid');
    expect(refusalForError(new Error('No ad campaign was created'))).toBe('notSaved');
    expect(refusalForError(new Error('Automation workflow not found'))).toBe('notSaved');
  });

  it('carries only a known code in the digest, never free text', () => {
    for (const r of REFUSALS) {
      const e = refusalError('Some message', r) as Error & { digest?: string };
      expect(e.digest).toBe(`${REFUSAL_DIGEST_PREFIX}${r}`);
      expect(refusalFromDigest(e.digest)).toBe(r);
    }
    expect(refusalFromDigest(`${REFUSAL_DIGEST_PREFIX}<b>anything</b>`)).toBeNull();
    expect(refusalFromDigest('2731699661')).toBeNull();
    expect(() => refuseInput('End date must be on or after the start date.')).toThrow(
      expect.objectContaining({ digest: `${REFUSAL_DIGEST_PREFIX}invalid` }),
    );
  });

  it('marketingActionFailure tags what it throws', async () => {
    const { marketingActionFailure } = await import('@/lib/marketing/admin');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => marketingActionFailure('create the landing page', { code: '23505', message: 'duplicate key value' }))
      .toThrow(expect.objectContaining({ digest: `${REFUSAL_DIGEST_PREFIX}duplicate` }));
  });

  it('leaves no untagged input refusal in the marketing actions', () => {
    // The push sender's three are the sender failing, not the input; the
    // asset id is a missing hidden field, not something the admin typed.
    const allowed = [
      'push/actions.ts:The campaign dispatch claim could not be saved.',
      'push/actions.ts:The push sender could not confirm complete outcome counts.',
      'push/actions.ts:Push campaign results could not be saved.',
      'assets/actions.ts:Marketing asset id is required.',
    ];
    const dir = 'app/(app)/admin/marketing';
    const files = ['actions.ts', ...readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => join(d.name, 'actions.ts'))];
    const found: string[] = [];
    for (const f of files) {
      let src: string;
      try { src = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
      for (const m of src.matchAll(/throw new Error\(\s*['`]([^'`]+)['`]/g)) found.push(`${f}:${m[1]}`);
    }
    expect(found.sort()).toEqual(allowed.sort());
  });

  it('the section error page says the reason, in the reader’s language', () => {
    const error = refusalError('That already exists.', 'duplicate');
    const en = renderTranslated(createElement(SectionError, { error, reset: () => {} }));
    expect(en).toContain('That wasn’t saved');
    expect(en).toContain('Something with that name or address already exists.');
    expect(en).toContain('Back to the form');
    expect(en).not.toContain('Reference:');
    const de = renderTranslated(createElement(SectionError, { error, reset: () => {} }), 'de-DE');
    expect(de).toContain('Das wurde nicht gespeichert');
  });

  it('keeps the ordinary error page for an error that is not a refusal', () => {
    const error = Object.assign(new Error('boom'), { digest: '2731699661' });
    const html = renderTranslated(createElement(SectionError, { error, reset: () => {} }));
    expect(html).toContain('Reference: 2731699661');
    expect(html).not.toContain('That wasn’t saved');
  });
});
