// A voicemail left after AI screening has to reach the family.
//
// The screen route's voicemail and no-phone transfer paths insert a
// "📞 Call from X" notification against the communication, then record to
// /api/guardian/status/voicemail?commId=<the same id>. That route's
// notifyGuardianSms read "any notification about this communication", found
// the screening row, saw a title other than its own "📩 Voicemail from X", and
// threw. The route caught it, released its lease and answered 503 — and every
// Twilio retry did exactly the same. No voicemail notification was ever
// created for a screened call, and the callback ledger never completed.
//
// The dedupe still reads the relation (a matching notice written before this
// receipt's id existed must not be announced twice), but recognises only a row
// carrying its own title: an existing row that is not this one is not a copy
// of this one.
import { createHmac, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const seam = vi.hoisted(() => ({ service: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.service }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const ORIGIN = 'https://guardian-voicemail.invalid';
const TOKEN = 'synthetic-signature-token';
const FAMILY = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const COMM = '33333333-3333-4333-8333-333333333333';
const RECORDING = `RE${'a'.repeat(32)}`;

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;

/** The row the screen route leaves behind before it records the voicemail. */
const screeningNotification = () => ({
  id: randomUUID(), family_id: FAMILY, user_id: null, type: 'system', title: '📞 Call from Grandma', body: 'Grandma calling.',
  related_type: 'guardian_communications', related_id: COMM, send_at: new Date().toISOString(), is_read: false,
});

async function deliverVoicemail() {
  const fields = { RecordingSid: RECORDING, RecordingUrl: 'https://api.twilio.invalid/synthetic-recording', RecordingDuration: '30', TranscriptionText: 'Hi, it is Grandma, call me back.' };
  const url = `${ORIGIN}/api/guardian/status/voicemail?commId=${COMM}`;
  const sorted = Object.keys(fields).sort().map((key) => key + fields[key as keyof typeof fields]).join('');
  const signature = createHmac('sha1', TOKEN).update(url + sorted).digest('base64');
  const route = await import('@/app/api/guardian/status/voicemail/route');
  return route.POST(new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, body: new URLSearchParams(fields) }));
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN); vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Live transport prohibited'); }));
  db = createInMemorySupabase({
    uniques: { guardian_callback_events: [['event_id']], notifications: [['id']] },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null } },
  });
  db.seed('families', [{ id: FAMILY, name: 'Fixture', timezone: 'UTC' }]);
  db.seed('guardian_communications', [{ id: COMM, family_id: FAMILY, member_id: MEMBER, from_number: '+15555550200', from_name: 'Grandma', status: 'handled' }]);
  seam.service.mockImplementation(() => db);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('notifyGuardianSms beside a notification that is not its own', () => {
  it('creates the voicemail notification, and still deduplicates itself', async () => {
    const { notifyGuardianSms } = await import('@/lib/guardian/sms-notification');
    const { guardianSmsNotificationId } = await import('@/lib/guardian/sms-receipt');
    const { scopeForSystem } = await import('@/lib/services/scope');
    db.seed('notifications', [screeningNotification()]);
    const scope = scopeForSystem(client(), { id: FAMILY, timezone: 'UTC' });
    const receiptId = randomUUID();
    const input = { recipients: 'family' as const, type: 'system' as const, title: '📩 Voicemail from Grandma', body: '"Hi, it is Grandma"', relatedType: 'guardian_communications', relatedId: COMM };
    // The defect: this threw "Guardian SMS notification unavailable".
    const first = await notifyGuardianSms(scope, input, { receiptId, beforeWrite: async () => {} });
    expect(first).toMatchObject({ ok: true, data: { created: 1, duplicates: 0, ids: [guardianSmsNotificationId(receiptId)] } });
    expect(db.table('notifications')).toHaveLength(2);
    expect(db.table('notifications').find((row) => row.id === guardianSmsNotificationId(receiptId))).toMatchObject({ title: '📩 Voicemail from Grandma', related_id: COMM });

    // The dedupe is still a dedupe: the same receipt is one notification.
    const again = await notifyGuardianSms(scope, input, { receiptId, beforeWrite: async () => {} });
    expect(again).toMatchObject({ ok: true, data: { created: 0, duplicates: 1 } });
    expect(db.table('notifications')).toHaveLength(2);
  });
});

describe('the voicemail callback after a screened call', () => {
  it('completes and announces the voicemail instead of answering 503 for ever', async () => {
    db.seed('notifications', [screeningNotification()]);
    const first = await deliverVoicemail();
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('voicemail.thankYouForYourMessage');
    const titles = db.table('notifications').map((row) => row.title).sort();
    // The defect: 503, no voicemail row, and the same 503 on every retry.
    expect(titles).toEqual(['📞 Call from Grandma', '📩 Voicemail from Grandma']);
    expect(db.table('guardian_communications')[0]).toMatchObject({ status: 'handled', call_recording_url: 'https://api.twilio.invalid/synthetic-recording' });
    expect(db.table('guardian_callback_events')).toEqual([expect.objectContaining({ event_id: RECORDING, status: 'processed' })]);

    // A Twilio retry is acknowledged without a second announcement.
    const retry = await deliverVoicemail();
    expect(retry.status).toBe(200);
    expect(db.table('notifications')).toHaveLength(2);
  });
});
