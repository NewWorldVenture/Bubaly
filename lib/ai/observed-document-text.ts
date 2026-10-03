// Paperwork transcription, recorded (§33, F19).
//
// Filing a document — an upload, a pasted link, an emailed attachment — reads
// it with a vision model: `extractDocumentText` sends the image or PDF to a
// multimodal `structuredCompletion` of up to 8,192 tokens. None of the three
// paths opened an `ai_requests` row, so those paid calls were neither recorded
// nor visible to the allowance, and the §33 coverage scanner could not see
// them either: it read only `@/lib/ai/provider`, and these obtained their model
// through `resolveProviderForTask`.
//
// Each transcription that actually reaches a model now opens its own row,
// named by surface. A plain-text, empty, oversized or unsupported file never
// reaches one (`extractDocumentText` answers those itself), so it opens none.
//
// Recorded, not charged: whether filing a document counts against the Free
// plan's 10 requests is the owner's classification to make (as chore-proof
// validation was), so the row is filed `exemptFromAllowance` — `metered =
// false`, never refused. An emailed attachment runs on a system scope and is
// unmetered regardless.
import 'server-only';
import { documentType, extractDocumentText, MAX_DOCUMENT_BYTES, type DocumentInput, type DocumentTextResult } from '@/lib/ai/document-text';
import { withAiRequest } from '@/lib/ai/observability';
import type { AIProvider } from '@/lib/ai/provider';
import { resolveProviderForTask } from '@/lib/ai/routing';
import type { ServiceScope } from '@/lib/services/types';

export type TranscriptionSurface = 'upload' | 'link' | 'email';
type ProviderFactory = (signal?: AbortSignal) => Promise<AIProvider>;

/**
 * The vision provider paperwork reads documents with, resolved on first use
 * and then reused, so a run of attachments reads the model settings once and a
 * file that never reaches a model never reads them at all.
 */
export function visionProvider(db: ServiceScope['db']): ProviderFactory {
  let provider: Promise<AIProvider> | undefined;
  return (signal) => provider ??= resolveProviderForTask('vision', { db, failClosed: true, signal });
}

/** Whether `extractDocumentText` would hand this file to a model (it answers every other case itself). */
function reachesAModel(input: DocumentInput): boolean {
  const type = documentType(input);
  return input.bytes.byteLength <= MAX_DOCUMENT_BYTES && input.bytes.length > 0 && type !== null && type !== 'text/plain';
}

export async function transcribeDocument(
  scope: ServiceScope,
  surface: TranscriptionSurface,
  input: DocumentInput,
  opts: { extract?: typeof extractDocumentText; provider?: ProviderFactory; signal?: AbortSignal } = {},
): Promise<DocumentTextResult> {
  const extract = opts.extract ?? extractDocumentText;
  const provider = opts.provider ?? visionProvider(scope.db);
  if (!reachesAModel(input)) return extract(input, provider, opts.signal);
  return withAiRequest(scope, { feature: `paperwork.transcribe.${surface}`, text: 'Transcribe a document', exemptFromAllowance: true }, async (obs) => {
    let answeredBy: string | null = null;
    const result = await extract(input, async (signal) => {
      const engine = await provider(signal);
      answeredBy = engine.model;
      return engine;
    }, opts.signal);
    if (answeredBy) obs.used(answeredBy);
    // `extractDocumentText` never throws: it answers a failure, so the row has
    // to be told, or it would settle `completed` for a file nobody could read.
    if (!result.ok) obs.failed(new Error(`Document transcription failed: ${result.reason}`));
    return result;
  });
}
