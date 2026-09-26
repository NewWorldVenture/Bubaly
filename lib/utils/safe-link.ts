// A stored, user-typed link becomes an <a href> only if it is a web URL.
//
// React 18 WARNS about a `javascript:` href and renders it anyway, and
// `<input type="url">` accepts one — `javascript:alert(1)` is a perfectly valid
// absolute URL — so neither the form nor the framework stands between a link one
// family member saves and a script that runs in another member's session when
// they click it. A row written straight through the API skips the form entirely.
//
// The rule is the one SEC-004 settled for social links (lib/social/links.ts,
// which now delegates here): http(s) only, no embedded credentials, no
// whitespace, at most 4096 characters. Anything else is not a link — callers
// render the text without an anchor rather than guessing at a repair.
export function safeWebLink(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 4096 || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
