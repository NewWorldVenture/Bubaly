export type BoundedResponseTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large' | 'unreadable' };

/** Read an external response without buffering beyond the caller's byte limit. */
export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<BoundedResponseTextResult> {
  const declared = Number(response.headers?.get?.('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: 'too_large' };
  }

  if (!response.body) {
    try {
      const text = await response.text();
      const bytes = new TextEncoder().encode(text);
      return bytes.byteLength <= maxBytes
        ? { ok: true, text }
        : { ok: false, reason: 'too_large' };
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* the response is already over budget */ }
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}
