// What the PWA share target hands /capture, turned into one line of text.
//
// `app/manifest.ts` declares `share_target { action: '/capture', method: 'GET',
// params: { title, text, url } }`. A share sheet fills those three
// inconsistently — some apps put the link in `url`, some repeat it inside
// `text`, some send only a title — so this composes them in reading order,
// drops the duplicate a share sheet so often sends, and caps the result,
// because a shared article can be an entire page.
//
// Pure and separate from the page so it can be unit-tested and so the page file
// exports only what Next expects of a route.

/** A shared article body is unbounded; the capture box is not. */
export const MAX_SHARED_CAPTURE_CHARS = 2_000;

export type SharedCaptureParams = {
  title?: string | string[] | null;
  text?: string | string[] | null;
  url?: string | string[] | null;
};

/** A query param can arrive repeated; take the first value, as the browser would. */
function first(value: string | string[] | null | undefined): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0].trim() : '';
  return typeof value === 'string' ? value.trim() : '';
}

export function sharedCaptureText(params: SharedCaptureParams | null | undefined): string {
  const parts = [first(params?.title), first(params?.text), first(params?.url)].filter(Boolean);
  const seen = new Set<string>();
  const unique = parts.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  return unique.join('\n').slice(0, MAX_SHARED_CAPTURE_CHARS);
}
