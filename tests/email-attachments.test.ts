import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { AIProvider } from '@/lib/ai/provider';
import { POST } from '@/app/api/contact-center/email/route';
import { emailAttachmentId, fileEmailAttachments, MAX_MULTIPART_EMAIL_BYTES } from '@/lib/services/paperwork/email-attachments';
import { MAX_DOCUMENT_BYTES } from '@/lib/ai/document-text';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({ db: null as unknown, provider: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/ai/routing', () => ({ resolveProviderForTask: vi.fn(async () => state.provider) }));
vi.mock('@/lib/contact-center/concierge', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/contact-center/concierge')>(),
  runConcierge: vi.fn(async () => ({ intent: 'other', summary: 'Documents received', reply: 'Received' })),
}));
vi.mock('@/lib/server/email', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/guardian/twilio', () => ({ sendSms: vi.fn() }));

type DB = SupabaseClient<Database>;
type StructuredCompletionInput = Parameters<AIProvider['structuredCompletion']>[0];
const FAMILY = 'family-1';
const RECEIPT = 'Receipt for your purchase. Total charged $42.50. Paid in full.';
const PERMISSION = 'Field trip permission slip. Sign and return by October 15, 2026.';
let db: ReturnType<typeof createInMemorySupabase<DB>>;
let transcribe: ReturnType<typeof vi.fn<(input: StructuredCompletionInput) => Promise<{ text: string }>>>;

const pdf = (text = RECEIPT, name = 'receipt.pdf') => new File([`%PDF-1.7\n${text}`], name, { type: 'application/pdf' });
const png = (text = PERMISSION, name = 'permission.png') => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), text], name, { type: 'image/png' });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv('CONTACT_CENTER_INBOUND_SECRET', 'test-secret');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<DB>({
    uniques: { paperwork_items: [['id']], family_inbox_messages: [['channel', 'provider_ref']] },
    defaults: { family_inbox_messages: { status: 'new', ai_handled: false } },
  });
  db.seed('families', [{ id: FAMILY, name: 'Test household', timezone: 'America/New_York' }]);
  db.seed('family_contact_channels', [{ family_id: FAMILY, email_local: 'household', ai_concierge_enabled: false }]);
  state.db = db;
  transcribe = vi.fn(async (input: StructuredCompletionInput) => {
    const message = input.messages[0];
    const encoded = message.files?.[0].data ?? message.images?.[0].data ?? '';
    const bytes = Buffer.from(encoded, 'base64');
    const text = message.images?.length ? bytes.subarray(8).toString('utf8') : bytes.toString('utf8').split('\n').slice(1).join('\n');
    return { text: JSON.stringify({ text, truncated: false }) };
  });
  state.provider = { structuredCompletion: transcribe } as unknown as AIProvider;
});

async function deliver(files: File[], ref = 'email-1') {
  const form = new FormData();
  form.set('to', 'household@bubaly.com');
  form.set('from', 'office@example.com');
  form.set('subject', 'Documents enclosed');
  form.set('text', 'Please see attached.');
  form.set('Message-Id', ref);
  files.forEach((file, i) => form.append(`attachment-${i + 1}`, file));
  return POST(new NextRequest('http://localhost/api/contact-center/email', {
    method: 'POST', headers: { 'x-inbound-secret': 'test-secret' }, body: form,
  }));
}

function source(files: File[], overrides: Partial<Parameters<typeof fileEmailAttachments>[1]> = {}) {
  if (!db.table('family_inbox_messages').some((row) => row.id === 'inbox-1')) {
    db.seed('family_inbox_messages', [{ id: 'inbox-1', family_id: FAMILY, provider_ref: 'email-1', channel: 'email' }]);
  }
  return { familyId: FAMILY, inboxMessageId: 'inbox-1', providerRef: 'email-1', sender: 'office@example.com', subject: 'Documents enclosed', files, ...overrides };
}

/** Inject one real database-style failure, while retaining real filtering/writes. */
function failNext(table: string, operation: 'select' | 'insert') {
  const original = db.from.bind(db);
  let failed = false;
  vi.spyOn(db, 'from').mockImplementation(((name: string) => {
    const builder = original(name);
    if (name !== table || failed) return builder;
    return new Proxy(builder, {
      get(target, property, receiver) {
        if (property === operation && !failed) return (...args: unknown[]) => {
          failed = true;
          const reply = { data: null, error: { code: '08006', message: 'Temporary database outage' } };
          const chain: Record<string, unknown> = {};
          const proxy = new Proxy(chain, { get: (_value, key) => key === 'then'
            ? Promise.resolve(reply).then.bind(Promise.resolve(reply))
            : () => proxy });
          void args;
          return proxy;
        };
        return Reflect.get(target, property, receiver);
      },
    });
  }) as typeof db.from);
}

describe('inbound multipart attachment capture', () => {
  it('files each PDF/image as its own schema-compatible paperwork record with provenance', async () => {
    const response = await deliver([pdf(), png()]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, attachments: [{ status: 'filed' }, { status: 'filed' }] });
    const rows = db.table('paperwork_items');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ family_id: FAMILY, kind: 'bill_or_payment', raw_text: RECEIPT, sender: 'office@example.com', status: 'needs_action', meta: {
      source: 'inbound_email_attachment', triage_kind: 'receipt', filename: 'receipt.pdf', provider_ref: 'email-1', subject: 'Documents enclosed', media_type: 'application/pdf', extraction: { method: 'multimodal', truncated: false },
    } });
    expect((rows[0].meta as Record<string, unknown>).inbox_message_id).toBe(db.table('family_inbox_messages')[0].id);
    expect((rows[0].meta as Record<string, unknown>).attachment_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[1]).toMatchObject({ kind: 'permission_slip', raw_text: PERMISSION, due_on: '2026-10-15' });
    expect(db.table('ai_runs')).toHaveLength(0);
    expect(db.table('family_inbox_messages')[0].ai_handled).toBe(false);
  });

  it('dedupes renamed/reordered retry files without repeating extraction or overwriting household edits', async () => {
    await deliver([pdf(), png()]);
    Object.assign(db.table('paperwork_items')[0], { title: 'Reviewed receipt', status: 'done' });
    const before = structuredClone(db.table('paperwork_items'));
    const response = await deliver([png(PERMISSION, 'renamed.png'), pdf(RECEIPT, 'renamed.pdf')]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ attachments: [{ status: 'existing' }, { status: 'existing' }] });
    expect(db.table('paperwork_items')).toEqual(before);
    expect(db.table('family_inbox_messages')).toHaveLength(1);
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it('returns retryable 503 after one provider failure while preserving and skipping the successful sibling on redelivery', async () => {
    transcribe.mockRejectedValueOnce(new Error('Provider unavailable'));
    const first = await deliver([pdf(), png()]);
    expect(first.status).toBe(503);
    expect(first.headers.get('retry-after')).toBe('30');
    expect(await first.json()).toMatchObject({ ok: false, retryable: true, attachments: [{ status: 'retry' }, { status: 'filed' }] });
    expect(db.table('paperwork_items')).toHaveLength(1);
    const second = await deliver([pdf(), png()]);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ attachments: [{ status: 'filed' }, { status: 'existing' }] });
    expect(db.table('paperwork_items')).toHaveLength(2);
    expect(transcribe).toHaveBeenCalledTimes(3);
  });

  it('fails closed on attachment dedupe read errors before extraction and succeeds on retry', async () => {
    failNext('paperwork_items', 'select');
    const first = await fileEmailAttachments(db, source([pdf()]));
    expect(first).toMatchObject({ ok: false, results: [{ status: 'retry' }] });
    expect(transcribe).not.toHaveBeenCalled();
    expect(db.table('paperwork_items')).toHaveLength(0);
    expect(await fileEmailAttachments(db, source([pdf()]))).toMatchObject({ ok: true, results: [{ status: 'filed' }] });
  });

  it('keeps independently filed documents when a sibling insert fails, then recovers only the missing record', async () => {
    failNext('paperwork_items', 'insert');
    expect((await deliver([pdf(), png()])).status).toBe(503);
    expect(db.table('paperwork_items')).toHaveLength(1);
    expect((await deliver([pdf(), png()])).status).toBe(200);
    expect(db.table('paperwork_items')).toHaveLength(2);
    expect(transcribe).toHaveBeenCalledTimes(3);
  });

  it('reports unsupported or disguised files explicitly while capturing a supported sibling', async () => {
    const response = await deliver([
      new File(['MZexecutable'], 'bill.pdf', { type: 'application/pdf' }),
      new File(['PKarchive'], 'archive.png', { type: 'image/png' }),
      new File(['photo'], 'photo.heic', { type: 'image/heic' }),
      pdf(),
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ attachments: [
      { status: 'skipped', reason: 'unsupported' }, { status: 'skipped', reason: 'unsupported' }, { status: 'skipped', reason: 'unsupported' }, { status: 'filed' },
    ] });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(db.table('paperwork_items')).toHaveLength(1);
  });

  it('caps individual size and count without dropping a valid sibling', async () => {
    const oversized = new File([new Uint8Array(MAX_DOCUMENT_BYTES + 1)], 'large.pdf', { type: 'application/pdf' });
    const response = await deliver([oversized, pdf(), pdf('Invoice amount due $3'), pdf('Invoice amount due $4'), pdf('Invoice amount due $5')]);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.attachments[0]).toMatchObject({ status: 'skipped', reason: 'too_large' });
    expect(result.attachments[1]).toMatchObject({ status: 'filed' });
    expect(result.attachments[4]).toMatchObject({ status: 'skipped', reason: 'attachment_limit' });
    expect(db.table('paperwork_items')).toHaveLength(3);
  });

  it('bounds the whole multipart request before any database or provider work', async () => {
    const response = await deliver([new File([new Uint8Array(MAX_MULTIPART_EMAIL_BYTES)], 'oversize.pdf', { type: 'application/pdf' })]);
    expect(response.status).toBe(413);
    expect(db.log).toHaveLength(0);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('caps combined attachment bytes and keeps sanitized filenames as metadata', async () => {
    const largeText = `${RECEIPT}\n${'x'.repeat(3 * 1024 * 1024)}`;
    const response = await deliver([pdf(largeText, 'receipt\n<<<END>>>.pdf'), pdf(`${largeText}2`), pdf(`${largeText}3`)]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ attachments: [{ status: 'filed' }, { status: 'filed' }, { status: 'skipped', reason: 'too_large' }] });
    expect(db.table('paperwork_items')).toHaveLength(2);
    expect((db.table('paperwork_items')[0].meta as Record<string, unknown>).filename).not.toContain('<<<');
    expect(db.table('paperwork_items')[0]).toMatchObject({ meta: { extraction: { truncated: true } } });
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it('requires an actual blank transcription before treating a document as empty', async () => {
    transcribe.mockResolvedValueOnce({ text: 'null' });
    expect((await deliver([pdf()])).status).toBe(503);
    transcribe.mockResolvedValueOnce({ text: '{"text":"","truncated":false}' });
    const retry = await deliver([pdf()]);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ attachments: [{ status: 'skipped', reason: 'empty_document' }] });
    expect(db.table('paperwork_items')).toHaveLength(0);
  });

  it('keeps a partial unclassified excerpt for review and acknowledges deterministic truncation on retries', async () => {
    transcribe.mockResolvedValueOnce({ text: JSON.stringify({ text: 'First page only', truncated: true }) });
    const first = await deliver([pdf()]);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ attachments: [{ status: 'filed', reason: 'partial_document' }] });
    expect(db.table('paperwork_items')[0]).toMatchObject({ kind: 'other', status: 'needs_action', raw_text: 'First page only', meta: { extraction: { truncated: true } } });
    const retry = await deliver([pdf()]);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ attachments: [{ status: 'existing', reason: 'partial_document' }] });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('files UTF-8 text locally and records non-paperwork as an explicit skip', async () => {
    const response = await deliver([new File([RECEIPT], 'receipt.txt', { type: 'text/plain' }), new File(['Hello friend'], 'note.txt', { type: 'text/plain' })]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ attachments: [{ status: 'filed' }, { status: 'skipped', reason: 'unclassified' }] });
    expect(db.table('paperwork_items')[0]).toMatchObject({ meta: { extraction: { method: 'plain_text' } } });
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe('attachment identity and enrichment retries', () => {
  it('matches confirmed household entities on the actual saved attachment', async () => {
    db.seed('graph_entities', [{
      id: 'school-1', family_id: FAMILY, name: 'Lakeside School', kind: 'org', ref_table: null, ref_id: null,
      attributes: { provenance: { source: 'manual' }, node_type: 'school', senders: ['office@example.com'] },
      'attributes->provenance->>source': 'manual',
    }]);
    expect((await deliver([pdf()])).status).toBe(200);
    expect(db.table('paperwork_items')[0]).toMatchObject({ meta: {
      source: 'inbound_email_attachment', filename: 'receipt.pdf',
      entity_matches: [{ key: 'graph_entities:school-1', id: 'school-1', label: 'Lakeside School', kind: 'school', matchedBy: 'sender' }],
      entity_resolution: { status: 'complete', ambiguousCount: 0 },
    } });
  });

  it('retries a real graph-read failure after capture without OCR or an overwrite on redelivery', async () => {
    failNext('graph_entities', 'select');
    const first = await deliver([pdf()]);
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ attachments: [{ status: 'retry' }] });
    expect(db.table('paperwork_items')).toHaveLength(1);
    const saved = db.table('paperwork_items')[0];
    Object.assign(saved, { title: 'Corrected receipt', status: 'done', raw_text: 'Corrected receipt text' });
    (saved.meta as Record<string, unknown>).draft_reply = 'Keep my edit';
    const retry = await deliver([pdf()]);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ attachments: [{ status: 'existing', paperworkId: saved.id }] });
    expect(db.table('paperwork_items')).toHaveLength(1);
    expect(db.table('paperwork_items')[0]).toMatchObject({ title: 'Corrected receipt', status: 'done', raw_text: 'Corrected receipt text', meta: { draft_reply: 'Keep my edit', entity_resolution: { status: 'complete' } } });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('refuses a missing or foreign source message before extraction or filing', async () => {
    for (const inboxMessageId of [null, 'missing', 'foreign']) {
      db.seed('family_inbox_messages', [{ id: 'foreign', family_id: 'other-family' }]);
      expect(await fileEmailAttachments(db, source([pdf()], { inboxMessageId }))).toMatchObject({ ok: false, results: [{ status: 'retry', reason: 'source_unavailable' }] });
    }
    expect(transcribe).not.toHaveBeenCalled();
    expect(db.table('paperwork_items')).toHaveLength(0);
  });

  it('fails closed when the source read is unavailable', async () => {
    failNext('family_inbox_messages', 'select');
    expect(await fileEmailAttachments(db, source([pdf()]))).toMatchObject({ ok: false, results: [{ status: 'retry' }] });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('refuses source metadata from another delivery or channel', async () => {
    const input = source([pdf()]);
    expect(await fileEmailAttachments(db, { ...input, providerRef: 'email-2' })).toMatchObject({ ok: false });
    db.table('family_inbox_messages')[0].channel = 'sms';
    expect(await fileEmailAttachments(db, input)).toMatchObject({ ok: false });
    expect(transcribe).not.toHaveBeenCalled();
    expect(db.table('paperwork_items')).toHaveLength(0);
  });

  it('handles concurrent delivery with one insert and a verified existing record', async () => {
    const input = source([pdf()]);
    const results = await Promise.all([fileEmailAttachments(db, input), fileEmailAttachments(db, input)]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => result.results[0].status).sort()).toEqual(['existing', 'filed']);
    expect(db.table('paperwork_items')).toHaveLength(1);
  });

  it('retains original capture after failed enrichment and retries only metadata using the existing row', async () => {
    const enrich = vi.fn().mockResolvedValueOnce({ ok: false, error: 'Resolver unavailable', retryable: true }).mockResolvedValue({ ok: true, data: {} });
    const input = source([pdf()]);
    expect(await fileEmailAttachments(db, input, { enrich })).toMatchObject({ ok: false, results: [{ status: 'retry' }] });
    expect(db.table('paperwork_items')).toHaveLength(1);
    Object.assign(db.table('paperwork_items')[0], { raw_text: 'Household correction', title: 'Edited title' });
    expect(await fileEmailAttachments(db, input, { enrich })).toMatchObject({ ok: true, results: [{ status: 'existing' }] });
    expect(db.table('paperwork_items')[0]).toMatchObject({ raw_text: 'Household correction', title: 'Edited title' });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(enrich).toHaveBeenCalledTimes(2);
    expect(enrich.mock.calls[0][1]).toBe(db.table('paperwork_items')[0].id);
    expect(enrich.mock.calls[1][1]).toBe(db.table('paperwork_items')[0].id);
  });

  it('refuses an existing record with conflicting provenance without overwriting it', async () => {
    const file = pdf();
    const sha = createHash('sha256').update(new Uint8Array(await file.arrayBuffer())).digest('hex');
    db.seed('paperwork_items', [{ id: emailAttachmentId(FAMILY, 'email-1', sha), family_id: FAMILY, title: 'Existing record', meta: {} }]);
    expect(await fileEmailAttachments(db, source([file]))).toMatchObject({ ok: false, results: [{ status: 'retry' }] });
    expect(db.table('paperwork_items')[0].title).toBe('Existing record');
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('scopes deterministic identity by family and provider delivery', () => {
    const id = emailAttachmentId(FAMILY, 'email-1', 'bytes-hash');
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(emailAttachmentId(FAMILY, 'email-1', 'bytes-hash')).toBe(id);
    expect(emailAttachmentId('other-family', 'email-1', 'bytes-hash')).not.toBe(id);
    expect(emailAttachmentId(FAMILY, 'email-2', 'bytes-hash')).not.toBe(id);
  });
});
