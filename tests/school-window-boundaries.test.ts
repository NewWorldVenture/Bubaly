import { describe, expect, it } from 'vitest';
import { listPracticesBetween } from '@/lib/services/sports';
import type { ServiceScope } from '@/lib/services/types';
import { listEventsBetween, listHomeworkDue, resolveWindow } from '@/lib/services/school';

const scope = { now: new Date('2026-10-08T12:00:00Z'), tz: 'UTC' } as ServiceScope;
const lastInstant = '+275760-09-13T00:00:00.000Z';

describe('school window range boundaries return service errors', () => {
  it('refuses a default week that exceeds the Date range without throwing', () => {
    expect(resolveWindow(scope, { from: lastInstant })).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('reports an invalid explicit end before calculating a fallback week', () => {
    expect(resolveWindow(scope, { from: lastInstant, to: 'not-a-date' })).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('does not query when the requested implicit window cannot be represented', async () => {
    const guarded = { ...scope, db: { from: () => { throw new Error('Unexpected database query'); } } } as unknown as ServiceScope;
    await expect(listEventsBetween(guarded, { from: lastInstant })).resolves.toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it.each(['2026-02-30T12:00:00Z', '2026-04-31T23:30:00-07:00', '2025-02-29'])('refuses an impossible ISO calendar date %s', from => {
    expect(resolveWindow(scope, { from })).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('refuses an impossible explicit end instead of normalizing it into March', () => {
    expect(resolveWindow(scope, { from: '2026-02-01T00:00:00Z', to: '2026-02-30T12:00:00Z' })).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('retains a valid leap day and an offset crossing the UTC date', () => {
    expect(resolveWindow(scope, { from: '2024-02-29T23:30:00-07:00' })).toMatchObject({ ok: true, data: { from: '2024-03-01T06:30:00.000Z' } });
  });

  it('preserves an explicit representable end at the boundary', () => {
    expect(resolveWindow(scope, { from: lastInstant, to: lastInstant })).toEqual({ ok: true, data: { from: lastInstant, to: lastInstant } });
  });

  it('normalizes explicit offsets and preserves ordinary one-week defaults', () => {
    expect(resolveWindow(scope, { from: '2026-10-08T08:00:00-04:00' })).toEqual({ ok: true, data: { from: '2026-10-08T12:00:00.000Z', to: '2026-10-15T12:00:00.000Z' } });
  });
});


describe('school window grammar does not bypass calendar validation', () => {
  const refused = ['2026-02-30Z', '2026-02-30\t12:00:00Z', ' 2026-02-30', '2026-02-28Z', '2026-02-28\t12:00:00Z'];
  it.each(refused)('refuses unsupported explicit start %j', from => {
    expect(resolveWindow(scope, { from })).toMatchObject({ ok: false, code: 'invalid_input' });
  });
  it.each(refused)('refuses unsupported explicit end %j', to => {
    expect(resolveWindow(scope, { from: '2026-02-01T00:00:00Z', to })).toMatchObject({ ok: false, code: 'invalid_input' });
  });
  for (const read of [listEventsBetween, listHomeworkDue, listPracticesBetween]) {
    it.each(refused.slice(0, 3))(`${read.name} refuses %j before any database access`, async from => {
      let requests = 0;
      const guarded = { ...scope, db: { from: () => { requests++; throw new Error('Unexpected database query'); } } } as unknown as ServiceScope;
      await expect(read(guarded, { from })).resolves.toMatchObject({ ok: false, code: 'invalid_input' });
      expect(requests).toBe(0);
    });
  }
  it.each(['2024-02-29', '2024-02-29t12:00:00z', '2024-02-29 12:00:00Z', '2024-02-29T12:00:00+00:00'])('retains recognized valid representation %s', from => {
    expect(resolveWindow(scope, { from }).ok).toBe(true);
  });
});
