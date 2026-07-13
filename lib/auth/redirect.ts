const REDIRECT_BASE = 'https://bubaly.invalid';

/**
 * Return a normalized same-origin application path, or the trusted fallback.
 * Reject protocol-relative URLs and backslash variants before URL parsing so
 * browser and server URL implementations cannot reinterpret them as a host.
 */
export function safeInternalRedirect(
  value: string | null | undefined,
  fallback: string,
): string {
  if (
    !value
    || !value.startsWith('/')
    || value.startsWith('//')
    || value.includes('\\')
    || /%(?:2f|5c)/i.test(value)
  ) {
    return fallback;
  }

  try {
    const candidate = new URL(value, REDIRECT_BASE);
    if (candidate.origin !== REDIRECT_BASE) return fallback;
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return fallback;
  }
}
