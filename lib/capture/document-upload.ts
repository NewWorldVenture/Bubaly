export const CAPTURE_DOCUMENT_BYTES = 4 * 1024 * 1024;
export type DocumentCaptureReason = 'needs_file' | 'unsupported' | 'invalid_file' | 'too_large' | 'provider_unavailable' | 'empty_document' | 'unavailable' | 'context_changed' | 'step_up';
export type DocumentCaptureResult =
  | { ok: true; data: { id: string; partial: boolean } }
  | { ok: false; reason: DocumentCaptureReason; retryable: boolean; saved?: boolean; stepUp?: string };

function readResult(value: unknown): DocumentCaptureResult {
  if (!value || typeof value !== 'object') throw new Error('Capture response is unavailable');
  const result = value as DocumentCaptureResult;
  if (result.ok === true && typeof result.data?.id === 'string' && /^[a-f0-9-]{36}$/i.test(result.data.id) && typeof result.data.partial === 'boolean') return result;
  if (result.ok === false && result.reason === 'step_up' && typeof result.stepUp === 'string' && result.stepUp.startsWith('/auth/step-up?')) return result;
  if (result.ok === false && typeof result.retryable === 'boolean' && ['needs_file', 'unsupported', 'invalid_file', 'too_large', 'provider_unavailable', 'empty_document', 'unavailable', 'context_changed'].includes(result.reason)) return result;
  throw new Error('Capture response is incomplete');
}

/** Probe the durable receipt first, including after a response was lost. */
export async function uploadCapturedDocument(input: { captureId: string; file: File; sender: string; familyId: string; userId: string; isCurrent?: () => boolean }, send: typeof fetch = fetch): Promise<DocumentCaptureResult> {
  try {
    const context = { expectedFamilyId: input.familyId, expectedUserId: input.userId };
    const changed = (): DocumentCaptureResult => ({ ok: false, reason: 'context_changed', retryable: false });
    if (input.isCurrent && !input.isCurrent()) return changed();
    const probe = await send('/api/paperwork/capture', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ captureId: input.captureId, ...context }),
    });
    const result = readResult(await probe.json());
    if (input.isCurrent && !input.isCurrent()) return changed();
    if (probe.status !== 404 || result.ok || result.reason !== 'needs_file') return result;
    const body = new FormData();
    body.set('captureId', input.captureId); body.set('file', input.file); body.set('sender', input.sender);
    body.set('expectedFamilyId', input.familyId); body.set('expectedUserId', input.userId);
    const response = await send('/api/paperwork/capture', { method: 'POST', body });
    return readResult(await response.json());
  } catch {
    return { ok: false, reason: 'unavailable', retryable: true };
  }
}
