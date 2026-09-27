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
    const normalized = `${candidate.pathname}${candidate.search}${candidate.hash}`;
    // Check the OUTPUT, not only the input. The checks above run on the raw
    // string, but what this returns is the parser's normalized path — and
    // dot-segment removal turns `/.//evil.com`, `/..//evil.com` and
    // `/%2e//evil.com` into the pathname `//evil.com`. The origin check passes
    // (it was parsed as a path on our base, not as a host), yet the returned
    // value is protocol-relative: a browser resolves it to https://evil.com.
    // login-form and phone-auth push this straight into the router after a
    // successful sign-in, so `/login?redirect=/.//evil.com` sent a genuinely
    // signed-in person to a page of the attacker's choosing.
    if (normalized.startsWith('//') || normalized.includes('\\')) return fallback;
    return normalized;
  } catch {
    return fallback;
  }
}
