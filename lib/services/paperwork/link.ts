import 'server-only';
import { createHash } from 'node:crypto';
import type { Json } from '@/lib/database.types';
import { canonicalDocumentUrl, documentLinkCandidates, type DocumentLinkInput, type DocumentLinkResult } from '@/lib/capture/document-link';
import { extractDocumentText } from '@/lib/ai/document-text';
import { resolveProviderForTask } from '@/lib/ai/routing';
import { sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import { fetchPublicDocument, PublicDocumentError } from '@/lib/server/public-document-fetch';
import { paperworkKindFields, triagePaperwork } from '@/lib/paperwork/triage';
import { isPaperworkExtractionPartial } from '@/lib/paperwork/extraction';
import { enrichPaperworkEntities } from '@/lib/services/paperwork';
import type { ServiceScope } from '@/lib/services/types';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export async function linkedDocumentSource(scope: ServiceScope, messageId: string) {
  if (!UUID.test(messageId)) return { ok: false as const, retryable: false };
  try {
    // Caller-scoped RLS client only. The API/page additionally enforce the Inbox feature gate.
    const result = await scope.db.from('family_inbox_messages').select('id, family_id, channel, direction, body, subject, from_addr, provider_ref')
      .eq('id', messageId).eq('family_id', scope.familyId).eq('channel', 'email').eq('direction', 'inbound').maybeSingle();
    if (result.error) throw result.error;
    if (!result.data || result.data.id !== messageId || result.data.family_id !== scope.familyId || result.data.channel !== 'email' || result.data.direction !== 'inbound') return { ok: false as const, retryable: false };
    return { ok: true as const, data: { ...result.data, urls: documentLinkCandidates([result.data.subject, result.data.body].filter(Boolean).join('\n')) } };
  } catch {
    console.error('[document-link] source read failed');
    return { ok: false as const, retryable: true };
  }
}

export function linkedDocumentId(familyId: string, identity: string, url: string): string {
  const hash = createHash('sha256').update(JSON.stringify(['document_link', familyId, identity, url])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${((parseInt(hash[16], 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
type Options = { fetch?: typeof fetchPublicDocument; extract?: typeof extractDocumentText; enrich?: typeof enrichPaperworkEntities; signal?: AbortSignal;
  beforeWrite?: () => Promise<{ ok: true } | Extract<DocumentLinkResult, { ok: false }>> };

/** A selected link captures reviewable paperwork, never a plan or materialized action. */
export async function captureDocumentLink(scope: ServiceScope, input: DocumentLinkInput, options: Options = {}): Promise<DocumentLinkResult> {
  const originalUrl = canonicalDocumentUrl(input.url);
  if (!scope.familyId || !scope.userId || scope.actorKind !== 'member' || !UUID.test(input.captureId) || !originalUrl) return { ok: false, reason: 'invalid_url', retryable: false };
  let saved = false;
  try {
    const source = input.messageId !== undefined ? await linkedDocumentSource(scope, input.messageId) : null;
    if (source && (!source.ok || !source.data.urls.includes(originalUrl))) return { ok: false, reason: 'source_unavailable', retryable: !source.ok && source.retryable };
    const message = source?.ok ? source.data : null;
    const identity = message ? `inbox:${message.id}` : `capture:${scope.userId}:${input.captureId}`;
    const id = linkedDocumentId(scope.familyId, identity, originalUrl);
    const readSaved = async () => {
      const result = await scope.db.from('paperwork_items').select('id, created_by, meta').eq('id', id).eq('family_id', scope.familyId).maybeSingle();
      if (result.error) throw result.error;
      if (result.data) {
        const meta = result.data.meta as Record<string, unknown> | null;
        if (meta?.source !== 'document_link' || meta.link_identity !== identity || meta.original_url !== originalUrl
          || typeof meta.content_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(meta.content_sha256)
          || (!message && result.data.created_by !== scope.userId)) throw new Error('Link receipt mismatch');
      }
      return result.data;
    };
    const finish = async (partial: boolean): Promise<DocumentLinkResult> => {
      saved = true;
      const access = await options.beforeWrite?.();
      if (access && !access.ok) return { ...access, saved };
      const enriched = await (options.enrich ?? enrichPaperworkEntities)(scope, id);
      if (!enriched.ok) throw new Error('Link enrichment unavailable');
      return { ok: true, data: { id, partial } };
    };
    const existing = await readSaved();
    if (existing) return await finish(isPaperworkExtractionPartial(existing.meta));
    options.signal?.throwIfAborted();
    const document = await (options.fetch ?? fetchPublicDocument)(originalUrl, { signal: options.signal });
    if (document.mediaType === 'text/plain' && document.bytes.length === 0) return { ok: false, reason: 'empty_document', retryable: false };
    const extracted = await (options.extract ?? extractDocumentText)(document,
      (signal) => resolveProviderForTask('vision', { db: scope.db, failClosed: true, signal }), options.signal);
    if (!extracted.ok) return { ok: false, reason: extracted.reason === 'invalid_file' ? 'unsupported' : extracted.reason, retryable: extracted.retryable };
    const text = extracted.text.replace(/\u0000/g, '');
    if (!text.trim() && !extracted.truncated) return { ok: false, reason: 'empty_document', retryable: false };
    const access = await options.beforeWrite?.();
    if (access && !access.ok) return access;
    const triage = triagePaperwork(text, scope.now ?? new Date());
    const fields = paperworkKindFields(triage.kind);
    const inserted = await scope.db.from('paperwork_items').insert({
      id, family_id: scope.familyId, created_by: scope.userId, kind: fields.kind, title: triage.title,
      summary: triage.summary, raw_text: text, sender: message ? sanitizeUntrusted(message.from_addr ?? '', 200) || null : null,
      due_on: triage.due_on, amount: triage.amount, urgency: triage.urgency, status: 'needs_action', actions: triage.actions as unknown as Json,
      meta: { ...fields.meta, source: 'document_link', link_identity: identity, original_url: originalUrl, final_url: document.url,
        source_message_id: message?.id ?? null, provider_ref: message?.provider_ref ?? null,
        fetched_at: (scope.now ?? new Date()).toISOString(), filename: sanitizeUntrusted(document.name, 255),
        media_type: document.mediaType, byte_size: document.bytes.length, content_sha256: createHash('sha256').update(document.bytes).digest('hex'),
        extraction: { method: extracted.method, truncated: extracted.truncated } },
    }).select('id').maybeSingle();
    if (inserted.error?.code === '23505') {
      // First saved snapshot wins, even if the remote file changed during the race.
      const concurrent = await readSaved();
      if (!concurrent) throw new Error('Concurrent link capture unavailable');
      return await finish(isPaperworkExtractionPartial(concurrent.meta));
    }
    if (inserted.error || !inserted.data) throw inserted.error ?? new Error('Link was not saved');
    return await finish(extracted.truncated);
  } catch (error) {
    if (error instanceof PublicDocumentError) return { ok: false, reason: error.reason, retryable: error.retryable };
    // URLs can contain access tokens. Never log the URL, source body or provider response.
    console.error('[document-link] capture or receipt read failed');
    return { ok: false, reason: 'unavailable', retryable: true, saved };
  }
}
