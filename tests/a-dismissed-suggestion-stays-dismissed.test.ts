// A suggestion a parent dismissed stays dismissed.
//
// Three dedupes in the Guardian learning loop were keyed wrong:
//
//   * runLearningForFamily built its "already suggested" keys from PENDING
//     suggestions only. The moment a parent dismissed "Block (555) 123-4567?"
//     the row left pending, the nightly cron saw the same 60-day history, and
//     filed the same suggestion again — every night, for up to 60 days.
//   * The late-night signal behind "Add a Quiet Hours rule" counted hours in
//     UTC. For a Pacific family "22:00–06:59" was 15:00–23:59 local, so
//     afternoon calls were "late-night calls", and real 01:00 calls were not.
//   * The SMS processor's "add to contacts?" suggestion checked for ANY
//     update_trust row in the family, any phone, any status, with maybeSingle
//     — so after the family's first such suggestion no other repeat sender was
//     ever suggested, and two rows made the read error and skip silently.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { analyzeCommunications, NIGHT_CALL_THRESHOLD, REPEAT_SCAM_THRESHOLD, type CommSummary } from '@/lib/guardian/learning';

const seam = vi.hoisted(() => ({ pipeline: vi.fn(), scam: vi.fn() }));
vi.mock('@/lib/guardian/pipeline', () => ({ runDecisionPipeline: seam.pipeline }));
vi.mock('@/lib/guardian/scam-ai', () => ({ detectScamWithAI: seam.scam }));
vi.mock('@/lib/guardian/twilio', async (original) => ({
  ...await original<typeof import('@/lib/guardian/twilio')>(), isTwilioConfigured: () => false, sendSms: async () => {}, initiateCall: async () => {},
}));

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const GUARDIAN = '+15555550100';
const SCAMMER = '+15559999999';
const REPEAT = '+15555550199';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;

const scamComm = (i: number) => ({
  id: `aaaaaaaa-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, family_id: FAMILY, member_id: MEMBER, comm_type: 'call_inbound', direction: 'inbound',
  from_number: SCAMMER, contact_id: null, scam_detected: true, trust_level_at_time: 'unknown', started_at: daysAgo(1 + i), status: 'blocked',
});
const flagScam = (status: string, createdDaysAgo: number) => ({
  id: `bbbbbbbb-0000-4000-8000-${createdDaysAgo.toString(16).padStart(12, '0')}`, family_id: FAMILY, suggestion_type: 'flag_scam', status,
  title: `Block ${SCAMMER}?`, reasoning: 'x', evidence: { phone: SCAMMER }, proposed_contact_id: null, proposed_trust_level: null, created_at: daysAgo(createdDaysAgo),
});

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://guardian-fixture.invalid');
  db = createInMemorySupabase({
    uniques: { guardian_callback_events: [['event_id']], notifications: [['id']], ai_tool_calls: [['id']] },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null } },
  });
  db.seed('families', [{ id: FAMILY, name: 'Fixture', timezone: 'UTC' }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('the nightly learning run', () => {
  it('does not re-file a suggestion the parent dismissed this lookback window', async () => {
    const { runLearningForFamily } = await import('@/lib/guardian/learning-run');
    db.seed('guardian_communications', Array.from({ length: REPEAT_SCAM_THRESHOLD + 1 }, (_, i) => scamComm(i)));
    db.seed('guardian_suggestions', [flagScam('dismissed', 3)]);
    const result = await runLearningForFamily(client(), FAMILY);
    // The defect: created 1 — the dismissed row's twin, every night.
    expect(result).toMatchObject({ created: 0 });
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(db.table('guardian_suggestions')).toHaveLength(1);
  });

  it.each(['approved', 'auto_dismissed'])('nor one that was %s', async (status) => {
    const { runLearningForFamily } = await import('@/lib/guardian/learning-run');
    db.seed('guardian_communications', Array.from({ length: REPEAT_SCAM_THRESHOLD + 1 }, (_, i) => scamComm(i)));
    db.seed('guardian_suggestions', [flagScam(status, 10)]);
    expect(await runLearningForFamily(client(), FAMILY)).toMatchObject({ created: 0 });
    expect(db.table('guardian_suggestions')).toHaveLength(1);
  });

  it('still files it when there is no answer on record (positive control), and once the old answer has aged out', async () => {
    const { runLearningForFamily } = await import('@/lib/guardian/learning-run');
    db.seed('guardian_communications', Array.from({ length: REPEAT_SCAM_THRESHOLD + 1 }, (_, i) => scamComm(i)));
    expect(await runLearningForFamily(client(), FAMILY)).toMatchObject({ created: 1 });
    expect(db.table('guardian_suggestions')).toEqual([expect.objectContaining({ suggestion_type: 'flag_scam', evidence: expect.objectContaining({ phone: SCAMMER }) })]);

    db.replace('guardian_suggestions', [flagScam('dismissed', 90)]);
    expect(await runLearningForFamily(client(), FAMILY)).toMatchObject({ created: 1 });
    expect(db.table('guardian_suggestions')).toHaveLength(2);
  });

  it('stops rather than guessing when the family has no usable zone', async () => {
    const { runLearningForFamily } = await import('@/lib/guardian/learning-run');
    db.replace('families', [{ id: FAMILY, name: 'Fixture', timezone: null }]);
    await expect(runLearningForFamily(client(), FAMILY)).rejects.toThrow();
  });
});

describe('the late-night signal', () => {
  const unknownCallsAt = (iso: string): CommSummary[] => Array.from({ length: NIGHT_CALL_THRESHOLD }, (_, i) => ({
    from_number: `+1555000000${i}`, contact_id: null, scam_detected: false, trust_level_at_time: 'unknown', started_at: iso,
  }));

  it('counts night on the family\'s clock: 23:00Z is mid-afternoon in Los Angeles', () => {
    // The defect: three afternoon calls prompted "Add a Quiet Hours rule"
    // whose reasoning claimed three late-night calls.
    const drafts = analyzeCommunications({ communications: unknownCallsAt('2026-01-15T23:00:00Z'), contacts: [], timezone: 'America/Los_Angeles' });
    expect(drafts.find((d) => d.dedupeKey === 'rule:quiet_hours_unknown')).toBeFalsy();
  });

  it('and 09:00Z is one in the morning there', () => {
    const drafts = analyzeCommunications({ communications: unknownCallsAt('2026-01-15T09:00:00Z'), contacts: [], timezone: 'America/Los_Angeles' });
    expect(drafts.find((d) => d.dedupeKey === 'rule:quiet_hours_unknown')).toBeTruthy();
  });

  it('the same instants read the other way round in Tokyo', () => {
    expect(analyzeCommunications({ communications: unknownCallsAt('2026-01-15T23:00:00Z'), contacts: [], timezone: 'Asia/Tokyo' }).find((d) => d.dedupeKey === 'rule:quiet_hours_unknown')).toBeFalsy();
    expect(analyzeCommunications({ communications: unknownCallsAt('2026-01-15T15:00:00Z'), contacts: [], timezone: 'Asia/Tokyo' }).find((d) => d.dedupeKey === 'rule:quiet_hours_unknown')).toBeTruthy();
  });

  it('refuses to analyse without a valid zone', () => {
    expect(() => analyzeCommunications({ communications: [], contacts: [], timezone: 'Mars/Olympus_Mons' })).toThrow(/timezone/);
  });
});

describe('the SMS "add to contacts?" suggestion', () => {
  const sid = (n: number) => `SM${n.toString(16).padStart(32, '0')}`;
  const priorFrom = (from: string, count: number, firstId: number) => db.seed('guardian_communications', Array.from({ length: count }, (_, i) => ({
    id: `cccccccc-0000-4000-8000-${(firstId + i).toString(16).padStart(12, '0')}`, family_id: FAMILY, member_id: MEMBER, comm_type: 'sms_inbound', direction: 'inbound',
    from_number: from, to_number: GUARDIAN, body: `earlier ${i}`, twilio_sms_sid: sid(firstId + i), status: 'received', started_at: daysAgo(1),
    contact_id: null, from_name: null, trust_level_at_time: 'unknown', routing_mode_used: 'voicemail_first', routing_rule_id: null, ai_decision_reason: 'x', scam_detected: false, scam_type: null, scam_confidence: 0,
  })));
  const updateTrust = (phone: string, status: string) => ({
    id: `dddddddd-0000-4000-8000-${phone.slice(-6)}${status.length.toString().padStart(6, '0')}`, family_id: FAMILY, suggestion_type: 'update_trust', status,
    title: 'Add?', reasoning: 'x', evidence: { phone, message_count: 3 }, proposed_contact_id: null, proposed_trust_level: 'known_contact', created_at: daysAgo(2),
  });
  const suggestionsFor = (phone: string) => db.table('guardian_suggestions').filter((row) => (row.evidence as { phone?: string }).phone === phone);

  beforeEach(() => {
    db.seed('family_members', [{ id: MEMBER, family_id: FAMILY, display_name: 'Kid', is_active: true, role: 'child' }]);
    db.seed('guardian_member_profiles', [{ id: PROFILE, family_id: FAMILY, member_id: MEMBER, guardian_phone: GUARDIAN, is_active: true }]);
    seam.pipeline.mockResolvedValue({
      contactId: null, contactName: null, trustLevel: 'unknown', routingMode: 'voicemail_first', spamScore: 0, scamDetected: false, scamType: null,
      ruleId: null, reason: 'No rules matched', shouldEscalate: false, emergencyKeywords: false, memberProfile: null,
    });
    seam.scam.mockResolvedValue({ isScam: false, scamType: null, confidence: 0 });
  });

  it('is filed for a repeat sender even though another sender\'s suggestion exists, in any status', async () => {
    const { receiveGuardianSms } = await import('@/lib/guardian/sms-processing');
    priorFrom(REPEAT, 2, 100);
    db.seed('guardian_suggestions', [updateTrust('+15550001111', 'dismissed'), updateTrust('+15550002222', 'pending')]);
    expect(await receiveGuardianSms(client(), { smsSid: sid(1), from: REPEAT, to: GUARDIAN, body: 'hey, it is me again' })).toBe('completed');
    // The defect: nothing filed — any one update_trust row stopped every other
    // sender, and two of them made the read error and skip silently.
    expect(suggestionsFor(REPEAT)).toEqual([expect.objectContaining({ suggestion_type: 'update_trust', proposed_trust_level: 'known_contact' })]);
  });

  it('is not filed twice for the same sender while one is pending or recently answered', async () => {
    const { receiveGuardianSms } = await import('@/lib/guardian/sms-processing');
    priorFrom(REPEAT, 2, 200);
    db.seed('guardian_suggestions', [updateTrust(REPEAT, 'pending')]);
    expect(await receiveGuardianSms(client(), { smsSid: sid(2), from: REPEAT, to: GUARDIAN, body: 'hey' })).toBe('completed');
    expect(suggestionsFor(REPEAT)).toHaveLength(1);

    db.replace('guardian_suggestions', [updateTrust(REPEAT, 'dismissed')]);
    expect(await receiveGuardianSms(client(), { smsSid: sid(3), from: REPEAT, to: GUARDIAN, body: 'hey again' })).toBe('completed');
    expect(suggestionsFor(REPEAT), 'the parent said no two days ago').toHaveLength(1);
  });

  it('is not filed below the repeat threshold (positive control)', async () => {
    const { receiveGuardianSms } = await import('@/lib/guardian/sms-processing');
    priorFrom(REPEAT, 1, 300);
    expect(await receiveGuardianSms(client(), { smsSid: sid(4), from: REPEAT, to: GUARDIAN, body: 'hello' })).toBe('completed');
    expect(suggestionsFor(REPEAT)).toEqual([]);
  });
});
