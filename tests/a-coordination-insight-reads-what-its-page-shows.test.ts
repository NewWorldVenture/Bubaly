import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

// The family-coordination AI Assist kinds on POST /api/ai/insights, driven
// through the REAL route against an in-memory database (RLS is not modelled:
// the held 0506 and 0510 leave it family-wide, which is exactly the case).
//
//   N1   behavior  a teen or child was given a model summary of EVERY behaviour
//                  note in the family, siblings' included, while the Behavior
//                  page shows them only the notes they wrote
//   N4   sleep     a child's AI Sleep Coach listed every member by name with
//                  their nights, mood and energy, while the Sleep page shows a
//                  non-manager only their own record and what they logged
//   N12  contacts, signups, behavior turned a failed read into an empty
//                  household at HTTP 200; contacts said "20 total" of hundreds
//   N13  signups   read the 40 OLDEST sign-ups, so with thirty past ones on file
//                  a deadline closing this week was "Deadlines within 14 days: 0"

const FAMILY = 'family-one';
const ME = 'member-me';
const SIB = 'member-sib';

const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn(), role: 'parent' as string, memberId: 'member-me' as string | null }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-me' },
    active: { familyId: FAMILY, role: h.role, member: { id: h.memberId }, family: { timezone: 'America/Los_Angeles', name: 'Fixture' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: h.complete }), describeAIError: () => ({ message: 'unavailable' }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null, refuseIfLocked: async () => null }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

const { POST } = await import('@/app/api/ai/insights/route');

let base: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let failing: string | null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 18:00 on Monday 12 October in Los Angeles — already the 13th at Greenwich.
  vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));
  base = createInMemorySupabase<SupabaseClient<Database>>();
  failing = null;
  h.role = 'parent';
  h.memberId = ME;
  h.db = withFaults(base, (table) => (table === failing ? { message: 'Fixture read refused' } : null));
  h.complete.mockReset().mockResolvedValue({ text: 'A grounded suggestion.' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  base.seed('family_members', [
    { id: ME, family_id: FAMILY, display_name: 'Ada', is_active: true },
    { id: SIB, family_id: FAMILY, display_name: 'Ben', is_active: true },
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const ask = (kind: string, question?: string) => POST(new Request('https://fixture.invalid/api/ai/insights', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, ...(question ? { question } : {}) }),
}));
const prompt = () => (h.complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;

describe('N1: the behaviour coach summarises the notes its page shows the asker', () => {
  beforeEach(() => {
    base.seed('behavior_logs', [
      { id: 'b1', family_id: FAMILY, member_id: SIB, kind: 'concern', category: 'honesty', note: 'Ben lied about homework', points: -1, occurred_at: '2026-10-10T18:00:00Z', logged_by: 'user-parent' },
      { id: 'b2', family_id: FAMILY, member_id: SIB, kind: 'concern', category: 'kindness', note: 'Ben hit his sister', points: -1, occurred_at: '2026-10-11T18:00:00Z', logged_by: 'user-parent' },
      { id: 'b3', family_id: FAMILY, member_id: ME, kind: 'positive', category: 'responsibility', note: 'I walked the dog', points: 1, occurred_at: '2026-10-12T18:00:00Z', logged_by: 'user-me' },
    ]);
  });

  it.each(['teen', 'child'])('a %s is summarised only the notes they wrote', async (role) => {
    h.role = role;
    const response = await ask('behavior', 'What was logged about Ben?');
    expect(response.status).toBe(200);
    const text = prompt();
    expect(text).toContain('I walked the dog');
    expect(text).not.toContain('Ben lied about homework');
    expect(text).not.toContain('Ben hit his sister');
    expect(text).toContain('Behavior logs (recent 1)');
  });

  it.each(['parent', 'caregiver'])('a %s still reads every note', async (role) => {
    h.role = role;
    expect((await ask('behavior')).status).toBe(200);
    expect(prompt()).toContain('Ben lied about homework');
    expect(prompt()).toContain('Behavior logs (recent 3)');
  });
});

describe('N4: the sleep coach summarises the record its page shows the asker', () => {
  beforeEach(() => {
    base.seed('sleep_logs', [
      { id: 's1', family_id: FAMILY, member_id: SIB, sleep_date: '2026-10-11', bedtime: '2026-10-11T04:30:00Z', wake_time: '2026-10-11T12:00:00Z', duration_min: 450, quality: 2, awakenings: 6, created_by: 'user-parent' },
      { id: 's2', family_id: FAMILY, member_id: ME, sleep_date: '2026-10-12', bedtime: '2026-10-12T05:00:00Z', wake_time: '2026-10-12T13:00:00Z', duration_min: 480, quality: 4, awakenings: 1, created_by: 'user-me' },
    ]);
    base.seed('sleep_checkins', [
      { id: 'c1', family_id: FAMILY, member_id: SIB, checkin_date: '2026-10-11', energy: 1, mood: 1, caffeine_after_2pm: true, screens_in_bed: true, exercised: false, created_by: 'user-parent' },
    ]);
    base.seed('bedtime_routines', [
      { id: 'r1', family_id: FAMILY, member_id: SIB, target_bedtime: '20:00', target_wake: '07:00', wind_down_min: 30, steps: ['bath'], is_active: true, created_by: 'user-parent' },
    ]);
  });

  it.each(['child', 'teen', 'caregiver', 'guest'])('a %s is not given another member\'s nights, mood or energy', async (role) => {
    h.role = role;
    expect((await ask('sleep')).status).toBe(200);
    const text = prompt();
    expect(text).toContain('Ada: 8h 0m');
    expect(text).not.toContain('Ben:');
    expect(text).not.toContain('energy 1/5');
    expect(text).toContain('No check-ins yet.');
  });

  it('a parent still reads every member\'s', async () => {
    expect((await ask('sleep')).status).toBe(200);
    expect(prompt()).toContain('Ben: 7h 30m');
    expect(prompt()).toContain('Ben: energy 1/5, mood 1/5');
  });

  // N4-R1: the Sleep page shows a non-manager the nights they logged for
  // someone else, but no summary of them (lib/health/record-scope.ts, the
  // 'authored' scope): a summary built from part of a record reads as the
  // member's whole record. The coach is a summary, so it is built from the
  // asker's own record only.
  it('a non-manager is coached on a night someone else logged FOR them, and not on one they logged for someone else', async () => {
    h.role = 'teen';
    base.seed('sleep_logs', [
      { id: 's3', family_id: FAMILY, member_id: SIB, sleep_date: '2026-10-12', bedtime: '2026-10-12T04:00:00Z', wake_time: '2026-10-12T12:00:00Z', duration_min: 480, quality: 3, awakenings: 0, created_by: 'user-me' },
      { id: 's4', family_id: FAMILY, member_id: ME, sleep_date: '2026-10-11', bedtime: '2026-10-11T05:00:00Z', wake_time: '2026-10-11T12:30:00Z', duration_min: 450, quality: 3, awakenings: 0, created_by: 'user-parent' },
    ]);
    expect((await ask('sleep')).status).toBe(200);
    expect(prompt()).toContain('Ada: 7h 30m');
    expect(prompt()).not.toContain('Ben:');
  });

  it('a caregiver\'s coach is not built from the nights, check-ins and routine they logged for a ward', async () => {
    h.role = 'caregiver';
    base.seed('sleep_logs', [
      { id: 'w1', family_id: FAMILY, member_id: SIB, sleep_date: '2026-10-12', bedtime: '2026-10-12T03:00:00Z', wake_time: '2026-10-12T09:00:00Z', duration_min: 360, quality: 1, awakenings: 4, created_by: 'user-me' },
    ]);
    base.seed('sleep_checkins', [
      { id: 'wc1', family_id: FAMILY, member_id: SIB, checkin_date: '2026-10-12', energy: 2, mood: 2, caffeine_after_2pm: false, screens_in_bed: true, exercised: false, created_by: 'user-me' },
    ]);
    base.seed('bedtime_routines', [
      { id: 'wr1', family_id: FAMILY, member_id: SIB, target_bedtime: '19:30', target_wake: '06:30', wind_down_min: 20, steps: ['story'], is_active: true, created_by: 'user-me' },
    ]);
    expect((await ask('sleep')).status).toBe(200);
    const text = prompt();
    expect(text).toContain('Ada: 8h 0m');
    expect(text).not.toContain('Ben:');
    expect(text).not.toContain('6h 0m');
    expect(text).not.toContain('energy 2/5');
    expect(text).not.toContain('story');
  });

  it('a non-manager with no member record of their own is coached on nothing', async () => {
    h.role = 'guest';
    h.memberId = null;
    base.seed('sleep_logs', [
      { id: 'g1', family_id: FAMILY, member_id: SIB, sleep_date: '2026-10-12', bedtime: '2026-10-12T03:00:00Z', wake_time: '2026-10-12T09:00:00Z', duration_min: 360, quality: 1, awakenings: 4, created_by: 'user-me' },
    ]);
    expect((await ask('sleep')).status).toBe(200);
    expect(prompt()).toContain('No nights logged yet.');
    expect(prompt()).not.toContain('Ben:');
  });
});

describe('N12: a failed read is not an empty household', () => {
  it.each([
    ['contacts', 'family_contacts'],
    ['signups', 'opportunities'],
    ['behavior', 'behavior_logs'],
  ])('%s answers "could not load" when %s is refused', async (kind, table) => {
    failing = table;
    const response = await ask(kind);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'insights.couldNotLoadDataFor' });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('counts the family\'s contacts rather than reporting the capped read as the total', async () => {
    base.seed('family_contacts', Array.from({ length: 45 }, (_, i) => ({
      id: `contact-${String(i).padStart(3, '0')}`, family_id: FAMILY, name: `Contact ${String(i).padStart(2, '0')}`, category: 'friend',
    })));
    expect((await ask('contacts')).status).toBe(200);
    expect(prompt()).toContain('Contacts (45 total, 12 listed)');
    expect(prompt()).not.toContain('Contacts (20 total)');
  });
});

describe('N13: the sign-ups advisor reads the deadlines still ahead', () => {
  beforeEach(() => {
    // Thirty-five past sign-ups kept on file, every one with an earlier deadline.
    base.seed('opportunities', Array.from({ length: 35 }, (_, i) => ({
      id: `past-${String(i).padStart(2, '0')}`, family_id: FAMILY, title: `Old camp ${i}`, category: 'camp',
      deadline: `2025-0${1 + (i % 9)}-1${i % 10}`, status: i % 2 ? 'passed' : 'missed',
    })));
    base.seed('opportunities', [
      // Closing this week on the family's day (Monday the 12th in Los Angeles).
      { id: 'soon', family_id: FAMILY, title: 'Swim team tryouts', category: 'sports', deadline: '2026-10-16', status: 'interested' },
      { id: 'done', family_id: FAMILY, title: 'Piano recital', category: 'music', deadline: '2026-10-15', status: 'registered' },
      { id: 'later', family_id: FAMILY, title: 'Spring robotics', category: 'stem', deadline: '2027-01-20', status: 'waitlisted' },
    ]);
  });

  it('names the deadline closing this week, by its title', async () => {
    expect((await ask('signups')).status).toBe(200);
    const text = prompt();
    expect(text).toContain('Deadlines within 14 days: 1');
    expect(text).toContain('"name":"Swim team tryouts","deadline":"2026-10-16","type":"sports"');
  });

  it('counts only the sign-ups still open: not registered, missed or passed', async () => {
    expect((await ask('signups')).status).toBe(200);
    expect(prompt()).toContain('Open opportunities: 2.');
    expect(prompt()).not.toContain('Piano recital');
  });
});
