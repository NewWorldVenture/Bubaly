import 'server-only';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { extractDocumentText, MAX_DOCUMENT_BYTES } from '@/lib/ai/document-text';
import { resolveProviderForTask } from '@/lib/ai/routing';
import { sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import { paperworkKindFields, triagePaperwork } from '@/lib/paperwork/triage';
import { scopeForSystem } from '@/lib/services/scope';
import type { ServiceResult, ServiceScope } from '@/lib/services/types';
import { enrichPaperworkEntities } from '@/lib/services/paperwork';
import { isPaperworkExtractionPartial } from '@/lib/paperwork/extraction';

type DB = SupabaseClient<Database>;
export const MAX_EMAIL_ATTACHMENTS = 4;
export const MAX_EMAIL_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_MULTIPART_EMAIL_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_DEADLINE_MS = 55_000;

export type EmailAttachmentResult = {
  filename: string;
  status: 'filed' | 'existing' | 'skipped' | 'retry';
  reason?: string;
  paperworkId?: string;
};
type Input = {
  familyId: string; inboxMessageId: string | null; providerRef: string;
  sender: string | null; subject: string | null; files: File[];
};
type Options = {
  extract?: typeof extractDocumentText;
  now?: Date;
  /** Test seam; production enrichment also runs on a saved-row retry. */
  enrich?: (scope: ServiceScope, itemId: string) => Promise<ServiceResult<unknown>>;
};

export function emailAttachmentId(familyId: string, providerRef: string, sha256: string): string {
  const digest = createHash('sha256').update(JSON.stringify(['inbound_email_attachment', familyId, providerRef, sha256])).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${((parseInt(digest[16], 16) & 3) | 8).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Save each recognized attachment independently. Existing rows are never overwritten. */
export async function fileEmailAttachments(db: DB, input: Input, options: Options = {}): Promise<{ ok: boolean; results: EmailAttachmentResult[] }> {
  if (!input.files.length) return { ok: true, results: [] };
  const filenames = input.files.map((file) => sanitizeUntrusted(file.name, 255) || 'attachment');
  try {
    if (!input.inboxMessageId) throw new Error('Source message was not recorded');
    const source = await db.from('family_inbox_messages').select('id, channel, provider_ref')
      .eq('id', input.inboxMessageId).eq('family_id', input.familyId).maybeSingle();
    if (source.error || !source.data) throw source.error ?? new Error('Source message is not in this family');
    if (source.data.channel !== 'email' || source.data.provider_ref !== input.providerRef) throw new Error('Source message does not match this email delivery');
  } catch (error) {
    console.error('[email-attachments] source message read failed', error);
    return { ok: false, results: filenames.map((filename) => ({ filename, status: 'retry', reason: 'source_unavailable' })) };
  }

  const scope = scopeForSystem(db, { id: input.familyId });
  const deadline = AbortSignal.timeout(ATTACHMENT_DEADLINE_MS);
  let provider: ReturnType<typeof resolveProviderForTask> | undefined;
  const engine = (signal?: AbortSignal) => provider ??= resolveProviderForTask('vision', { db, failClosed: true, signal });
  const extract = options.extract ?? extractDocumentText;
  const enrich = options.enrich ?? enrichPaperworkEntities;
  let totalBytes = 0;
  const results: EmailAttachmentResult[] = [];
  for (let index = 0; index < input.files.length; index++) {
    const file = input.files[index];
    const filename = filenames[index];
    if (index >= MAX_EMAIL_ATTACHMENTS) {
      results.push({ filename, status: 'skipped', reason: 'attachment_limit' });
      continue;
    }
    if (file.size > MAX_DOCUMENT_BYTES || totalBytes + file.size > MAX_EMAIL_ATTACHMENT_BYTES) {
      results.push({ filename, status: 'skipped', reason: 'too_large' });
      continue;
    }
    totalBytes += file.size;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const id = emailAttachmentId(input.familyId, input.providerRef, sha256);
      const readExisting = async () => {
        const saved = await db.from('paperwork_items').select('id, meta')
          .eq('id', id).eq('family_id', input.familyId).maybeSingle();
        if (saved.error) {
          console.error('[email-attachments] saved attachment read failed', saved.error);
          throw new Error('Attachment receipt unavailable');
        }
        if (saved.data) {
          const meta = saved.data.meta as Record<string, unknown> | null;
          if (meta?.attachment_sha256 !== sha256 || meta?.provider_ref !== input.providerRef) throw new Error('Attachment identity conflicts with an existing record');
        }
        return saved.data;
      };
      const finish = async (status: 'filed' | 'existing', partial: boolean) => {
        const enriched = await enrich(scope, id);
        if (!enriched.ok) throw new Error('Attachment enrichment unavailable');
        results.push({ filename, status, paperworkId: id, ...(partial ? { reason: 'partial_document' } : {}) });
      };
      const existing = await readExisting();
      if (existing) {
        await finish('existing', isPaperworkExtractionPartial(existing.meta));
        continue;
      }
      if (deadline.aborted) throw new Error('Attachment processing deadline reached');
      const extracted = await extract({ name: filename, mediaType: file.type.toLowerCase(), bytes }, engine, deadline);
      if (!extracted.ok) {
        results.push({ filename, status: extracted.retryable ? 'retry' : 'skipped', reason: extracted.reason });
        continue;
      }
      if (!extracted.text.trim() && !extracted.truncated) {
        results.push({ filename, status: 'skipped', reason: 'empty_document' });
        continue;
      }
      const rawText = extracted.text.replace(/\u0000/g, '');
      const triage = triagePaperwork(rawText, options.now ?? new Date());
      if (triage.kind === 'other' && !extracted.truncated) {
        results.push({ filename, status: 'skipped', reason: 'unclassified' });
        continue;
      }
      const fields = paperworkKindFields(triage.kind);
      const inserted = await db.from('paperwork_items').insert({
        id, family_id: input.familyId, kind: fields.kind, title: triage.title, summary: triage.summary,
        raw_text: rawText, sender: input.sender, due_on: triage.due_on, amount: triage.amount,
        urgency: triage.urgency, status: 'needs_action', actions: triage.actions as unknown as Json,
        meta: {
          ...fields.meta, source: 'inbound_email_attachment', provider_ref: input.providerRef,
          inbox_message_id: input.inboxMessageId, sender: input.sender, subject: input.subject,
          filename, media_type: file.type.toLowerCase(), byte_size: bytes.byteLength, attachment_sha256: sha256,
          extraction: { method: extracted.method, truncated: extracted.truncated },
        },
      }).select('id').maybeSingle();
      if (inserted.error?.code === '23505') {
        const concurrent = await readExisting();
        if (!concurrent) throw new Error('Concurrent attachment save was not confirmed');
        await finish('existing', isPaperworkExtractionPartial(concurrent.meta));
      } else {
        if (inserted.error || !inserted.data) {
          console.error('[email-attachments] paperwork insert failed', inserted.error);
          throw new Error('Attachment save failed');
        }
        await finish('filed', extracted.truncated);
      }
    } catch (error) {
      console.error('[email-attachments] attachment processing failed', error instanceof Error ? error.message : 'processing_error');
      results.push({ filename, status: 'retry', reason: 'processing_unavailable' });
    }
  }
  return { ok: results.every((result) => result.status !== 'retry'), results };
}
