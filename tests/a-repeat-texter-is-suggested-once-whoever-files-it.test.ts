// A repeat texter is suggested once, whoever files the suggestion.
//
// Two writers file the same "Add (555) 555-0199 to your contacts?" suggestion:
// the learning run (lib/guardian/learning-run.ts, trust:<phone>:known_contact)
// and the inbound-SMS path (lib/guardian/sms-processing.ts). Both dedupe by
// reading and then inserting, and only the learning run took the family's
// learning lease. A text processed inside a learning run's read-to-insert span
// read "not suggested yet" and inserted, the run inserted too, and the parent's
// queue held the suggestion twice.
//
// The SMS path now files under the same lease (a sender already suggested
// does not take it), and its insert reads the pending key's unique index (the
// owner's migration) refusing a second copy, 23505, as "already suggested"
// rather than a failure. Driven through the real
// cron route, the real SMS processor and the real learning run against the
// in-memory database; the learning run is held inside its span by a gate on its
// own suggestion read, so the overlap is the one exercised on every run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { FREQUENT_UNKNOWN_THRESHOLD } from '@/lib/guardian/learning';

type Then = (ok?: (value: unknown) => unknown, ko?: (reason: unknown) => unknown) => Promise<unknown>;
type Builder = { select: (...args: unknown[]) => Builder; insert: (...args: unknown[]) => Builder; then: Then };

const h = vi.hoisted(() => ({
  db: null as unknown,
  /** Runs when the learning run's own suggestion read is answered, before it returns. */
  onLearningRead: null as null | (() => Promise<void>),
  /** Runs before the SMS path's suggestion insert reaches the database. */
  beforeSmsInsert: null as null | (() => Promise<void>),
  /** What the database answers the SMS path's suggestion insert, in place of the insert. */
  smsInsertReply: null as null | { data: null; error: { code: string; message: string }; count: null },
}));
const seam = vi.hoisted(() => ({ pipeline: vi.fn(), scam: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/guardian/pipeline', () => ({ runDecisionPipeline: seam.pipeline }));
vi.mock('@/lib/guardian/scam-ai', () => ({ detectScamWithAI: seam.scam }));
vi.mock('@/lib/guardian/twilio', async (original) => ({
  ...await original<typeof import('@/lib/guardian/twilio')>(), isTwilioConfigured: () => false, sendSms: async () => {}, initiateCall: async () => {},
}));

const { GET } = await import('@/app/api/cron/guardian-learning/route');
const { receiveGuardianSms } = await import('@/lib/guardian/sms-processing');

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const GUARDIAN = '+15555550100';
const REPEAT = '+15555550199';
const DAY = 86_400_000;
const sid = (n: number) => `SM${n.toString(16).padStart(32, '0')}`;
const req = () => new Request('https://bubaly.test/api/cron/guardian-learning') as never;

let db: InMemorySupabase;
const suggestionsFor = (phone: string) => db.table('guardian_suggestions').filter((row) => (row.evidence as { phone?: string }).phone === phone);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

/**
 * The database both writers see. Two seams, nothing else changed: the learning
 * run's suggestion read (the one that selects `evidence`) can be held after it
 * is answered, and the SMS path's suggestion insert can be preceded by another
 * writer's.
 */
function seams(target: InMemorySupabase): SupabaseClient<Database> {
  return new Proxy(target as object, {
    get(base, prop, receiver) {
      if (prop !== 'from') return Reflect.get(base, prop, receiver);
      return (name: string) => {
        const builder = (base as InMemorySupabase).from(name as never) as unknown as Builder;
        if (name !== 'guardian_suggestions') return builder;
        const select = builder.select.bind(builder);
        builder.select = (...args: unknown[]) => {
          const chain = select(...args);
          const hold = h.onLearningRead;
          if (hold && String(args[0]).includes('evidence')) {
            h.onLearningRead = null;
            const then = chain.then.bind(chain);
            chain.then = (ok, ko) => then(async (reply) => { await hold(); return reply; }).then(ok, ko);
          }
          return chain;
        };
        const insert = builder.insert.bind(builder);
        builder.insert = (...args: unknown[]) => {
          const chain = insert(...args);
          // The SMS path's row is the one that carries `message_count`.
          if ((args[0] as { evidence?: { message_count?: unknown } }).evidence?.message_count === undefined) return chain;
          const first = h.beforeSmsInsert;
          const reply = h.smsInsertReply;
          h.beforeSmsInsert = null;
          const then = chain.then.bind(chain);
          chain.then = (ok, ko) => (first ? first() : Promise.resolve()).then(() => (reply ? Promise.resolve(reply).then(ok, ko) : then(ok, ko)));
          return chain;
        };
        return builder;
      };
    },
  }) as SupabaseClient<Database>;
}

function seedFamily(opts: { ownerIndex?: boolean } = {}) {
  db = createInMemorySupabase({
    uniques: {
      guardian_callback_events: [['event_id']], notifications: [['id']], ai_tool_calls: [['id']], app_settings: [['key']],
      // The owner's partial unique index on the pending dedupe key, where asked
      // for. Every row these cases write is pending, so the partial predicate
      // changes nothing here.
      ...(opts.ownerIndex ? { guardian_suggestions: [['family_id', 'suggestion_type', 'evidence->>phone', 'proposed_trust_level']] } : {}),
    },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null }, guardian_suggestions: { status: 'pending' } },
  });
  h.db = seams(db);
  db.seed('families', [{ id: FAMILY, name: 'Fixture', timezone: 'UTC', closed_at: null }]);
  db.seed('family_members', [{ id: MEMBER, family_id: FAMILY, display_name: 'Kid', is_active: true, role: 'child' }]);
  db.seed('guardian_member_profiles', [{ id: PROFILE, family_id: FAMILY, member_id: MEMBER, guardian_phone: GUARDIAN, is_active: true }]);
  // Enough earlier texts from one unknown, never-scam sender for BOTH writers
  // to propose saving them: the learning run's threshold and the SMS path's.
  db.seed('guardian_communications', Array.from({ length: FREQUENT_UNKNOWN_THRESHOLD }, (_, i) => ({
    id: `cccccccc-0000-4000-8000-${(100 + i).toString(16).padStart(12, '0')}`, family_id: FAMILY, member_id: MEMBER, comm_type: 'sms_inbound', direction: 'inbound',
    from_number: REPEAT, to_number: GUARDIAN, body: `earlier ${i}`, twilio_sms_sid: sid(100 + i), status: 'received', started_at: new Date(Date.now() - (1 + i) * DAY).toISOString(),
    contact_id: null, from_name: null, trust_level_at_time: 'unknown', routing_mode_used: 'voicemail_first', routing_rule_id: null, ai_decision_reason: 'x', scam_detected: false, scam_type: null, scam_confidence: 0,
  })));
}

const client = () => h.db as SupabaseClient<Database>;
const text = (n: number) => receiveGuardianSms(client(), { smsSid: sid(n), from: REPEAT, to: GUARDIAN, body: 'hey, it is me again' });
const notFiledLogged = () => vi.mocked(console.error).mock.calls.some((call) => String(call[0]).includes('suggestion was not filed'));

beforeEach(() => {
  // Midday, so the earlier texts are daytime ones and the run's only draft
  // for this family is the sender's "add to contacts?".
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://guardian-fixture.invalid');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.onLearningRead = null;
  h.beforeSmsInsert = null;
  h.smsInsertReply = null;
  seam.pipeline.mockResolvedValue({
    contactId: null, contactName: null, trustLevel: 'unknown', routingMode: 'voicemail_first', spamScore: 0, scamDetected: false, scamType: null,
    ruleId: null, reason: 'No rules matched', shouldEscalate: false, emergencyKeywords: false, memberProfile: null,
  });
  seam.scam.mockResolvedValue({ isScam: false, scamType: null, confidence: 0 });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('a text that arrives while the nightly learning run is between its read and its insert', () => {
  it('files nothing of its own: the run that holds the lease files the one suggestion', async () => {
    seedFamily();
    const inSpan = deferred();
    const release = deferred();
    h.onLearningRead = async () => { inSpan.resolve(); await release.promise; };

    const learning = GET(req());
    await inSpan.promise;
    // The run has read "not suggested yet" and has not inserted.
    expect(await text(1)).toBe('completed');
    release.resolve();
    const body = await (await learning).json();

    expect(body).toMatchObject({ ok: true, suggestionsCreated: 1, failed: 0 });
    // The defect: two — the text read "not suggested yet" inside the run's span
    // and inserted, and then the run inserted its own.
    expect(suggestionsFor(REPEAT)).toEqual([expect.objectContaining({ suggestion_type: 'update_trust', proposed_trust_level: 'known_contact' })]);
  });

  it('the text after the run is answered by the run\'s suggestion, and files nothing (control)', async () => {
    seedFamily();
    expect(await (await GET(req())).json()).toMatchObject({ ok: true, suggestionsCreated: 1 });
    expect(await text(2)).toBe('completed');
    expect(suggestionsFor(REPEAT)).toHaveLength(1);
  });

  it('a text with no learning run about files the suggestion itself, and gives the lease back (control)', async () => {
    seedFamily();
    expect(await text(3)).toBe('completed');
    expect(suggestionsFor(REPEAT)).toHaveLength(1);
    // Released: the nightly run that follows learns for the family, and
    // finds the suggestion already filed.
    expect(await (await GET(req())).json()).toMatchObject({ ok: true, suggestionsCreated: 0, busy: 0 });
    expect(suggestionsFor(REPEAT)).toHaveLength(1);
  });

  it('a text from a sender already suggested leaves the lease alone, so it cannot turn a learning run away (control)', async () => {
    seedFamily();
    expect(await text(6)).toBe('completed');
    // Each claim writes a fresh token; a release only re-dates the row.
    const holder = () => db.table('app_settings').find((row) => row.key === `guardian-learning:${FAMILY}`)?.value;
    const first = holder();
    expect(first, 'the first text filed under the lease').toEqual({ token: expect.any(String) });
    expect(await text(7)).toBe('completed');
    expect(suggestionsFor(REPEAT)).toHaveLength(1);
    expect(holder(), 'the second text claimed the lease').toEqual(first);
  });
});

describe('the pending key\'s unique index refusing the SMS path\'s copy', () => {
  it('is "already suggested": the text completes, one suggestion stands, and nothing is reported as a failure', async () => {
    seedFamily({ ownerIndex: true });
    // A writer the lease does not fence (a holder past its ttl) files it
    // between the SMS path's read and its insert.
    h.beforeSmsInsert = async () => {
      db.seed('guardian_suggestions', [{
        id: 'dddddddd-0000-4000-8000-000000000001', family_id: FAMILY, suggestion_type: 'update_trust', status: 'pending', title: 'Add?', reasoning: 'x',
        evidence: { phone: REPEAT, total: FREQUENT_UNKNOWN_THRESHOLD }, proposed_contact_id: null, proposed_trust_level: 'known_contact', created_at: new Date().toISOString(),
      }]);
    };
    expect(await text(4)).toBe('completed');
    expect(h.beforeSmsInsert, 'the SMS path reached its insert').toBeNull();
    expect(suggestionsFor(REPEAT)).toHaveLength(1);
    expect(notFiledLogged()).toBe(false);
  });

  it('while a refusal that is not the unique key is said out loud, and still does not fail the text', async () => {
    seedFamily();
    // Any other refusal: here the statement timing out.
    h.smsInsertReply = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, count: null };
    expect(await text(5)).toBe('completed');
    expect(suggestionsFor(REPEAT)).toEqual([]);
    // The defect: the insert's answer was never read, so a refused suggestion
    // vanished without a word.
    expect(notFiledLogged()).toBe(true);
  });
});
