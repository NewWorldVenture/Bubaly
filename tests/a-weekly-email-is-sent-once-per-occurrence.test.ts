import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { SCHEDULES } from '../scripts/cron-dispatch.mjs';
import {
  CHORE_REMINDERS_SCHEDULE, WEEKLY_DIGEST_SCHEDULE, occurrenceSendKey, weeklySlot,
} from '@/lib/server/cron-occurrence';

/**
 * The weekly emails reach each recipient once per occurrence, however many
 * times the route is called for it.
 *
 * chore-reminders (`0 18 * * 0`) and weekly-digest (`0 8 * * 1`) are fired by
 * vercel.json AND by the GitHub dispatcher, whose SCHEDULES mirror it minute
 * for minute (a tick at 18:02 on a Sunday dispatches chore-reminders —
 * tests/cron-dispatch.test.ts). Vercel may deliver one event twice, and a run
 * that answers 502 because ONE send failed invites a re-dispatch. Neither
 * route recorded what it had sent, so every one of those second calls emailed
 * every recipient again. tests/a-mirrored-cron-must-be-idempotent.test.ts let
 * them through because the word "already" appears in a comment of each.
 *
 * What is real: both route handlers, lib/email.ts's sendReactEmail, the paging
 * helpers and the child-channel policy, over tests/helpers/in-memory-supabase.
 * What is fake: Resend, as a key store that behaves the way the provider
 * documents — a repeat under a used key with the same bytes is answered with
 * the original result and NOT delivered, with different bytes it is refused
 * (409 invalid_idempotent_request), and a request without a key is always
 * delivered. Nothing leaves the process.
 */

type Props = Record<string, unknown>;
const mail = vi.hoisted(() => ({
  delivered: [] as { to: string; subject: string; key: string | null }[],
  keys: new Map<string, string>(),
  failOnce: new Set<string>(),
  db: null as unknown,
  users: [] as { id: string; email: string }[],
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (payload: { to: string; subject: string; react: { props: Props } }, options?: { idempotencyKey?: string }) => {
        if (mail.failOnce.delete(payload.to)) {
          return { data: null, error: { name: 'application_error', message: 'Synthetic provider failure', statusCode: 500 } };
        }
        const key = options?.idempotencyKey ?? null;
        const bytes = JSON.stringify({ to: payload.to, subject: payload.subject, props: payload.react.props });
        if (key !== null) {
          const stored = mail.keys.get(key);
          if (stored === bytes) return { data: { id: `folded-${key}` }, error: null };
          if (stored !== undefined) {
            return { data: null, error: { name: 'invalid_idempotent_request', message: 'Synthetic key reuse', statusCode: 409 } };
          }
          mail.keys.set(key, bytes);
        }
        mail.delivered.push({ to: payload.to, subject: payload.subject, key });
        return { data: { id: `sent-${mail.delivered.length}` }, error: null };
      },
    };
  },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mail.db }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/server/list-all-auth-users', () => ({ listAllAuthUsers: async () => ({ users: mail.users, error: null }) }));
vi.mock('@/lib/network/compare-line-server', () => ({ loadCompareLine: async () => null }));
vi.mock('@/lib/network/compare-line', () => ({ renderCompareLine: () => null }));
vi.mock('@/lib/services/calendar/search-occurrences', () => ({
  readCompleteCalendarOccurrences: async () => ({ ok: true, data: { occurrences: [] } }),
}));

import { GET as choreReminders } from '@/app/api/cron/chore-reminders/route';
import { GET as weeklyDigest } from '@/app/api/cron/weekly-digest/route';

const FAMILY = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'];
const USER = ['20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002'];
const MEMBER = ['30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002'];
const CHORE = '40000000-0000-4000-8000-000000000001';
const email = (i: number) => `parent${i}@synthetic.invalid`;

let db: InMemorySupabase;
const call = (route: typeof choreReminders, path: string) => route(new NextRequest(`https://synthetic.invalid${path}`));
const reminders = () => call(choreReminders, '/api/cron/chore-reminders');
const digest = () => call(weeklyDigest, '/api/cron/weekly-digest');
const deliveredTo = () => mail.delivered.map((m) => m.to).sort();

function seed(nowIso: string) {
  db = createInMemorySupabase();
  mail.db = db;
  mail.users = USER.map((id, i) => ({ id, email: email(i) }));
  db.seed('families', FAMILY.map((id, i) => ({ id, name: `Synthetic family ${i}`, timezone: 'UTC' })));
  db.seed('family_members', MEMBER.map((id, i) => ({
    id, family_id: FAMILY[i], user_id: USER[i], display_name: `Synthetic parent ${i}`, role: 'parent', is_active: true,
  })));
  db.seed('chores', [{ id: CHORE, title: 'Synthetic chore', points: 5 }]);
  // `family_member_id` only lets the in-memory embed resolve `family_members!member_id(...)`.
  db.seed('chore_assignments', MEMBER.map((id, i) => ({
    id: `50000000-0000-4000-8000-00000000000${i + 1}`, family_id: FAMILY[i], member_id: id, family_member_id: id,
    chore_id: CHORE, status: 'todo', due_at: new Date(Date.parse(nowIso) + 2 * 86_400_000).toISOString(),
  })));
}

beforeEach(() => {
  mail.delivered = []; mail.keys = new Map(); mail.failOnce = new Set();
  vi.stubEnv('RESEND_API_KEY', 'synthetic-resend-key');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('chore reminders go out once per Sunday slot', () => {
  beforeEach(() => { vi.setSystemTime(new Date('2026-10-04T18:00:20Z')); seed('2026-10-04T18:00:20Z'); });

  it('two runs for the same slot, overlapping, email each member once', async () => {
    const [first, second] = await Promise.all([reminders(), reminders()]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(deliveredTo()).toEqual([email(0), email(1)]);
  });

  it('the dispatcher tick four minutes after Vercel’s is folded, not sent', async () => {
    expect((await reminders()).status).toBe(200);
    vi.setSystemTime(new Date('2026-10-04T18:04:00Z'));
    expect((await reminders()).status).toBe(200);
    expect(deliveredTo()).toEqual([email(0), email(1)]);
  });

  it('the re-run a partial failure invites reaches only the member it missed', async () => {
    mail.failOnce.add(email(1));
    const failed = await reminders();
    expect(failed.status).toBe(502);
    expect(deliveredTo()).toEqual([email(0)]);

    vi.setSystemTime(new Date('2026-10-04T19:30:00Z'));
    const retried = await reminders();
    expect(retried.status).toBe(200);
    expect(deliveredTo()).toEqual([email(0), email(1)]);
  });

  it('next Sunday is a new occurrence and is sent', async () => {
    await reminders();
    vi.setSystemTime(new Date('2026-10-11T18:00:20Z'));
    await reminders();
    expect(mail.delivered).toHaveLength(4);
  });
});

describe('the weekly digest goes out once per Monday slot', () => {
  beforeEach(() => { vi.setSystemTime(new Date('2026-10-05T08:00:20Z')); seed('2026-10-05T08:00:20Z'); });

  it('two runs for the same slot, overlapping, email each family once', async () => {
    const [first, second] = await Promise.all([digest(), digest()]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(deliveredTo()).toEqual([email(0), email(1)]);
  });

  it('the re-run a partial failure invites reaches only the family it missed', async () => {
    mail.failOnce.add(email(0));
    expect((await digest()).status).toBe(502);
    expect(deliveredTo()).toEqual([email(1)]);

    vi.setSystemTime(new Date('2026-10-05T09:10:00Z'));
    expect((await digest()).status).toBe(200);
    expect(deliveredTo()).toEqual([email(0), email(1)]);
  });

  it('next Monday is a new occurrence and is sent', async () => {
    await digest();
    vi.setSystemTime(new Date('2026-10-12T08:00:20Z'));
    await digest();
    expect(mail.delivered).toHaveLength(4);
  });
});

describe('the occurrence is the schedule’s slot', () => {
  const vercel = JSON.parse(readFileSync(join(__dirname, '..', 'vercel.json'), 'utf8')) as { crons: { path: string; schedule: string }[] };
  const cron = ({ dayUtc, hourUtc, minuteUtc }: { dayUtc: number; hourUtc: number; minuteUtc: number }) => `${minuteUtc} ${hourUtc} * * ${dayUtc}`;

  it('names the minute both schedulers fire', () => {
    for (const [path, schedule] of [
      ['/api/cron/chore-reminders', CHORE_REMINDERS_SCHEDULE],
      ['/api/cron/weekly-digest', WEEKLY_DIGEST_SCHEDULE],
    ] as const) {
      expect(vercel.crons.find((c) => c.path === path)?.schedule).toBe(cron(schedule));
      expect((SCHEDULES as Record<string, string>)[path]).toBe(cron(schedule));
    }
  });

  it('is the latest firing at or before now', () => {
    const at = (iso: string) => weeklySlot(new Date(iso), CHORE_REMINDERS_SCHEDULE).toISOString();
    expect(at('2026-10-04T18:00:00Z')).toBe('2026-10-04T18:00:00.000Z');
    expect(at('2026-10-04T18:04:59Z')).toBe('2026-10-04T18:00:00.000Z');
    expect(at('2026-10-04T17:59:59Z')).toBe('2026-09-27T18:00:00.000Z');
    expect(at('2026-10-07T03:00:00Z')).toBe('2026-10-04T18:00:00.000Z');
    expect(weeklySlot(new Date('2026-10-05T07:59:00Z'), WEEKLY_DIGEST_SCHEDULE).toISOString()).toBe('2026-09-28T08:00:00.000Z');
  });

  it('keys each recipient of each occurrence apart, within the provider’s limits', () => {
    const slot = weeklySlot(new Date('2026-10-04T18:00:00Z'), CHORE_REMINDERS_SCHEDULE);
    const key = occurrenceSendKey('chore-reminders', slot, MEMBER[0]);
    expect(key).toMatch(/^chore-reminders\/[0-9a-f]{64}$/);
    expect(key).not.toContain(MEMBER[0]);
    expect(occurrenceSendKey('chore-reminders', slot, MEMBER[1])).not.toBe(key);
    expect(occurrenceSendKey('weekly-digest', slot, MEMBER[0])).not.toBe(key);
    expect(occurrenceSendKey('chore-reminders', new Date(slot.getTime() + 7 * 86_400_000), MEMBER[0])).not.toBe(key);
  });
});
