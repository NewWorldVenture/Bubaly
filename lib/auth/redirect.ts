const REDIRECT_BASE = 'https://bubaly.invalid';

/**
 * True when a browser resolving `value` against this app's origin stays on it.
 *
 * Both the value handed in and the value handed back are judged by this, and
 * that is the whole point: SEC-014 existed because they were judged by
 * different code. `//host`, `/\host` and `%2f%2fhost` are rejected before any
 * URL parsing so that neither a browser's parser nor a server's can reinterpret
 * them as an authority.
 */
function isSameOriginPath(value: string): boolean {
  return value.startsWith('/')
    && !value.startsWith('//')
    && !value.includes('\\')
    && !/%(?:2f|5c)/i.test(value);
}

/**
 * Return a normalized same-origin application path, or the trusted fallback.
 *
 * The normalization is why the output is re-checked. `/..//evil.com` passes
 * every input test — it starts with a single slash, has no backslash and no
 * encoded separator — and `new URL()` resolves it to the pathname
 * `//evil.com`, because `..` cannot climb above the root and simply
 * disappears. The parsed URL's origin is still `bubaly.invalid`, so the origin
 * check passes too. Returning `pathname + search + hash` then hands the caller
 * a protocol-relative URL, and the browser that resolves it lands on
 * `https://evil.com/`.
 *
 * Measured, not reasoned: `?redirect=/..//evil.com` reached
 * `resolveAuthSelection` -> `login-form.tsx` -> `router.push('//evil.com')`
 * and left the origin after a successful sign-in. The raw value would have been
 * harmless; it was the sanitizer's own normalization that made it dangerous.
 */
export function safeInternalRedirect(
  value: string | null | undefined,
  fallback: string,
): string {
  if (!value || !isSameOriginPath(value)) return fallback;

  try {
    const candidate = new URL(value, REDIRECT_BASE);
    if (candidate.origin !== REDIRECT_BASE) return fallback;
    const path = `${candidate.pathname}${candidate.search}${candidate.hash}`;
    // The caller resolves THIS string, not the one above.
    if (!isSameOriginPath(path)) return fallback;
    return path;
  } catch {
    return fallback;
  }
}

/**
 * The same same-origin rule, for callers that keep the value the person gave
 * rather than a normalized one. Exported so no second copy of the rule can
 * drift away from this one — the two implementations of "is this path safe?"
 * disagreed on eight of eighteen attack strings before SEC-014.
 */
export { isSameOriginPath };
