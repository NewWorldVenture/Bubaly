import 'server-only';
import { createHash } from 'node:crypto';
import type { Json } from '@/lib/database.types';
import { resolveConciergeEntities } from '@/lib/contact-center/concierge';
import { fail, ok, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import type { InboundEntityMatch } from '@/lib/graph/resolve';

export type PaperworkEntityMetadata = {
  entity_matches: InboundEntityMatch[];
  entity_resolution: { status: 'complete'; ambiguousCount: number; inputHash: string };
};
const asObject = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const inputHash = (text: string, sender: string | null | undefined) => createHash('sha256').update(JSON.stringify([text, sender ?? null])).digest('hex');

export async function resolvePaperworkEntities(
  scope: ServiceScope, input: { text: string; sender?: string | null },
): Promise<ServiceResult<PaperworkEntityMetadata>> {
  const result = await resolveConciergeEntities(scope, input);
  if (!result.ok) return result;
  return ok({
    entity_matches: result.data.matches,
    entity_resolution: { status: 'complete', ambiguousCount: result.data.ambiguousCount, inputHash: inputHash(input.text, input.sender) },
  });
}

/** Capture first, enrich second. Redelivery reuses the current saved text and
 * merges only resolver-owned metadata; a concurrent user edit causes a retry. */
export async function enrichPaperworkEntities(scope: ServiceScope, itemId: string): Promise<ServiceResult<PaperworkEntityMetadata>> {
  try {
    const found = await scope.db.from('paperwork_items').select('id,raw_text,sender,meta,updated_at')
      .eq('id', itemId).eq('family_id', scope.familyId).maybeSingle();
    if (found.error || !found.data) throw found.error ?? new Error('Paperwork was unavailable');
    const row = found.data;
    const meta = asObject(row.meta);
    const existing = asObject(meta.entity_resolution);
    const text = row.raw_text ?? '';
    if (existing.status === 'complete' && existing.inputHash === inputHash(text, row.sender) && Array.isArray(meta.entity_matches)) {
      return ok({ entity_matches: meta.entity_matches as InboundEntityMatch[], entity_resolution: existing as PaperworkEntityMetadata['entity_resolution'] });
    }
    const resolved = await resolvePaperworkEntities(scope, { text, sender: row.sender });
    if (!resolved.ok) return resolved;
    // 0169 supplies updated_at and advances it on every change, including an
    // edited draft reply in meta. Never replace metadata read before that edit.
    if (!row.updated_at) throw new Error('Paperwork version was unavailable');
    const saved = await scope.db.from('paperwork_items').update({ meta: { ...meta, ...resolved.data } as Json })
      .eq('id', itemId).eq('family_id', scope.familyId).eq('updated_at', row.updated_at).select('id').maybeSingle();
    if (saved.error || !saved.data) throw saved.error ?? new Error('Paperwork changed while matching');
    return resolved;
  } catch (error) {
    console.error('[inbound-entities] paperwork enrichment failed', error);
    return fail('Could not match the saved paperwork. Retry.', { retryable: true });
  }
}

/** Webhooks translate this into a retryable response after preserving capture. */
export class PaperworkEnrichmentError extends Error {
  readonly retryable = true;
}
