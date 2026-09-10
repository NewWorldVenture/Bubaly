import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), submit: vi.fn(), sendEmail: vi.fn(), sendSms: vi.fn(), concierge: vi.fn() }));
vi.mock('@/lib/supabase/server', async (original) => ({ ...await original<typeof import('@/lib/supabase/server')>(), createServiceClient: mocks.admin }));
vi.mock('@/lib/ai/runs/intake', () => ({ submitRequest: mocks.submit }));
vi.mock('@/lib/server/email', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('@/lib/guardian/twilio', async (original) => ({ ...await original<typeof import('@/lib/guardian/twilio')>(), sendSms: mocks.sendSms }));
vi.mock('@/lib/contact-center/concierge', async (original) => ({ ...await original<typeof import('@/lib/contact-center/concierge')>(), runConcierge: mocks.concierge }));
const { POST } = await import('@/app/api/contact-center/email/route');
let db: ReturnType<typeof createInMemorySupabase>;

const request = (secret = 'secret') => new NextRequest('https://bubaly.example/api/contact-center/email', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-inbound-secret': secret },
  body: JSON.stringify({ to: 'ours@bubaly.com', from: 'School office <office@oak.example>', subject: 'Permission slip', text: 'Please sign and return.', messageId: 'message-1' }),
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CONTACT_CENTER_INBOUND_SECRET', 'secret');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ defaults: { paperwork_items: { updated_at: '2026-09-09T12:00:00Z' }, family_inbox_messages: { ai_handled: false } } });
  mocks.admin.mockReturnValue(db);
  mocks.concierge.mockResolvedValue({ intent: 'school', summary: 'Please sign', reply: 'Thank you', aiUsed: false });
  mocks.submit.mockResolvedValue({ ok: true, data: { requestId: 'request-1', runId: 'run-1', planId: null, outcome: 'plan', summary: 'Ready', redirect: null } });
  db.seed('families', [{ id: 'ours', name: 'Ours', timezone: 'UTC' }]);
  db.seed('family_contact_channels', [{ id: 'channel', family_id: 'ours', email_local: 'ours', ai_concierge_enabled: false }]);
  db.seed('family_facts', [{ id: 'school-contact', family_id: 'ours', category: 'contact', source: 'user', label: 'Oak School', value: 'office@oak.example', expires_at: null }]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('email retries complete saved entity enrichment', () => {
  it('still alerts the human fallback when urgent paperwork matching is unavailable', async () => {
    db.table('family_contact_channels')[0].forward_to_phone = '+15555550123';
    mocks.concierge.mockResolvedValue({ intent: 'urgent', summary: 'Urgent notice', reply: 'Thank you', aiUsed: false });
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table === 'family_ai_settings') throw new Error('offline');
      return from(table);
    }) as typeof db.from);
    expect((await POST(request())).status).toBe(503);
    expect(mocks.sendSms).toHaveBeenCalledWith('+15555550123', expect.stringContaining('Urgent notice'));
    expect((await POST(request())).status).toBe(503);
    expect(mocks.sendSms).toHaveBeenCalledOnce();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('returns 503 after capture, then enriches and plans once on redelivery, retaining the saved sender', async () => {
    const from = db.from.bind(db);
    const outage = vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table === 'family_ai_settings') throw new Error('offline');
      return from(table);
    }) as typeof db.from);
    expect((await POST(request())).status).toBe(503);
    expect(db.table('family_inbox_messages')).toHaveLength(1);
    expect(db.table('paperwork_items')).toHaveLength(1);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    const item = db.table('paperwork_items')[0];
    item.title = 'My own title';
    outage.mockRestore();
    expect((await POST(request())).status).toBe(200);
    expect(db.table('paperwork_items')).toHaveLength(1);
    expect(db.table('paperwork_items')[0]).toMatchObject({
      title: 'My own title', sender: 'School office <office@oak.example>',
      meta: { entity_matches: [{ key: 'family_facts:school-contact', label: 'Oak School', matchedBy: 'sender' }], entity_resolution: { status: 'complete' } },
    });
    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(db.table('family_inbox_messages')[0].ai_handled).toBe(true);
    expect((await POST(request())).status).toBe(200);
    expect(mocks.submit).toHaveBeenCalledOnce();
  });

  it('returns retryable status when a duplicate delivery handled-state read fails', async () => {
    expect((await POST(request())).status).toBe(200);
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = from(table);
      const select = query.select.bind(query);
      query.select = ((...args: Parameters<typeof query.select>) => {
        const columns = args[0];
        if (table === 'family_inbox_messages' && columns === 'ai_handled') throw new Error('offline');
        return select(...args);
      }) as typeof query.select;
      return query;
    }) as typeof db.from);
    // A synchronous builder failure is also a failed required read.
    expect((await POST(request())).status).toBe(503);
  });

  it('rejects an unauthenticated webhook before any household reads', async () => {
    expect((await POST(request('wrong'))).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});
