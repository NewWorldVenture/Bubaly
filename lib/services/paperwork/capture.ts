import 'server-only';
import { createHash } from 'node:crypto';
import type { Json } from '@/lib/database.types';
import { extractDocumentText, MAX_DOCUMENT_BYTES } from '@/lib/ai/document-text';
import { resolveProviderForTask } from '@/lib/ai/routing';
import { sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import { paperworkKindFields, triagePaperwork } from '@/lib/paperwork/triage';
import { isPaperworkExtractionPartial } from '@/lib/paperwork/extraction';
import type { DocumentCaptureResult } from '@/lib/capture/document-upload';
import type { ServiceScope } from '@/lib/services/types';
import { enrichPaperworkEntities } from '@/lib/services/paperwork';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function capturedDocumentId(familyId: string, userId: string, captureId: string): string {
  const hash = createHash('sha256').update(JSON.stringify(['capture_upload', familyId, userId, captureId])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${((parseInt(hash[16], 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
type Options = { extract?: typeof extractDocumentText; enrich?: typeof enrichPaperworkEntities };

/** A manual capture files paperwork only. A saved extraction is the retry receipt. */
export async function captureDocument(scope: ServiceScope, input: { captureId: string; file?: File; sender?: string }, options: Options = {}): Promise<DocumentCaptureResult> {
  if (!scope.familyId || !scope.userId || scope.actorKind !== 'member' || !UUID.test(input.captureId)) {
    return { ok: false, reason: 'invalid_file', retryable: false };
  }
  if (input.file && input.file.size > MAX_DOCUMENT_BYTES) return { ok: false, reason: 'too_large', retryable: false };
  const id = capturedDocumentId(scope.familyId, scope.userId, input.captureId);
  let saved = false;
  try {
    const bytes = input.file ? new Uint8Array(await input.file.arrayBuffer()) : null;
    const sha256 = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
    const readSaved = async () => {
      const result = await scope.db.from('paperwork_items').select('id, created_by, meta')
        .eq('id', id).eq('family_id', scope.familyId).maybeSingle();
      if (result.error) throw result.error;
      if (result.data) {
        const meta = result.data.meta as Record<string, unknown> | null;
        if (result.data.created_by !== scope.userId || meta?.source !== 'capture_upload' || meta.capture_id !== input.captureId
          || typeof meta.capture_sha256 !== 'string' || (sha256 && meta.capture_sha256 !== sha256)) throw new Error('Capture receipt does not match');
      }
      return result.data;
    };
    const finish = async (partial: boolean): Promise<DocumentCaptureResult> => {
      saved = true;
      const enriched = await (options.enrich ?? enrichPaperworkEntities)(scope, id);
      if (!enriched.ok) throw new Error('Capture enrichment unavailable');
      return { ok: true, data: { id, partial } };
    };
    const existing = await readSaved();
    if (existing) return await finish(isPaperworkExtractionPartial(existing.meta));
    if (!input.file || !bytes) return { ok: false, reason: 'needs_file', retryable: false };
    const filename = sanitizeUntrusted(input.file.name, 255) || 'document';
    const extracted = await (options.extract ?? extractDocumentText)(
      { name: filename, mediaType: input.file.type.toLowerCase(), bytes },
      (signal) => resolveProviderForTask('vision', { db: scope.db, failClosed: true, signal }),
    );
    if (!extracted.ok) return { ok: false, reason: extracted.reason, retryable: extracted.retryable };
    const text = extracted.text.replace(/\u0000/g, '');
    if (!text.trim() && !extracted.truncated) return { ok: false, reason: 'empty_document', retryable: false };
    const triage = triagePaperwork(text, scope.now ?? new Date());
    const fields = paperworkKindFields(triage.kind);
    const inserted = await scope.db.from('paperwork_items').insert({
      id, family_id: scope.familyId, created_by: scope.userId,
      kind: fields.kind, title: triage.title, summary: triage.summary, raw_text: text,
      sender: sanitizeUntrusted(input.sender ?? '', 200) || null,
      due_on: triage.due_on, amount: triage.amount, urgency: triage.urgency, status: 'needs_action',
      actions: triage.actions as unknown as Json,
      meta: { ...fields.meta, source: 'capture_upload', capture_id: input.captureId, capture_sha256: sha256,
        filename, media_type: input.file.type.toLowerCase(), byte_size: bytes.byteLength,
        extraction: { method: extracted.method, truncated: extracted.truncated } },
    }).select('id').maybeSingle();
    if (inserted.error?.code === '23505') {
      const concurrent = await readSaved();
      if (!concurrent) throw new Error('Concurrent capture was not confirmed');
      return await finish(isPaperworkExtractionPartial(concurrent.meta));
    }
    if (inserted.error || !inserted.data) throw inserted.error ?? new Error('Capture was not saved');
    return await finish(extracted.truncated);
  } catch (error) {
    console.error('[paperwork-capture] capture or receipt read failed', { kind: error instanceof Error ? error.name : 'unavailable' });
    return { ok: false, reason: 'unavailable', retryable: true, saved };
  }
}
