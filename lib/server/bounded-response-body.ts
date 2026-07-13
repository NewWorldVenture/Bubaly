export type BoundedResponseTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large' | 'unreadable' };

/** Read and parse an external JSON response without buffering beyond the caller's byte limit. */
export async function readBoundedResponseJson<T>(response: Response, maxBytes: number): Promise<T> {
  const bounded = await readBoundedResponseText(response, maxBytes);
  if (!bounded.ok) {
    throw new Error(bounded.reason === 'too_large'
      ? `provider response exceeded ${maxBytes} bytes`
      : 'provider response could not be read');
  }
  try {
    return JSON.parse(bounded.text) as T;
  } catch {
    throw new Error('provider returned invalid JSON');
  }
}

/** Read an external response without buffering beyond the caller's byte limit. */
export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<BoundedResponseTextResult> {
  const declared = Number(response.headers?.get?.('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: 'too_large' };
  }

  if (!response.body) {
    try {
      const candidate = response as Response & {
        text?: () => Promise<string>;
        json?: () => Promise<unknown>;
      };
      const text = typeof candidate.text === 'function'
        ? await candidate.text()
        : JSON.stringify(await candidate.json?.());
      if (typeof text !== 'string') return { ok: false, reason: 'unreadable' };
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
