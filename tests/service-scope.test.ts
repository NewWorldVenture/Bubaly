// Scope construction, timezone arithmetic and the idempotency guard — the
// three pieces every domain service leans on. These are pure, so they get real
// unit tests rather than a database fake.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  dayKeyInTz,
  dayKeysBetween,
  hourInTz,
  scopeForSystem,
  scopeFromUserContext,
  scopeNow,
  zonedDayBoundsMs,
  zonedTimeMs,
} from '@/lib/services/scope';
import { makeKey, scopeKey, withIdempotency } from '@/lib/services/idempotency';
import { fail, ok, type ServiceScope } from '@/lib/services/types';
import type { requireUserContext } from '@/lib/supabase/auth';

const DB = {} as SupabaseClient<Database>;

type UserContext = Awaited<ReturnType<typeof requireUserContext>>;

function makeCtx(overrides?: { timezone?: string }): UserContext {
  return {
    user: { id: 'auth-user-1', email: 'parent@example.com' },
    memberships: [],
    active: {
      familyId: 'fam-1',
      family: { id: 'fam-1', name: 'The Hughens', timezone: overrides?.timezone ?? 'America/New_York' } as UserContext['active']['family'],
      role: 'parent',
      member: { id: 'member-1', family_id: 'fam-1', user_id: 'auth-user-1' } as UserContext['active']['member'],
    },
  } as UserContext;
}

describe('scopeFromUserContext', () => {
  it('carries the member id and the auth user id separately', () => {
    const scope = scopeFromUserContext(makeCtx(), DB);
    // The distinction is the whole point: todo_lists.created_by wants the
    // member id, calendar_events.created_by wants the auth user id.
    expect(scope.memberId).toBe('member-1');
    expect(scope.userId).toBe('auth-user-1');
    expect(scope.familyId).toBe('fam-1');
    expect(scope.role).toBe('parent');
    expect(scope.actorKind).toBe('member');
    expect(scope.tz).toBe('America/New_York');
  });

  it('lets a caller override the actor kind and attach run identifiers', () => {
    const scope = scopeFromUserContext(makeCtx(), DB, { actorKind: 'ai', runId: 'run-9', stepId: 'step-2' });
    expect(scope.actorKind).toBe('ai');
    expect(scope.runId).toBe('run-9');
    expect(scope.stepId).toBe('step-2');
    expect(scope.userId).toBe('auth-user-1');
  });
});

describe('scopeForSystem', () => {
  it('has no human actor and falls back to UTC', () => {
    const scope = scopeForSystem(DB, { id: 'fam-2', timezone: null });
    expect(scope.userId).toBeNull();
    expect(scope.memberId).toBeNull();
    expect(scope.role).toBe('system');
    expect(scope.actorKind).toBe('system');
    expect(scope.tz).toBe('UTC');
    expect(scope.familyId).toBe('fam-2');
  });
});

describe('scopeNow', () => {
  it('uses the injected clock when one is given', () => {
    const now = new Date('2026-09-05T12:00:00Z');
    expect(scopeNow({ now }).toISOString()).toBe('2026-09-05T12:00:00.000Z');
    expect(scopeNow({}).getTime()).toBeGreaterThan(0);
  });
});

describe('dayKeyInTz', () => {
  it('resolves the family-local day, not the UTC day', () => {
    // 03:30 UTC on the 6th is still the evening of the 5th in New York. A UTC
    // day key here would file the event on the wrong day of the week.
    const instant = new Date('2026-09-06T03:30:00Z');
    expect(dayKeyInTz(instant, 'America/New_York')).toBe('2026-09-05');
    expect(dayKeyInTz(instant, 'UTC')).toBe('2026-09-06');
    expect(dayKeyInTz(instant, 'Asia/Tokyo')).toBe('2026-09-06');
  });

  it('degrades to the UTC day rather than throwing on a bad zone name', () => {
    expect(dayKeyInTz(new Date('2026-09-06T03:30:00Z'), 'Not/AZone')).toBe('2026-09-06');
  });
});

describe('hourInTz', () => {
  it('reads the local wall-clock hour', () => {
    const instant = new Date('2026-09-06T03:30:00Z');
    expect(hourInTz(instant, 'America/New_York')).toBe(23);
    expect(hourInTz(instant, 'UTC')).toBe(3);
  });

  it('reports midnight as hour 0', () => {
    expect(hourInTz(new Date('2026-09-06T00:15:00Z'), 'UTC')).toBe(0);
  });
});

describe('zonedTimeMs', () => {
  it('resolves a wall-clock time on both sides of a DST change', () => {
    // US DST begins 2026-03-08. 09:00 local is 14:00Z before and 13:00Z after.
    expect(new Date(zonedTimeMs('2026-03-07', 9, 0, 'America/New_York')).toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(new Date(zonedTimeMs('2026-03-09', 9, 0, 'America/New_York')).toISOString()).toBe('2026-03-09T13:00:00.000Z');
  });

  it('matches naive parsing in UTC', () => {
    expect(new Date(zonedTimeMs('2026-09-05', 17, 30, 'UTC')).toISOString()).toBe('2026-09-05T17:30:00.000Z');
  });
});

describe('zonedDayBoundsMs', () => {
  it('spans exactly 23 hours on a spring-forward day', () => {
    const { start, end } = zonedDayBoundsMs('2026-03-08', 'America/New_York');
    expect((end - start) / 3600_000).toBe(23);
  });

  it('spans 24 hours on an ordinary day', () => {
    const { start, end } = zonedDayBoundsMs('2026-09-05', 'America/New_York');
    expect((end - start) / 3600_000).toBe(24);
  });
});

describe('dayKeysBetween', () => {
  it('lists every local day the window touches', () => {
    const from = Date.parse('2026-09-05T22:00:00Z'); // 18:00 on the 5th in NY
    const to = Date.parse('2026-09-08T02:00:00Z');   // 22:00 on the 7th in NY
    expect(dayKeysBetween(from, to, 'America/New_York')).toEqual(['2026-09-05', '2026-09-06', '2026-09-07']);
  });

  it('returns nothing for an inverted window', () => {
    expect(dayKeysBetween(Date.parse('2026-09-08T00:00:00Z'), Date.parse('2026-09-05T00:00:00Z'), 'UTC')).toEqual([]);
  });
});

describe('makeKey', () => {
  it('is stable across calls and sensitive to order', () => {
    expect(makeKey(['fam-1', 'calendar.createEvent', 1])).toBe(makeKey(['fam-1', 'calendar.createEvent', 1]));
    expect(makeKey(['a', 'b'])).not.toBe(makeKey(['b', 'a']));
  });

  it('keeps a null part as a distinct position', () => {
    // Dropping nulls would let two different requests share a key and silently
    // suppress the second write.
    expect(makeKey(['a', null, 'b'])).not.toBe(makeKey(['a', 'b']));
  });

  it('ignores surrounding whitespace on string parts', () => {
    expect(makeKey([' milk '])).toBe(makeKey(['milk']));
  });
});

const BASE_SCOPE: ServiceScope = {
  db: DB,
  familyId: 'fam-1',
  userId: 'auth-user-1',
  memberId: 'member-1',
  role: 'parent',
  actorKind: 'member',
  tz: 'America/New_York',
};

describe('scopeKey', () => {
  it('prefers an explicit idempotency key', () => {
    expect(scopeKey({ ...BASE_SCOPE, idempotencyKey: 'given' }, 'calendar.createEvent', { a: 1 })).toBe('given');
  });

  it('separates two steps of the same run', () => {
    const a = scopeKey({ ...BASE_SCOPE, runId: 'run-1', stepId: 'step-1' }, 'tasks.createTodo', { title: 'x' });
    const b = scopeKey({ ...BASE_SCOPE, runId: 'run-1', stepId: 'step-2' }, 'tasks.createTodo', { title: 'x' });
    expect(a).not.toBe(b);
  });

  it('ignores object key order in the input', () => {
    const a = scopeKey({ ...BASE_SCOPE, runId: 'run-1' }, 'tasks.createTodo', { title: 'x', due: '2026-09-05' });
    const b = scopeKey({ ...BASE_SCOPE, runId: 'run-1' }, 'tasks.createTodo', { due: '2026-09-05', title: 'x' });
    expect(a).toBe(b);
  });
});

describe('withIdempotency', () => {
  it('creates directly when there is nothing to deduplicate against', async () => {
    let probes = 0;
    let created = 0;
    const res = await withIdempotency(
      BASE_SCOPE,
      { operation: 'op', input: {}, find: async () => { probes += 1; return ok(null); } },
      async (key) => { created += 1; expect(key).toBeNull(); return ok({ id: 'new' }); },
    );
    expect(res).toEqual({ ok: true, data: { id: 'new' } });
    expect(probes).toBe(0);
    expect(created).toBe(1);
  });

  it('returns the existing row instead of creating a second one', async () => {
    let created = 0;
    const res = await withIdempotency(
      { ...BASE_SCOPE, idempotencyKey: 'key-1' },
      { operation: 'op', input: {}, find: async (key) => { expect(key).toBe('key-1'); return ok({ id: 'existing' }); } },
      async () => { created += 1; return ok({ id: 'new' }); },
    );
    expect(res).toEqual({ ok: true, data: { id: 'existing' } });
    expect(created).toBe(0);
  });

  it('fails rather than risking a duplicate when the probe cannot answer', async () => {
    let created = 0;
    const res = await withIdempotency(
      { ...BASE_SCOPE, idempotencyKey: 'key-1' },
      { operation: 'op', input: {}, find: async () => fail('probe blew up', { code: 'db' }) },
      async () => { created += 1; return ok({ id: 'new' }); },
    );
    expect(res).toEqual({ ok: false, error: 'probe blew up', code: 'db' });
    expect(created).toBe(0);
  });

  it('creates with the composed key when the probe finds nothing', async () => {
    let seenKey: string | null = 'unset';
    const res = await withIdempotency(
      { ...BASE_SCOPE, runId: 'run-1', stepId: 'step-1' },
      { operation: 'op', input: { a: 1 }, find: async () => ok(null) },
      async (key) => { seenKey = key; return ok({ id: 'new' }); },
    );
    expect(res.ok).toBe(true);
    expect(seenKey).toMatch(/^[0-9a-f]{64}$/);
  });
});
