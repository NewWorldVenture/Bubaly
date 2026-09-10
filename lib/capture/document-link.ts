export type DocumentLinkReason = 'invalid_url' | 'blocked' | 'unsupported' | 'too_large' | 'provider_unavailable' | 'empty_document' | 'unavailable' | 'context_changed' | 'step_up' | 'source_unavailable' | 'access_denied';
export type DocumentLinkResult =
  | { ok: true; data: { id: string; partial: boolean } }
  | { ok: false; reason: DocumentLinkReason; retryable: boolean; saved?: boolean; stepUp?: string };
export type DocumentLinkInput = { url: string; captureId: string; messageId?: string };

/** Identity normalization never removes or reorders a signed URL's query. */
export function canonicalDocumentUrl(raw: string): string | null {
  if (raw.length > 2_000 || /[\u0000-\u0020\u007f]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.')
      || url.hostname.endsWith('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(url.hostname)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

/** Bounded candidates only; finding a URL never authorizes visiting it. */
export function documentLinkCandidates(text: string): string[] {
  const matches = text.slice(0, 12_000).match(/https:\/\/[^\s<>"']+/gi) ?? [];
  const urls = matches.map((value) => canonicalDocumentUrl(value.replace(/&amp;/gi, '&'))).filter((value): value is string => !!value);
  return [...new Set(urls)].slice(0, 10);
}

export async function importDocumentLink(input: DocumentLinkInput & { familyId: string; userId: string }, signal?: AbortSignal, send: typeof fetch = fetch): Promise<DocumentLinkResult> {
  try {
    const response = await send('/api/paperwork/link', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, expectedFamilyId: input.familyId, expectedUserId: input.userId }) });
    const value = await response.json() as DocumentLinkResult;
    if (value?.ok === true && /^[a-f0-9-]{36}$/i.test(value.data?.id) && typeof value.data.partial === 'boolean') return value;
    if (value?.ok === false && typeof value.retryable === 'boolean') {
      if (value.reason === 'step_up') {
        if (typeof value.stepUp === 'string' && value.stepUp.startsWith('/auth/step-up?')) return value;
      } else if (['invalid_url', 'blocked', 'unsupported', 'too_large', 'provider_unavailable', 'empty_document', 'unavailable', 'context_changed', 'source_unavailable', 'access_denied'].includes(value.reason)) return value;
    }
  } catch { /* A failed/lost response is safe to retry using the same receipt. */ }
  return { ok: false, reason: 'unavailable', retryable: true };
}
