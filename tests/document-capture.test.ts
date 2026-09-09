import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { POST } from '@/app/api/paperwork/capture/route';
import { captureDocument, capturedDocumentId } from '@/lib/services/paperwork/capture';
import { uploadCapturedDocument, CAPTURE_DOCUMENT_BYTES } from '@/lib/capture/document-upload';
import { MAX_DOCUMENT_BYTES } from '@/lib/ai/document-text';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({ db: null as unknown, provider: null as unknown, signedIn: true, familyId: 'family-1', userId: 'parent-1', stepUp: false }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => {
  if (!state.signedIn) throw new Error('Signed out');
  return { user: { id: state.userId }, active: { familyId: state.familyId, member: { id: 'member-1' }, family: { timezone: 'UTC' }, role: 'parent' } };
} }));
vi.mock('@/lib/auth/require-aal2', () => ({ aal2Verdict: async () => state.stepUp ? { action: 'step_up', to: '/auth/step-up?next=%2Fdashboard%2Fpaperwork' } : { action: 'allow' } }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/routing', () => ({ resolveProviderForTask: async () => state.provider }));
type DB = SupabaseClient<Database>;
const captureId = '10000000-0000-4000-8000-000000000001';
const text = 'Field trip permission slip. Sign and return by October 15, 2026.';
const file = () => new File(['%PDF-1.7\nDocument'], 'school.pdf', { type: 'application/pdf' });
let db: ReturnType<typeof createInMemorySupabase<DB>>;
let transcribe: ReturnType<typeof vi.fn>;
let scope: ServiceScope;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.signedIn = true;
  state.familyId = 'family-1'; state.userId = 'parent-1'; state.stepUp = false;
  db = createInMemorySupabase<DB>({ uniques: { paperwork_items: [['id']] } });
  state.db = db;
  transcribe = vi.fn(async () => ({ text: JSON.stringify({ text, truncated: false }) }));
  state.provider = { structuredCompletion: transcribe };
  scope = { db, familyId: 'family-1', userId: 'parent-1', memberId: 'member-1', role: 'parent', actorKind: 'member', tz: 'UTC' };
});
function failRead(table: string) {
  const original = db.from.bind(db);
  let failed = false;
  vi.spyOn(db, 'from').mockImplementation(((name: string) => {
    if (name !== table || failed) return original(name);
    failed = true;
    const promise = Promise.resolve({ data: null, error: { message: 'Unavailable' } });
    const proxy = new Proxy({}, { get: (_target, key) => key === 'then' ? promise.then.bind(promise) : () => proxy });
    return proxy;
  }) as typeof db.from);
}
async function request(body: FormData | { captureId: string }) {
  return POST(new NextRequest('http://localhost/api/paperwork/capture', {
    method: 'POST', body: body instanceof FormData ? body : JSON.stringify({ ...body, expectedFamilyId: 'family-1', expectedUserId: 'parent-1' }),
    headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
  }));
}
function form() { const body = new FormData(); body.set('captureId', captureId); body.set('file', file()); body.set('sender', 'School'); body.set('expectedFamilyId', 'family-1'); body.set('expectedUserId', 'parent-1'); return body; }

describe('document capture receipts', () => {
  it('files explicit uploads with bounded text, creator and provenance, including unclassified documents', async () => {
    expect(CAPTURE_DOCUMENT_BYTES).toBe(MAX_DOCUMENT_BYTES);
    transcribe.mockResolvedValue({ text: JSON.stringify({ text: 'My household document', truncated: false }) });
    expect(await captureDocument(scope, { captureId, file: file(), sender: 'School' })).toMatchObject({ ok: true });
    expect(db.table('paperwork_items')[0]).toMatchObject({ family_id: scope.familyId, created_by: scope.userId,
      kind: 'other', raw_text: 'My household document', sender: 'School', status: 'needs_action',
      meta: { source: 'capture_upload', capture_id: captureId, filename: 'school.pdf', extraction: { truncated: false }, entity_resolution: { status: 'complete' } } });
    expect(db.table('family_inbox_messages')).toHaveLength(0);
    expect(db.table('calendar_events')).toHaveLength(0);
  });

  it('retries enrichment from saved text without upload or OCR and preserves user edits', async () => {
    failRead('graph_entities');
    const initial = await request(form());
    expect(initial.status).toBe(503);
    expect(await initial.json()).toMatchObject({ ok: false, saved: true, retryable: true });
    db.table('paperwork_items')[0].title = 'My edited title';
    db.table('paperwork_items')[0].status = 'in_progress';
    const resumed = await request({ captureId });
    expect(resumed.status).toBe(200);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(db.table('paperwork_items')).toHaveLength(1);
    expect(db.table('paperwork_items')[0]).toMatchObject({ title: 'My edited title', status: 'in_progress', raw_text: text });
  });

  it('distinguishes a missing receipt from a read outage and fails before paid extraction', async () => {
    expect((await request({ captureId })).status).toBe(404);
    failRead('paperwork_items');
    expect((await request(form())).status).toBe(503);
    expect(transcribe).not.toHaveBeenCalled();
    expect(db.table('paperwork_items')).toHaveLength(0);
  });

  it('binds retry receipts to the family, creator, source and exact uploaded bytes', async () => {
    await captureDocument(scope, { captureId, file: file() });
    expect(await captureDocument({ ...scope, familyId: 'other-family' }, { captureId })).toMatchObject({ ok: false, reason: 'needs_file' });
    expect(await captureDocument({ ...scope, userId: 'other-user' }, { captureId })).toMatchObject({ ok: false, reason: 'needs_file' });
    expect(await captureDocument(scope, { captureId, file: new File(['%PDF-1.7\nChanged'], 'other.pdf', { type: 'application/pdf' }) })).toMatchObject({ ok: false });
    db.table('paperwork_items')[0].meta = { source: 'inbound_email' };
    expect(await captureDocument(scope, { captureId })).toMatchObject({ ok: false });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(capturedDocumentId(scope.familyId, scope.userId!, captureId)).not.toBe(capturedDocumentId('other-family', scope.userId!, captureId));
  });

  it('files partial extractions as reviewable paperwork and retains the warning on resume', async () => {
    transcribe.mockResolvedValue({ text: JSON.stringify({ text, truncated: true }) });
    const first = await captureDocument(scope, { captureId, file: file() });
    expect(first).toMatchObject({ ok: true, data: { partial: true } });
    expect(await captureDocument(scope, { captureId })).toMatchObject({ ok: true, data: { partial: true } });
    expect(db.table('paperwork_items')[0]).toMatchObject({ status: 'needs_action', meta: { extraction: { truncated: true } } });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it.each(['failure', 'missing', 'malformed'] as const)('makes %s provider output retryable instead of saved success', async (kind) => {
    if (kind === 'failure') transcribe.mockRejectedValue(new Error('Provider timeout'));
    else if (kind === 'missing') state.provider = null;
    else transcribe.mockResolvedValue({ text: '{}' });
    expect(await captureDocument(scope, { captureId, file: file() })).toEqual({ ok: false, reason: 'provider_unavailable', retryable: true });
    expect(db.table('paperwork_items')).toHaveLength(0);
  });

  it('rejects an empty document, bad signature, archive, or oversize upload without an apparent saved result', async () => {
    transcribe.mockResolvedValue({ text: JSON.stringify({ text: '', truncated: false }) });
    expect(await captureDocument(scope, { captureId, file: file() })).toMatchObject({ ok: false, reason: 'empty_document', retryable: false });
    for (const invalid of [new File(['wrong'], 'bad.pdf', { type: 'application/pdf' }), new File(['PK'], 'files.zip', { type: 'application/pdf' })]) {
      expect(await captureDocument(scope, { captureId, file: invalid })).toMatchObject({ ok: false, reason: 'unsupported' });
    }
    expect(await captureDocument(scope, { captureId, file: new File([new Uint8Array(MAX_DOCUMENT_BYTES + 1)], 'big.txt', { type: 'text/plain' }) })).toMatchObject({ ok: false, reason: 'too_large' });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(db.table('paperwork_items')).toHaveLength(0);
  });

  it('requires a signed-in session before processing a file', async () => {
    state.signedIn = false;
    expect((await request(form())).status).toBe(401);
    expect(db.log).toHaveLength(0);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it.each(['familyId', 'userId'] as const)('rejects a changed %s on both receipt and upload phases before any record access', async (key) => {
    state[key] = 'other';
    for (const body of [{ captureId }, form()]) {
      const response = await request(body);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason: 'context_changed', retryable: false });
    }
    expect(db.log).toHaveLength(0);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('requires document step-up before receipt or upload work and returns a usable verification link', async () => {
    state.stepUp = true;
    for (const body of [{ captureId }, form()]) {
      const response = await request(body);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ reason: 'step_up', stepUp: '/auth/step-up?next=%2Fdashboard%2Fpaperwork', retryable: false });
    }
    expect(db.log).toHaveLength(0);
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe('selected-file retry transport', () => {
  const identity = { familyId: 'family-1', userId: 'parent-1' };
  const probeBody = JSON.stringify({ captureId, expectedFamilyId: 'family-1', expectedUserId: 'parent-1' });
  const saved = { ok: true, data: { id: '20000000-0000-4000-8000-000000000001', partial: false } };
  it('probes first and uploads only when the server proves there is no saved extraction', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: false, reason: 'needs_file', retryable: false }, { status: 404 })).mockResolvedValueOnce(Response.json(saved));
    expect(await uploadCapturedDocument({ captureId, file: file(), sender: 'School', ...identity }, send)).toEqual(saved);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][1]?.body).toBe(probeBody);
    expect(send.mock.calls[1][1]?.body).toBeInstanceOf(FormData);
  });
  it('recovers a lost response with a JSON-only receipt check on retry', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(saved));
    expect(await uploadCapturedDocument({ captureId, file: file(), sender: '', ...identity }, send)).toEqual(saved);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]?.body).toBe(probeBody);
  });
  it('never uploads over a receipt read error or malformed response', async () => {
    for (const response of [Response.json({ ok: false, reason: 'unavailable', retryable: true }, { status: 503 }), Response.json({})]) {
      const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
      expect(await uploadCapturedDocument({ captureId, file: file(), sender: '', ...identity }, send)).toMatchObject({ ok: false, reason: 'unavailable', retryable: true });
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses the second phase after the active household switches between actual HTTP handlers', async () => {
    let calls = 0;
    const send: typeof fetch = async (_url, init) => {
      const response = await POST(new NextRequest('http://localhost/api/paperwork/capture', { ...init, signal: init?.signal ?? undefined }));
      if (++calls === 1) state.familyId = 'family-2';
      return response;
    };
    expect(await uploadCapturedDocument({ captureId, file: file(), sender: '', ...identity }, send)).toMatchObject({ ok: false, reason: 'context_changed' });
    expect(calls).toBe(2);
    expect(db.table('paperwork_items')).toHaveLength(0);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('skips upload when a delayed probe returns after the UI context was invalidated', async () => {
    let current = true;
    let resolve: (value: Response) => void = () => {};
    const send = vi.fn<typeof fetch>().mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = uploadCapturedDocument({ captureId, file: file(), sender: '', ...identity, isCurrent: () => current }, send);
    current = false;
    resolve(Response.json({ ok: false, reason: 'needs_file', retryable: false }, { status: 404 }));
    expect(await pending).toMatchObject({ ok: false, reason: 'context_changed' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
