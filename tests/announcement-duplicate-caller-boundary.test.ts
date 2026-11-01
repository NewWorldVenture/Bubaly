import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tables } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';

const effects = vi.hoisted(() => ({ activity: 0, family: 0 }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: async () => { effects.activity++; } }));
vi.mock('@/lib/services/family', () => ({ getMember: () => { effects.family++; throw new Error('Family implementation is outside this fixture.'); } }));

import { createAnnouncement } from '@/lib/services/messages';

const FAMILY = '10000000-0000-4000-8000-000000000001';
const USER = '20000000-0000-4000-8000-00000000000a';
const MEMBER = '30000000-0000-4000-8000-00000000000a';
const OTHER_USER = '20000000-0000-4000-8000-00000000000b';
const OTHER_MEMBER = '30000000-0000-4000-8000-00000000000b';
const NOW = new Date('2026-10-28T12:00:00.000Z');
const PRIVATE_BODY = 'SIBLING_PRIVATE_BODY_SENTINEL';
const title = 'Synthetic family notice';
const row = (patch: Partial<Tables<'family_announcements'>> = {}): Tables<'family_announcements'> => ({
  id: '40000000-0000-4000-8000-000000000001', family_id: FAMILY,
  author_id: USER, author_member_id: MEMBER, title, body: PRIVATE_BODY,
  is_pinned: false, created_at: NOW.toISOString(), updated_at: NOW.toISOString(), ...patch,
});

type Call = { table: string; kind: 'read' | 'insert'; filters: [string, unknown][]; payload?: unknown };
type Options = {
  probes?: (Tables<'family_announcements'> | null)[];
  probeError?: boolean;
  createError?: boolean;
  member?: Record<string, unknown> | null;
  scope?: Partial<ServiceScope>;
};
function fixture(options: Options = {}) {
  const calls: Call[] = [];
  let probe = 0;
  const actor = options.member === undefined ? { id: MEMBER, family_id: FAMILY, user_id: USER, is_active: true, role: 'parent' } : options.member;
  const db = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      let payload: unknown;
      const result = () => {
        calls.push({ table, kind: payload === undefined ? 'read' : 'insert', filters: [...filters], ...(payload === undefined ? {} : { payload }) });
        if (table === 'family_members') {
          return { data: actor && filters.every(([key, value]) => actor[key] === value) ? actor : null, error: null };
        }
        if (table !== 'family_announcements') throw new Error('Unexpected table in synthetic fixture.');
        if (payload !== undefined) return options.createError
          ? { data: null, error: { code: '23505', message: 'Synthetic insert refused' } }
          : { data: row(payload as Partial<Tables<'family_announcements'>>), error: null };
        const found = options.probes?.[probe++] ?? null;
        const matches = found && filters.every(([key, value]) => key === 'created_at'
          ? Date.parse(found.created_at) >= Date.parse(String(value))
          : found[key as keyof typeof found] === value);
        return { data: matches ? found : null, error: options.probeError ? { code: '42501', message: 'Synthetic read refused' } : null };
      };
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        gte: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        limit: () => query,
        insert: (value: unknown) => { payload = value; return query; },
        maybeSingle: async () => result(),
        single: async () => result(),
      };
      return query;
    },
  };
  const scope: ServiceScope = {
    db: db as unknown as ServiceScope['db'], familyId: FAMILY, userId: USER, memberId: MEMBER,
    role: 'parent', actorKind: 'ai', tz: 'UTC', now: NOW, requestId: 'synthetic-request', ...options.scope,
  };
  return { scope, calls };
}
const inserts = (calls: Call[]) => calls.filter(call => call.kind === 'insert');
beforeEach(() => { effects.activity = 0; });
afterEach(() => { expect(effects.family).toBe(0); });
afterAll(() => { expect(effects.family).toBe(0); });

describe('announcement duplicate history belongs to the current actor', () => {
  for (const stage of ['initial', 'reprobe'] as const) {
    for (const identity of ['user', 'member', 'both'] as const) {
      it(`${stage} refuses a duplicate with a different ${identity} author identity`, async () => {
        const stored = row({ ...(identity !== 'member' ? { author_id: OTHER_USER } : {}), ...(identity !== 'user' ? { author_member_id: OTHER_MEMBER } : {}) });
        const { scope, calls } = fixture({ probes: stage === 'initial' ? [stored] : [null, stored], createError: stage === 'reprobe' });
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          const result = await createAnnouncement(scope, { title });
          expect(result).toMatchObject({ ok: false, code: 'already_saved' });
          expect(result).not.toHaveProperty('data');
          expect(JSON.stringify(result)).not.toContain(PRIVATE_BODY);
          expect(JSON.stringify([warning.mock.calls, error.mock.calls])).not.toContain(PRIVATE_BODY);
          expect(inserts(calls)).toHaveLength(stage === 'initial' ? 0 : 1);
          expect(effects.activity).toBe(0);
        } finally { warning.mockRestore(); error.mockRestore(); }
      });
    }
    it(`${stage} retains an identical actor's title history`, async () => {
      const stored = row();
      const { scope, calls } = fixture({ probes: stage === 'initial' ? [stored] : [null, stored], createError: stage === 'reprobe' });
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await createAnnouncement(scope, { title })).toEqual({ ok: true, data: stored });
        expect(inserts(calls)).toHaveLength(stage === 'initial' ? 0 : 1);
        expect(effects.activity).toBe(0);
      } finally { log.mockRestore(); }
    });
  }

  it.each([
    ['body', { body: 'Different requested details' }],
    ['pin', { pinned: true }],
  ] as const)('preserves same-author title history when the requested %s differs', async (_label, input) => {
    const stored = row();
    const { scope, calls } = fixture({ probes: [stored] });
    expect(await createAnnouncement(scope, { title, ...input })).toEqual({ ok: true, data: stored });
    expect(inserts(calls)).toHaveLength(0);
  });

  it('accepts an ownerless system retry with both stored authors null', async () => {
    const stored = row({ author_id: null, author_member_id: null });
    const { scope, calls } = fixture({ probes: [stored], scope: { userId: null, memberId: null, role: 'system', actorKind: 'system' } });
    expect(await createAnnouncement(scope, { title })).toEqual({ ok: true, data: stored });
    expect(calls.map(call => call.table)).toEqual(['family_announcements']);
    expect(effects.activity).toBe(0);
  });

  for (const actor of ['human', 'system'] as const) {
    it(`refuses ${actor} adoption of the other actor kind's announcement`, async () => {
      const stored = actor === 'human' ? row({ author_id: null, author_member_id: null }) : row();
      const { scope, calls } = fixture({ probes: [stored], ...(actor === 'system' ? { scope: { userId: null, memberId: null, role: 'system' as const, actorKind: 'system' as const } } : {}) });
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await createAnnouncement(scope, { title });
        expect(result).toMatchObject({ ok: false, code: 'already_saved' });
        expect(JSON.stringify(result)).not.toContain(PRIVATE_BODY);
        expect(inserts(calls)).toHaveLength(0);
        expect(effects.activity).toBe(0);
      } finally { warning.mockRestore(); }
    });
  }

  it.each(['author_id', 'author_member_id'] as const)('refuses a partially null stored %s', async field => {
    const { scope, calls } = fixture({ probes: [row({ [field]: null })] });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await createAnnouncement(scope, { title })).toMatchObject({ ok: false, code: 'already_saved' });
      expect(inserts(calls)).toHaveLength(0);
      expect(effects.activity).toBe(0);
    } finally { warning.mockRestore(); }
  });

  it('compares equivalent UUID author spellings case-insensitively', async () => {
    const stored = row({ author_id: USER.toUpperCase(), author_member_id: MEMBER.toUpperCase() });
    const { scope } = fixture({ probes: [stored] });
    expect(await createAnnouncement(scope, { title })).toEqual({ ok: true, data: stored });
  });

  it('retains the exact family/title/time duplicate query', async () => {
    const { scope, calls } = fixture({ probes: [row()] });
    await createAnnouncement(scope, { title });
    expect(calls.find(call => call.table === 'family_announcements')?.filters).toEqual([
      ['family_id', FAMILY], ['title', title], ['created_at', '2026-10-27T12:00:00.000Z'],
    ]);
  });

  it('creates healthy missing history with this caller and one activity', async () => {
    const { scope, calls } = fixture();
    const result = await createAnnouncement(scope, { title, body: 'Requested details', pinned: true });
    expect(result).toMatchObject({ ok: true, data: { author_id: USER, author_member_id: MEMBER, body: 'Requested details', is_pinned: true } });
    expect(inserts(calls)).toHaveLength(1);
    expect(effects.activity).toBe(1);
  });

  it.each([
    ['inactive', { is_active: false }], ['identity', { user_id: OTHER_USER }], ['role', { role: 'adult' }],
  ] as const)('refuses %s actor admission before reading history', async (_label, patch) => {
    const { scope, calls } = fixture({ member: { id: MEMBER, family_id: FAMILY, user_id: USER, is_active: true, role: 'parent', ...patch } });
    expect(await createAnnouncement(scope, { title })).toMatchObject({ ok: false, code: 'denied' });
    expect(calls.map(call => call.table)).toEqual(['family_members']);
    expect(effects.activity).toBe(0);
  });

  it('refuses a returned duplicate read error without inserting', async () => {
    const { scope, calls } = fixture({ probeError: true });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await createAnnouncement(scope, { title })).toMatchObject({ ok: false, code: 'db' });
      expect(inserts(calls)).toHaveLength(0);
      expect(effects.activity).toBe(0);
    } finally { log.mockRestore(); }
  });

  it('preserves a refused insert when the reprobe still finds no history', async () => {
    const { scope, calls } = fixture({ probes: [null, null], createError: true });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await createAnnouncement(scope, { title })).toMatchObject({ ok: false, code: 'db' });
      expect(inserts(calls)).toHaveLength(1);
      expect(effects.activity).toBe(0);
    } finally { log.mockRestore(); }
  });

  it('retains unkeyed direct creation rather than probing unrelated history', async () => {
    const { scope, calls } = fixture({ scope: { requestId: null } });
    expect(await createAnnouncement(scope, { title })).toMatchObject({ ok: true });
    expect(calls.map(call => [call.table, call.kind])).toEqual([['family_members', 'read'], ['family_announcements', 'insert']]);
  });

  it('refuses an empty title before any query', async () => {
    const { scope, calls } = fixture();
    expect(await createAnnouncement(scope, { title: ' ' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toEqual([]);
  });
});
