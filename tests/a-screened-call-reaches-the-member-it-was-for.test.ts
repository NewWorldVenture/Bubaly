// CALLBACK-C5ECD6199A9B: guardian_member_profiles is per member (unique on
// family_id + member_id), and the screening callback read the family's profile
// with `.eq('family_id').maybeSingle()`. With two protected members that read
// errored, the error was dropped, the AI screened with no profile, and a
// "transfer" decision had no phone to dial, so the caller went to voicemail.
// The screen now resolves the member the call was for through its communication.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({ db: null as unknown, profileSeen: null as unknown }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/server/twilio-ingress', () => ({ verifyTwilioRequest: () => ({ ok: true, via: 'signature' }), twilioRefusal: () => new Response('', { status: 403 }) }));
vi.mock('@/lib/guardian/ai-screen', () => ({
  screeningTurn: async ({ profile }: { profile: unknown }) => {
    state.profileSeen = profile;
    return { responseText: 'Connecting you now.', decision: { action: 'transfer', risk: 'safe', urgency: 'medium', intent: 'personal', summary: 'Grandma calling.', callerName: 'Grandma' } };
  },
  summarizeScreening: async () => 'summary',
}));

const FAMILY = '00000000-0000-4000-8000-00000000c001';
const SESSION = '00000000-0000-4000-8000-00000000c0a1';
const COMM = '00000000-0000-4000-8000-00000000c0c1';

beforeEach(() => {
  const db = createInMemorySupabase({ uniques: { guardian_callback_events: [['event_id']] } });
  db.seed('families', [{ id: FAMILY, name: 'Fixture' }]);
  // `is_active` as the tables default it (true): the screen dials and screens
  // for active members only, as the voice route already routed.
  db.seed('family_members', [
    { id: 'm-grandpa', family_id: FAMILY, display_name: 'Grandpa', phone: '+15550000001', is_active: true },
    { id: 'm-teen', family_id: FAMILY, display_name: 'Teen', phone: '+15550000002', is_active: true },
  ]);
  db.seed('guardian_member_profiles', [
    { id: 'p-grandpa', family_id: FAMILY, member_id: 'm-grandpa', is_active: true },
    { id: 'p-teen', family_id: FAMILY, member_id: 'm-teen', is_active: true },
  ]);
  db.seed('guardian_communications', [{ id: COMM, family_id: FAMILY, member_id: 'm-teen', status: 'screening' }]);
  db.seed('guardian_screening_sessions', [{ id: SESSION, family_id: FAMILY, communication_id: COMM, twilio_call_sid: 'CA0001', caller_number: '+15559999999', turn: 0, status: 'active', messages: [] }]);
  state.db = db;
  state.profileSeen = null;
});

async function screen() {
  const { POST } = await import('@/app/api/guardian/screen/route');
  const body = new URLSearchParams({ CallSid: 'CA00000000000000000000000000000001', SpeechResult: 'Hi, it is Grandma.' });
  return POST(new NextRequest(`https://app.example.test/api/guardian/screen?sessionId=${SESSION}&turn=1`, {
    method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }));
}

describe('a screened call reaches the member it was for', () => {
  it('screens with that member\'s profile and dials that member, in a family protecting two', async () => {
    const response = await screen();
    expect(response.status).toBe(200);
    expect((state.profileSeen as { member_id?: string } | null)?.member_id).toBe('m-teen');
    const xml = await response.text();
    expect(xml).toContain('<Dial');
    expect(xml).toContain('+15550000002');
    expect(xml).not.toContain('+15550000001');
  });
});
