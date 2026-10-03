import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceScope } from '@/lib/services/types';
import type { AIProvider } from '@/lib/ai/provider';
import type { DocumentInput, DocumentTextResult } from '@/lib/ai/document-text';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

// §33 / F19. Filing a document (upload, link, emailed attachment) reads it
// with a vision model and recorded nothing. `transcribeDocument` opens a row
// for every transcription that reaches a model — recorded, not charged
// (`metered = false`, never refused) until the owner classifies it — and none
// for a file the model never sees.

const FAMILY = 'fam-1';
const state = vi.hoisted(() => ({ planLevel: 0 }));
let store: InMemorySupabase;
const db = { from: (t: string) => store.from(t), rpc: async () => ({ data: null, error: { message: 'no rpc' } }) };

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => db, createServiceClient: () => db }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => state.planLevel }));
vi.mock('@/lib/ai/usage', () => ({ recordModelCall: async () => {} }));

const { transcribeDocument } = await import('@/lib/ai/observed-document-text');

const member = (): ServiceScope => ({
  db: db as unknown as ServiceScope['db'],
  familyId: FAMILY, userId: 'user-1', memberId: 'member-1', role: 'parent', actorKind: 'member', tz: 'UTC',
});
const system = (): ServiceScope => ({
  db: db as unknown as ServiceScope['db'],
  familyId: FAMILY, userId: null, memberId: null, role: 'system', actorKind: 'system', tz: 'UTC',
});
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const image: DocumentInput = { name: 'bill.png', mediaType: 'image/png', bytes: PNG };
const text: DocumentInput = { name: 'note.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('Water bill due Friday') };
const provider = vi.fn(async () => ({ model: 'vision-model' }) as unknown as AIProvider);
/** Stands in for the model call: it asks for the provider, as the real extractor does. */
function extractor(result: DocumentTextResult) {
  return vi.fn(async (_input: DocumentInput, engine: (s?: AbortSignal) => Promise<AIProvider>) => {
    await engine();
    return result;
  });
}
const rows = () => store.table('ai_requests').filter((r: Row) => r.family_id === FAMILY);

beforeEach(() => {
  store = createInMemorySupabase({ userId: 'user-1' });
  state.planLevel = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('paperwork transcription is recorded, not charged', () => {
  it('an uploaded image opens one exempt row, settled completed, naming the surface', async () => {
    const extract = extractor({ ok: true, text: 'Water bill', truncated: false, method: 'multimodal' });
    const result = await transcribeDocument(member(), 'upload', image, { extract, provider });
    expect(result.ok).toBe(true);
    expect(rows()).toEqual([expect.objectContaining({ feature: 'paperwork.transcribe.upload', request_text: 'Transcribe a document', metered: false, status: 'completed' })]);
  });

  it('at 10 of 10 on Free, a member\'s upload is still transcribed (never refused) and does not count', async () => {
    store.seed('ai_requests', Array.from({ length: 10 }, (_, i) => ({ family_id: FAMILY, kind: 'feature', feature: 'notes.summary', status: 'completed', request_text: `paid ${i}` })));
    const extract = extractor({ ok: true, text: 'Water bill', truncated: false, method: 'multimodal' });
    expect((await transcribeDocument(member(), 'link', image, { extract, provider })).ok).toBe(true);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(rows().filter((r: Row) => r.metered === true)).toHaveLength(10);
    expect(rows().at(-1)).toMatchObject({ feature: 'paperwork.transcribe.link', metered: false });
  });

  it('a transcription the model could not do settles the row failed', async () => {
    const extract = extractor({ ok: false, reason: 'provider_unavailable', retryable: true });
    await transcribeDocument(member(), 'upload', image, { extract, provider });
    expect(rows()).toEqual([expect.objectContaining({ status: 'failed', metered: false })]);
    expect(String(rows()[0].error)).toContain('provider_unavailable');
  });

  it('an emailed attachment (system scope) is recorded and unmetered', async () => {
    const extract = extractor({ ok: true, text: 'Invoice', truncated: false, method: 'multimodal' });
    await transcribeDocument(system(), 'email', image, { extract, provider });
    expect(rows()).toEqual([expect.objectContaining({ feature: 'paperwork.transcribe.email', metered: false })]);
  });

  it('control: a plain-text file never reaches a model and opens no row', async () => {
    const extract = vi.fn(async () => ({ ok: true, text: 'Water bill due Friday', truncated: false, method: 'plain_text' }) as DocumentTextResult);
    await transcribeDocument(member(), 'upload', text, { extract, provider });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(0);
  });

  it('control: an unsupported or empty file opens no row', async () => {
    const extract = vi.fn(async () => ({ ok: false, reason: 'unsupported', retryable: false }) as DocumentTextResult);
    await transcribeDocument(member(), 'upload', { name: 'a.zip', mediaType: 'application/zip', bytes: new Uint8Array([1, 2]) }, { extract, provider });
    await transcribeDocument(member(), 'upload', { name: 'b.png', mediaType: 'image/png', bytes: new Uint8Array() }, { extract, provider });
    expect(rows()).toHaveLength(0);
  });
});
