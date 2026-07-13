/** Read a request body without buffering beyond the caller's explicit bound. */
export type BoundedBodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large' | 'unreadable' };

export type BoundedBytesResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'too_large' | 'unreadable' };

export type BoundedFormDataResult =
  | { ok: true; value: FormData }
  | { ok: false; reason: 'too_large' | 'unreadable' | 'invalid_form' };

export type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'too_large' | 'unreadable' | 'invalid_json' };

export type BoundedJsonOrEmptyResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'too_large' | 'unreadable' };

export const MAX_PROVIDER_JSON_BYTES = 256 * 1024;
export const MAX_SMALL_JSON_BYTES = 16 * 1024;
export const MAX_FLYER_JSON_BYTES = 8 * 1024 * 1024;

/** Read optional JSON bodies while preserving the existing empty-body behavior. */
export async function readBoundedRequestJsonOrEmpty(req: Request, maxBytes: number): Promise<BoundedJsonOrEmptyResult> {
  const raw = await readBoundedRequestText(req, maxBytes);
  if (!raw.ok) return raw;
  if (!raw.text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.text) };
  } catch {
    return { ok: true, value: {} };
  }
}

export async function readBoundedRequestText(req: Request, maxBytes: number): Promise<BoundedBodyResult> {
  const raw = await readBoundedRequestBytes(req, maxBytes);
  if (!raw.ok) return raw;
  return { ok: true, text: new TextDecoder().decode(raw.bytes) };
}

/** Read a request body as bytes while enforcing the caller's explicit bound. */
export async function readBoundedRequestBytes(req: Request, maxBytes: number): Promise<BoundedBytesResult> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: 'too_large' };
  }

  if (!req.body) return { ok: true, bytes: new Uint8Array() };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* the body is already over budget */ }
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
  return { ok: true, bytes };
}

/** Bound a request before delegating parsing to the platform FormData parser. */
export async function readBoundedRequestFormData(req: Request, maxBytes: number): Promise<BoundedFormDataResult> {
  const raw = await readBoundedRequestBytes(req, maxBytes);
  if (!raw.ok) return raw;
  try {
    const headers = new Headers(req.headers);
    headers.delete('content-length');
    const body = new ArrayBuffer(raw.bytes.byteLength);
    new Uint8Array(body).set(raw.bytes);
    const boundedRequest = new Request(req.url, {
      method: req.method,
      headers,
      body,
    });
    return { ok: true, value: await boundedRequest.formData() };
  } catch {
    return { ok: false, reason: 'invalid_form' };
  }
}

/** Read and parse JSON without allowing the platform to buffer an unbounded body. */
export async function readBoundedRequestJson(req: Request, maxBytes: number): Promise<BoundedJsonResult> {
  const raw = await readBoundedRequestText(req, maxBytes);
  if (!raw.ok) return raw;
  try {
    return { ok: true, value: JSON.parse(raw.text) };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}
