import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { captureDocumentLink, linkedDocumentId } from '@/lib/services/paperwork/link';
import { POST } from '@/app/api/paperwork/link/route';
import { importDocumentLink } from '@/lib/capture/document-link';

const state = vi.hoisted(() => ({ db: null as unknown, fetch: vi.fn(), signedIn: true, stepUp: false,
  familyId: 'family-1', userId: 'parent-1', access: vi.fn(), limited: false }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => {
  if (!state.signedIn) throw new Error('Signed out');
  return { user: { id: state.userId }, active: { familyId: state.familyId, role: 'parent', member: { id: 'member-1' }, family: { timezone: 'UTC' } } };
} }));
vi.mock('@/lib/auth/require-aal2', () => ({ aal2Verdict: async () => state.stepUp ? { action: 'step_up', to: '/auth/step-up?next=%2Fcapture%2Flink' } : { action: 'allow' } }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: !state.limited }) }));
vi.mock('@/lib/services/paperwork/link-access', () => ({ authorizeDocumentLink: state.access }));
vi.mock('@/lib/server/public-document-fetch', async (original) => ({ ...await original<typeof import('@/lib/server/public-document-fetch')>(), fetchPublicDocument: state.fetch }));
vi.mock('@/lib/ai/routing', () => ({ resolveProviderForTask: () => { throw new Error('Plain text must not use provider'); } }));

type DB = SupabaseClient<Database>;
const captureId = '10000000-0000-4000-8000-000000000001';
const messageId = '20000000-0000-4000-8000-000000000001';
const url = 'https://docs.school.org/form.txt?token=secret';
const input = { captureId, url };
const body = 'School permission slip. Sign and return by October 15, 2026.';
const document = () => ({ name: 'form.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode(body), url });
let db: ReturnType<typeof createInMemorySupabase<DB>>;
let scope: ServiceScope;
beforeEach(() => {
  vi.restoreAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<DB>({ uniques: { paperwork_items: [['id']] } }); state.db = db;
  state.signedIn = true; state.stepUp = false; state.limited = false; state.familyId = 'family-1'; state.userId = 'parent-1';
  state.access.mockReset().mockResolvedValue({ ok: true });
  state.fetch.mockReset().mockResolvedValue(document());
  scope = { db, familyId: 'family-1', userId: 'parent-1', memberId: 'member-1', role: 'parent', actorKind: 'member', tz: 'UTC' };
  db.table('family_inbox_messages').push({ id: messageId, family_id: 'family-1', channel: 'email', direction: 'inbound', body: `Document: ${url}`, from_addr: 'School', provider_ref: 'provider-message-1' });
});
function failRead(table: string) {
  const original = db.from.bind(db); let failed = false;
  vi.spyOn(db, 'from').mockImplementation(((name: string) => {
    if (name !== table || failed) return original(name);
    failed = true;
    const promise = Promise.resolve({ data: null, error: { message: 'Unavailable' } });
    const proxy = new Proxy({}, { get: (_target, key) => key === 'then' ? promise.then.bind(promise) : () => proxy });
    return proxy;
  }) as typeof db.from);
}
async function request(extra: Record<string, unknown> = {}) {
  return POST(new NextRequest('https://bubaly.test/api/paperwork/link', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, expectedFamilyId: 'family-1', expectedUserId: 'parent-1', ...extra }) }));
}

describe('linked-document saved text identity', () => {
  it('files reviewable source text and provenance without executing actions or following its links', async () => {
    expect(await captureDocumentLink(scope, { ...input, messageId })).toMatchObject({ ok: true });
    expect(db.table('paperwork_items')[0]).toMatchObject({ family_id: 'family-1', created_by: 'parent-1', raw_text: body, sender: 'School', status: 'needs_action',
      meta: { source: 'document_link', source_message_id: messageId, provider_ref: 'provider-message-1', original_url: url, final_url: url, extraction: { truncated: false }, entity_resolution: { status: 'complete' } } });
    expect(db.table('calendar_events')).toHaveLength(0);
    expect(db.table('ai_requests')).toHaveLength(0);
    expect(db.table('family_inbox_messages')[0]).not.toHaveProperty('ai_handled');
  });
  it('repairs saved enrichment without another DNS/HTTP/OCR read and preserves user edits', async () => {
    failRead('graph_entities');
    const initial = await request();
    expect(initial.status).toBe(503);
    expect(await initial.json()).toMatchObject({ saved: true, retryable: true });
    Object.assign(db.table('paperwork_items')[0], { title: 'My title', raw_text: 'User corrected text', status: 'in_progress' });
    state.fetch.mockRejectedValue(new Error('Remote URL expired'));
    expect((await request()).status).toBe(200);
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(db.table('paperwork_items')).toHaveLength(1);
    expect(db.table('paperwork_items')[0]).toMatchObject({ title: 'My title', raw_text: 'User corrected text', status: 'in_progress' });
  });
  it('dedupes selected inbound links across users and fresh capture IDs using the immutable source URL', async () => {
    const first = await captureDocumentLink(scope, { ...input, messageId });
    const second = await captureDocumentLink({ ...scope, userId: 'other-member' }, { ...input, captureId: '30000000-0000-4000-8000-000000000001', messageId });
    expect(second).toEqual(first);
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(db.table('paperwork_items')[0].created_by).toBe('parent-1');
  });
  it('keeps manual identities distinct by caller/family while preserving original query ordering', () => {
    const id = linkedDocumentId('family-1', `capture:parent-1:${captureId}`, url);
    expect(id).not.toBe(linkedDocumentId('family-2', `capture:parent-1:${captureId}`, url));
    expect(id).not.toBe(linkedDocumentId('family-1', `capture:parent-2:${captureId}`, url));
    expect(id).not.toBe(linkedDocumentId('family-1', `capture:parent-1:${captureId}`, `${url}&a=1`));
  });
  it('accepts the first verified snapshot in a concurrent conflict even when the remote content changes', async () => {
    let release: (value: ReturnType<typeof document>) => void = () => {};
    state.fetch.mockImplementationOnce(() => new Promise((done) => { release = done; })).mockResolvedValueOnce({ ...document(), bytes: new TextEncoder().encode('New remote contents') });
    const slow = captureDocumentLink(scope, { ...input, messageId });
    await vi.waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(1));
    const winner = await captureDocumentLink(scope, { ...input, messageId });
    release(document());
    expect(await slow).toEqual(winner);
    expect(db.table('paperwork_items')).toHaveLength(1);
    expect(db.table('paperwork_items')[0].raw_text).toBe('New remote contents');
  });
  it.each(['family_inbox_messages', 'paperwork_items'])('stops on a failed %s read before any network request', async (table) => {
    failRead(table);
    expect(await captureDocumentLink(scope, { ...input, messageId })).toMatchObject({ ok: false, retryable: true });
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it.each([{ family_id: 'other' }, { direction: 'outbound' }, { channel: 'sms' }, { body: 'No selected URL here' }])('rejects inaccessible or forged source evidence %#', async (change) => {
    Object.assign(db.table('family_inbox_messages')[0], change);
    expect(await captureDocumentLink(scope, { ...input, messageId })).toMatchObject({ ok: false, reason: 'source_unavailable' });
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it('rejects a mismatched durable receipt without refetching or overwriting', async () => {
    await captureDocumentLink(scope, input);
    (db.table('paperwork_items')[0].meta as Record<string, unknown>).original_url = 'https://evil.org/a';
    expect(await captureDocumentLink(scope, input)).toMatchObject({ ok: false, retryable: true });
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves partial extraction review state on saved retries without endless length-limit errors', async () => {
    state.fetch.mockResolvedValue({ ...document(), bytes: new TextEncoder().encode('a'.repeat(20_001)) });
    expect(await captureDocumentLink(scope, input)).toMatchObject({ ok: true, data: { partial: true } });
    expect(await captureDocumentLink(scope, input)).toMatchObject({ ok: true, data: { partial: true } });
    expect(db.table('paperwork_items')[0]).toMatchObject({ status: 'needs_action', meta: { extraction: { truncated: true } } });
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });
  it('requires unchanged authorization after a slow fetch before persisting', async () => {
    state.access.mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false, reason: 'context_changed', retryable: false });
    const result = await request();
    expect(result.status).toBe(409);
    expect(db.table('paperwork_items')).toHaveLength(0);
  });
});

describe('linked-document route boundary', () => {
  it.each(['familyId', 'userId'] as const)('rejects changed %s before reads/fetch', async (key) => {
    state[key] = 'other';
    expect((await request()).status).toBe(409);
    expect(state.access).not.toHaveBeenCalled(); expect(state.fetch).not.toHaveBeenCalled();
  });
  it('requires sign-in and documents MFA before body/source/receipt access', async () => {
    state.signedIn = false; expect((await request()).status).toBe(401);
    state.signedIn = true; state.stepUp = true;
    const response = await request({ messageId });
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ reason: 'step_up', stepUp: '/auth/step-up?next=%2Fcapture%2Flink' });
    expect(db.log).toHaveLength(0); expect(state.fetch).not.toHaveBeenCalled(); expect(state.access).not.toHaveBeenCalled();
  });
  it('applies source feature access on import and every saved retry', async () => {
    expect((await request({ messageId })).status).toBe(200);
    state.access.mockResolvedValue({ ok: false, reason: 'access_denied', retryable: false });
    expect((await request({ messageId })).status).toBe(403);
    expect(state.access.mock.calls[0][2]).toBe(true);
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });
  it('fails closed on unknown feature access and on rate limits before fetching', async () => {
    state.access.mockResolvedValue({ ok: false, reason: 'unavailable', retryable: true });
    expect((await request({ messageId })).status).toBe(503);
    state.access.mockResolvedValue({ ok: true }); state.limited = true;
    expect((await request()).status).toBe(429);
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it('sends only an explicit bounded request with ownership, signal and stable identity', async () => {
    const signal = new AbortController().signal;
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: false, reason: 'unsupported', retryable: false }));
    expect(await importDocumentLink({ ...input, familyId: 'family-1', userId: 'parent-1' }, signal, send)).toMatchObject({ reason: 'unsupported' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0][1]?.body as string)).toMatchObject({ ...input, expectedFamilyId: 'family-1', expectedUserId: 'parent-1' });
    expect(send.mock.calls[0][1]?.signal).toBe(signal);
  });
});
