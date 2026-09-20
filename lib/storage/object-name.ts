// One unguessable name for an object in a PUBLIC storage bucket.
//
// Four of this project's seven buckets are created with `public = true`:
// avatars, marketplace-photos, feedback-attachments and family-media. For those,
// RLS governs the Storage API but NOT public-URL delivery — anyone who can
// construct the URL can fetch the object, signed in or not. The only thing
// standing between a stored object and the internet is that its URL cannot be
// guessed, and the first path segment is never the secret part: a family id or
// user id appears in every public URL that is already shared.
//
// So the entropy has to be in the object NAME, and a clock is not entropy.
// `${Date.now()}.${ext}` is enumerable — a day is 86.4 million values, the
// extension set is tiny, and uploads made together land in adjacent
// milliseconds, so one leaked URL reveals both the scheme and roughly where to
// look. It also collides: two uploads inside one millisecond produce the same
// path, which either fails (`upsert: false`) or silently overwrites
// (`upsert: true`).
//
// randomUUID is 122 random bits. The fallback covers browsers that do not expose
// it — it is unavailable on insecure origins — and still mixes in randomness
// rather than leaning on the clock alone.
export function unguessableObjectName(fileName: string, fallbackExt = 'jpg'): string {
  // `'receipt'.split('.').pop()` is 'receipt', not '', so the usual
  // `|| 'jpg'` never fires and an extensionless upload becomes `<uuid>.receipt`.
  // The original call sites all had this. Require a real dot with something
  // after it, and keep the extension short enough to be an extension.
  const dot = fileName.lastIndexOf('.');
  const candidate = dot > 0 ? fileName.slice(dot + 1) : '';
  const ext = /^[A-Za-z0-9]{1,8}$/.test(candidate) ? candidate : fallbackExt;
  const unique = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `${unique}.${ext}`;
}
